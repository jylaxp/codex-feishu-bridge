import { readFile, realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import type { CardKitJson } from './layouts';
import { isPathWithinRoot } from '../preflight';

const LOCAL_IMAGE_PATTERN = /!\[([^\]]*)\]\(((?:\/|file:\/\/)[^)]+)\)/g;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

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

  public constructor(
    private readonly allowedWorkspaceRoots: readonly string[],
    private readonly api: LarkImageApi,
  ) {}

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
      const candidate = source.startsWith('file://') ? source.slice(7) : source;
      const imageKey = await this.upload(candidate);
      if (imageKey && match[0]) {
        rendered = rendered.replace(match[0], `![${match[1] ?? ''}](${imageKey})`);
      }
    }
    return rendered;
  }

  private async upload(candidate: string): Promise<string | null> {
    if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
      return null;
    }
    const cached = this.cache.get(candidate);
    if (cached) {
      return cached;
    }
    const upload = this.uploadOnce(candidate);
    this.cache.set(candidate, upload);
    return upload;
  }

  private async uploadOnce(candidate: string): Promise<string | null> {
    try {
      const path = await realpath(candidate);
      const roots = await Promise.all(this.allowedWorkspaceRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return root;
        }
      }));
      if (!roots.some((root) => isPathWithinRoot(path, root))) {
        return null;
      }
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
