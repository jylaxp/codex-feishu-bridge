import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 256 * 1024 * 1024;
const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 5_000;

export interface LarkMessageResourceApi {
  readonly im: {
    readonly messageResource: {
      get(request: {
        readonly params: { readonly type: 'image' };
        readonly path: {
          readonly message_id: string;
          readonly file_key: string;
        };
      }): Promise<{ readonly getReadableStream: () => Readable }>;
    };
  };
}

/** Downloads validated Feishu images into a private, process-owned temporary directory. */
export class InboundImageStore {
  private rootDirectory: string | undefined;
  private rootDirectoryPromise: Promise<string> | undefined;
  private readonly downloadLimiter: DownloadLimiter;
  private readonly activeDownloads = new Set<Promise<string>>();
  private readonly activeStreams = new Set<Readable>();
  private readonly retainedBytesByPath = new Map<string, number>();
  private bufferedBytes = 0;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly api: LarkMessageResourceApi,
    private readonly temporaryDirectory: string,
    private readonly maximumBytes: number = DEFAULT_MAX_IMAGE_BYTES,
    maximumConcurrentDownloads: number = DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    private readonly maximumTotalBytes: number = DEFAULT_MAX_TOTAL_IMAGE_BYTES,
    private readonly closeDrainTimeoutMs: number = DEFAULT_CLOSE_DRAIN_TIMEOUT_MS,
  ) {
    this.downloadLimiter = new DownloadLimiter(maximumConcurrentDownloads);
    if (!Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < maximumBytes) {
      throw new RangeError('Maximum total image bytes must cover at least one image');
    }
    if (!Number.isSafeInteger(closeDrainTimeoutMs) || closeDrainTimeoutMs < 1) {
      throw new RangeError('Image close drain timeout must be a positive safe integer');
    }
  }

  public download(messageId: string, imageKey: string): Promise<string> {
    if (this.closing) {
      return Promise.reject(new Error('Inbound image store is closing'));
    }
    const operation = this.downloadLimiter.run(() => this.downloadUnrestricted(messageId, imageKey));
    this.activeDownloads.add(operation);
    void operation.finally(() => this.activeDownloads.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async downloadUnrestricted(messageId: string, imageKey: string): Promise<string> {
    this.assertOpen();
    const response = await this.api.im.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: imageKey },
    });
    this.assertOpen();
    const stream = response.getReadableStream();
    this.activeStreams.add(stream);
    let reservedBytes = 0;
    let temporaryPath: string | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const rootDirectory = await this.ensureRootDirectory();
      this.assertOpen();
      const basename = randomUUID();
      temporaryPath = join(rootDirectory, `${basename}.download`);
      file = await open(temporaryPath, 'wx', 0o600);
      const prefixChunks: Buffer[] = [];
      let prefixBytes = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (reservedBytes + bytes.length > this.maximumBytes) {
          stream.destroy();
          throw new Error(`Feishu image exceeds the ${this.maximumBytes}-byte limit`);
        }
        try {
          this.reserveBytes(bytes.length);
        } catch (error) {
          stream.destroy();
          throw error;
        }
        reservedBytes += bytes.length;
        if (prefixBytes < 12) {
          const prefix = bytes.subarray(0, 12 - prefixBytes);
          prefixChunks.push(prefix);
          prefixBytes += prefix.length;
        }
        await file.write(bytes);
      }
      await file.close();
      file = undefined;
      const extension = imageExtension(Buffer.concat(prefixChunks, prefixBytes));
      if (!extension) {
        throw new Error('Feishu image format is unsupported');
      }
      this.assertOpen();
      const path = join(rootDirectory, `${randomUUID()}.${extension}`);
      await rename(temporaryPath, path);
      temporaryPath = undefined;
      this.retainedBytesByPath.set(path, reservedBytes);
      reservedBytes = 0;
      return path;
    } finally {
      this.activeStreams.delete(stream);
      await file?.close().catch(() => undefined);
      if (temporaryPath) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      if (reservedBytes > 0) {
        this.releaseBytes(reservedBytes);
      }
    }
  }

  public async release(paths: readonly string[]): Promise<void> {
    const rootDirectory = this.rootDirectory;
    if (!rootDirectory) {
      return;
    }
    const ownedPaths = paths.filter((path) => path.startsWith(`${rootDirectory}/`));
    for (const path of ownedPaths) {
      const retainedBytes = this.retainedBytesByPath.get(path);
      if (retainedBytes !== undefined) {
        this.retainedBytesByPath.delete(path);
        this.releaseBytes(retainedBytes);
      }
    }
    await Promise.all(ownedPaths.map((path) => rm(path, { force: true })));
  }

  public async close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.downloadLimiter.close();
      for (const stream of this.activeStreams) {
        stream.destroy();
      }
      this.closePromise = this.finishClose();
    }
    return this.closePromise;
  }

  private async ensureRootDirectory(): Promise<string> {
    if (!this.rootDirectoryPromise) {
      this.rootDirectoryPromise = this.createRootDirectory().catch((error: unknown) => {
        this.rootDirectoryPromise = undefined;
        throw error;
      });
    }
    return this.rootDirectoryPromise;
  }

  private async createRootDirectory(): Promise<string> {
    const rootDirectory = await mkdtemp(join(this.temporaryDirectory, 'codex-feishu-images-'));
    await chmod(rootDirectory, 0o700);
    this.rootDirectory = rootDirectory;
    return rootDirectory;
  }

  private async finishClose(): Promise<void> {
    await settleWithin([...this.activeDownloads], this.closeDrainTimeoutMs);
    const rootDirectory = this.rootDirectory ?? await this.rootDirectoryPromise;
    this.rootDirectory = undefined;
    this.rootDirectoryPromise = undefined;
    this.retainedBytesByPath.clear();
    this.bufferedBytes = 0;
    if (rootDirectory) {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new Error('Inbound image store is closing');
    }
  }

  private reserveBytes(bytes: number): void {
    if (this.bufferedBytes + bytes > this.maximumTotalBytes) {
      throw new Error(`Feishu images exceed the ${this.maximumTotalBytes}-byte bridge limit`);
    }
    this.bufferedBytes += bytes;
  }

  private releaseBytes(bytes: number): void {
    this.bufferedBytes = Math.max(0, this.bufferedBytes - bytes);
  }
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Limits concurrent Feishu resource streams for one bridge process. */
class DownloadLimiter {
  private active = 0;
  private readonly waiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private closing = false;

  public constructor(private readonly maximumConcurrent: number) {
    if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1) {
      throw new RangeError('Maximum concurrent image downloads must be a positive safe integer');
    }
  }

  public async run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('Inbound image store is closing'));
    }
    if (this.active < this.maximumConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private release(): void {
    this.active -= 1;
    const waiter = this.waiters.shift();
    if (waiter && !this.closing) {
      this.active += 1;
      waiter.resolve();
    }
  }

  public close(): void {
    this.closing = true;
    const error = new Error('Inbound image store is closing');
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

function imageExtension(bytes: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}
