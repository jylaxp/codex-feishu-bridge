import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CardImageRenderer } from '../../src/app/cards/card-image-renderer';

test('replaces local Markdown images with Lark image keys without rewriting other markdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'card-image-'));
  try {
    const imagePath = join(root, 'diagram.png');
    writeFileSync(imagePath, Buffer.from('png'));
    let uploads = 0;
    const renderer = new CardImageRenderer({
      im: { v1: { image: { create: async () => {
        uploads += 1;
        return { image_key: 'img_v3_key' };
      } } } },
    });

    const card = await renderer.render({
      schema: '2.0',
      body: {
        elements: [{
          tag: 'markdown',
          content: `**结果**\n![diagram](${imagePath})\n[普通链接](https://example.com)`,
        }],
      },
    });

    assert.match(JSON.stringify(card), /\*\*结果\*\*/);
    assert.match(JSON.stringify(card), /!\[diagram\]\(img_v3_key\)/);
    assert.match(JSON.stringify(card), /\[普通链接\]\(https:\/\/example.com\)/);
    assert.equal(uploads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uploads an absolute local image without a configured workspace allowlist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'card-image-any-workspace-'));
  try {
    const imagePath = join(root, 'outside.png');
    writeFileSync(imagePath, Buffer.from('png'));
    const renderer = new CardImageRenderer({
      im: { v1: { image: { create: async () => ({ image_key: 'img_anywhere' }) } } },
    });
    const card = await renderer.render({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: `![outside](${imagePath})` }] },
    });
    assert.match(JSON.stringify(card), /img_anywhere/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
