import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

import type { BridgeConfig } from '../domain';
import { isPathWithinRoot } from '../preflight';

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_COUNT = 10;
const MAX_MARKDOWN_FILE_REFERENCES = 100;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export interface FileUploadApi {
  readonly im: {
    readonly v1: {
      readonly file: {
        create(payload: { readonly data: {
          readonly file_type: 'stream'; readonly file_name: string; readonly file: Buffer;
        } }): Promise<{
          readonly code?: number;
          readonly file_key?: string;
          readonly data?: { readonly file_key?: string };
        } | null>;
      };
      readonly message: {
        reply(payload: { readonly path: { readonly message_id: string }; readonly data: {
          readonly msg_type: 'file'; readonly reply_in_thread: boolean; readonly content: string; readonly uuid: string;
        } }): Promise<{ readonly code?: number }>;
      };
    };
  };
}

/**
 * Retains the legacy opt-in output-file delivery without making any file or
 * prompt durable. Only regular files below an authorized workspace root are
 * eligible; image references are intentionally not file-pushed.
 */
export class OutputFileUploader {
  public constructor(
    private readonly config: BridgeConfig,
    private readonly api: FileUploadApi,
  ) {}

  public async uploadMarkdownFiles(answer: string, rootMessageId: string, taskId: string): Promise<void> {
    if (!this.config.enableAutoFileUpload) {
      return;
    }
    const references = markdownFileReferences(answer);
    const uploadedPaths = new Set<string>();
    let totalFileBytes = 0;
    let uploadedFileCount = 0;
    for (let index = 0; index < references.length; index += 1) {
      if (uploadedFileCount >= MAX_FILE_COUNT) {
        break;
      }
      const reference = references[index]!;
      try {
        const filePath = trustedFilePath(reference.path, this.config.allowedWorkspaceRoots);
        if (
          !filePath
          || uploadedPaths.has(filePath)
          || IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())
        ) {
          continue;
        }
        const stat = fileStat(filePath);
        const fileBytes = stat?.size;
        if (
          !stat
          || typeof fileBytes !== 'number'
          || !stat.isFile()
          || fileBytes > MAX_FILE_BYTES
          || totalFileBytes + fileBytes > MAX_TOTAL_FILE_BYTES
        ) {
          continue;
        }
        uploadedPaths.add(filePath);
        totalFileBytes += fileBytes;
        const upload = await this.api.im.v1.file.create({
          data: {
            file_type: 'stream',
            file_name: reference.name || basename(filePath),
            file: readFileSync(filePath),
          },
        });
        const fileKey = upload?.file_key ?? upload?.data?.file_key;
        if (!upload || (upload.code !== undefined && upload.code !== 0) || !fileKey) {
          continue;
        }
        const reply = await this.api.im.v1.message.reply({
          path: { message_id: rootMessageId },
          data: {
            msg_type: 'file',
            reply_in_thread: false,
            content: JSON.stringify({ file_key: fileKey }),
            uuid: `output-${taskId}-${index}`.slice(0, 64),
          },
        });
        if (reply.code !== undefined && reply.code !== 0) {
          continue;
        }
        uploadedFileCount += 1;
      } catch {
        // A stale file or one rejected upload must not suppress later output files.
        continue;
      }
    }
  }
}

function markdownFileReferences(markdown: string): readonly { readonly name: string; readonly path: string }[] {
  const references: Array<{ readonly name: string; readonly path: string }> = [];
  const expression = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(expression)) {
    const rawPath = match[2]?.trim() ?? '';
    const filePath = rawPath.startsWith('file://') ? decodeURIComponent(rawPath.slice(7)) : rawPath;
    if (filePath) {
      references.push({ name: match[1]?.trim() ?? '', path: filePath });
      if (references.length >= MAX_MARKDOWN_FILE_REFERENCES) {
        break;
      }
    }
  }
  return references;
}

function fileStat(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function trustedFilePath(value: string, roots: readonly string[]): string | null {
  if (!isAbsolute(value)) {
    return null;
  }
  try {
    const resolved = realpathSync.native(value);
    return roots.some((root) => {
      try {
        return isPathWithinRoot(resolved, realpathSync.native(root));
      } catch {
        return false;
      }
    }) ? resolved : null;
  } catch {
    return null;
  }
}
