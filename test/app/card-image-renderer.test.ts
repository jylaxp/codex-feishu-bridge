import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  CardImageRenderer,
  type LarkImageApi,
} from '../../src/app/cards/card-image-renderer';
import type { CardKitJson } from '../../src/app/cards/layouts';
import { resolveCodexVisualizationsRoot } from '../../src/app/main';

test('card image renderer uploads an encoded local file URL as a Feishu image', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-card-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'image with spaces.png');
  const image = Buffer.from('real-image-bytes');
  await writeFile(imagePath, image);
  const uploads: Buffer[] = [];
  const renderer = new CardImageRenderer(imageApi(uploads, 'img_v3_uploaded'), [directory]);
  const card = markdownCard(`![输入图片 1](${pathToFileURL(imagePath).href})`);

  const rendered = await renderer.render(card);

  assert.deepEqual(uploads, [image]);
  assert.match(JSON.stringify(rendered), /!\[输入图片 1\]\(img_v3_uploaded\)/);
  assert.doesNotMatch(JSON.stringify(rendered), /bridge-card-image|image%20with%20spaces/);
});

test('card image renderer uploads an explicitly approved structured image path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-card-approved-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'approved.png');
  await writeFile(imagePath, Buffer.from('approved-image'));
  const uploads: Buffer[] = [];
  const renderer = new CardImageRenderer(imageApi(uploads, 'img_v3_approved'));
  renderer.approve([imagePath]);

  const rendered = await renderer.render(markdownCard(`![输入图片](${imagePath})`));

  assert.equal(uploads.length, 1);
  assert.match(JSON.stringify(rendered), /img_v3_approved/);

  renderer.revoke([imagePath]);
  const hidden = await renderer.render(markdownCard(`![输入图片](${imagePath})`));
  assert.match(JSON.stringify(hidden), /暂时无法展示/);
});

test('revoking and re-approving an image invalidates its uploaded-image cache', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-card-reapproved-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'reapproved.png');
  await writeFile(imagePath, Buffer.from('first-image'));
  const uploads: Buffer[] = [];
  const renderer = new CardImageRenderer(imageApi(uploads, 'img_v3_reapproved'));
  renderer.approve([imagePath]);
  await renderer.render(markdownCard(`![输入图片](${imagePath})`));

  renderer.revoke([imagePath]);
  await writeFile(imagePath, Buffer.from('second-image'));
  renderer.approve([imagePath]);
  await renderer.render(markdownCard(`![输入图片](${imagePath})`));

  assert.deepEqual(uploads, [Buffer.from('first-image'), Buffer.from('second-image')]);
});

test('Codex visualization root respects the effective CODEX_HOME', () => {
  assert.equal(
    resolveCodexVisualizationsRoot({ CODEX_HOME: '/tmp/custom-codex-home' }),
    '/tmp/custom-codex-home/visualizations',
  );
  assert.equal(
    resolveCodexVisualizationsRoot({ HOME: '/tmp/custom-home' }),
    '/tmp/custom-home/.codex/visualizations',
  );
});

test('card image renderer refuses readable images outside approved roots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-card-blocked-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'secret.png');
  await writeFile(imagePath, Buffer.from('must-not-upload'));
  const uploads: Buffer[] = [];
  const renderer = new CardImageRenderer(imageApi(uploads, 'unused'));

  const rendered = await renderer.render(markdownCard(`![secret](${imagePath})`));

  assert.deepEqual(uploads, []);
  assert.match(JSON.stringify(rendered), /secret暂时无法展示/);
  assert.doesNotMatch(JSON.stringify(rendered), /bridge-card-blocked-image/);
});

test('card image renderer retries a transient Feishu upload failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-card-retry-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'retry.png');
  await writeFile(imagePath, Buffer.from('retry-image'));
  let attempts = 0;
  const renderer = new CardImageRenderer({
    im: {
      v1: {
        image: {
          create: async () => {
            attempts += 1;
            return attempts === 1 ? {} : { data: { image_key: 'img_v3_retry' } };
          },
        },
      },
    },
  }, [directory]);

  const first = await renderer.render(markdownCard(`![retry](${imagePath})`));
  const second = await renderer.render(markdownCard(`![retry](${imagePath})`));

  assert.match(JSON.stringify(first), /暂时无法展示/);
  assert.match(JSON.stringify(second), /img_v3_retry/);
  assert.equal(attempts, 2);
});

test('card image renderer hides a local path when the image cannot be uploaded', async () => {
  const localImageUrl = 'file:///private/tmp/private-codex-image.png';
  const renderer = new CardImageRenderer(imageApi([], 'unused'));

  const rendered = await renderer.render(markdownCard(`![输入图片 1](${localImageUrl})`));

  assert.match(JSON.stringify(rendered), /输入图片 1暂时无法展示/);
  assert.doesNotMatch(JSON.stringify(rendered), /private-codex-image|file:\/\//);
});

function markdownCard(content: string): CardKitJson {
  return {
    schema: '2.0',
    body: { elements: [{ tag: 'markdown', content }] },
  };
}

function imageApi(uploads: Buffer[], imageKey: string): LarkImageApi {
  return {
    im: {
      v1: {
        image: {
          create: async ({ data }) => {
            uploads.push(data.image);
            return { data: { image_key: imageKey } };
          },
        },
      },
    },
  };
}
