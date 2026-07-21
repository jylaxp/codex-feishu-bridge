import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CardKitJson } from './layouts';

const LOCAL_IMAGE_PATTERN = /!\[([^\]]*)\]\(((?:\/|file:\/\/)[^)]+)\)/g;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_APPROVED_PATHS = 4_096;

export interface LarkImageApi {
  readonly im: {
    readonly v1: {
      readonly image: {
        create(payload: {
          readonly data: { readonly image_type: 'message'; readonly image: Buffer };
        }): Promise<{ readonly image_key?: string; readonly data?: { readonly image_key?: string } }>;
      };
    };
  };
}

/** Reproduces the original card renderer's local Markdown image projection. */
export class CardImageRenderer {
  private readonly cache = new Map<string, Promise<string | null>>();
  private readonly approvedPaths = new Set<string>();
  private readonly allowedRoots: readonly string[];

  public constructor(
    private readonly api: LarkImageApi,
    allowedRoots: readonly string[] = [],
  ) {
    this.allowedRoots = Object.freeze(allowedRoots.map(canonicalPath));
  }

  /** Approves exact structured image inputs without granting access to their parent directory. */
  public approve(paths: readonly string[]): void {
    for (const path of paths) {
      const resolvedPath = canonicalPath(path);
      this.approvedPaths.delete(resolvedPath);
      this.approvedPaths.add(resolvedPath);
      while (this.approvedPaths.size > MAX_APPROVED_PATHS) {
        const oldest = this.approvedPaths.values().next().value as string | undefined;
        if (!oldest) {
          break;
        }
        this.approvedPaths.delete(oldest);
      }
    }
  }

  /** Removes exact approvals once the task-owned image files are released. */
  public revoke(paths: readonly string[]): void {
    for (const path of paths) {
      const resolvedPath = canonicalPath(path);
      this.approvedPaths.delete(resolvedPath);
      this.cache.delete(resolvedPath);
    }
  }

  public async render(card: CardKitJson): Promise<CardKitJson> {
    const clone = JSON.parse(JSON.stringify(card)) as unknown;
    await this.renderValue(clone);
    return clone as CardKitJson;
  }

  private async renderValue(value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      await Promise.all(value.map((item) => this.renderValue(item)));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if ((value.tag === 'markdown' || value.tag === 'lark_md') && typeof value.content === 'string') {
      value.content = await this.renderMarkdown(value.content);
    }
    await Promise.all(Object.values(value).map((item) => this.renderValue(item)));
  }

  private async renderMarkdown(markdown: string): Promise<string> {
    let rendered = markdown;
    const matches = [...markdown.matchAll(LOCAL_IMAGE_PATTERN)];
    for (const match of matches) {
      const source = match[2];
      if (!source) {
        continue;
      }
      const candidate = localImagePath(source);
      const imageKey = candidate ? await this.upload(candidate) : null;
      if (match[0]) {
        const alt = match[1]?.trim() || '图片';
        rendered = rendered.replace(
          match[0],
          imageKey ? `![${alt}](${imageKey})` : `⚠️ ${alt}暂时无法展示`,
        );
      }
    }
    return rendered;
  }

  private async upload(candidate: string): Promise<string | null> {
    if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
      return null;
    }
    let path: string;
    try {
      path = await realpath(candidate);
    } catch {
      return null;
    }
    if (!this.isAllowed(path)) {
      return null;
    }
    const cached = this.cache.get(path);
    if (cached) {
      return cached;
    }
    const upload = this.uploadOnce(path);
    this.cache.set(path, upload);
    void upload.then((imageKey) => {
      if (!imageKey && this.cache.get(path) === upload) {
        this.cache.delete(path);
      }
    });
    return upload;
  }

  private async uploadOnce(path: string): Promise<string | null> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_IMAGE_BYTES) {
        return null;
      }
      const response = await this.api.im.v1.image.create({
        data: { image_type: 'message', image: await readFile(path) },
      });
      return response.image_key ?? response.data?.image_key ?? null;
    } catch {
      return null;
    }
  }

  private isAllowed(path: string): boolean {
    const resolvedPath = resolve(path);
    return this.approvedPaths.has(resolvedPath)
      || this.allowedRoots.some((root) => (
        resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`)
      ));
  }
}

function localImagePath(source: string): string | null {
  if (!source.startsWith('file://')) {
    return source;
  }
  try {
    return fileURLToPath(source);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
