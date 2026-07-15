import * as assert from 'assert';
import {
  sanitizeCardMarkdown,
  sanitizeCardPlainText,
  sanitizeCardText,
} from '../../src/app/cards/sanitizer';

function run(): void {
  const privateKey = [
    '-----BEGIN PRIVATE KEY-----',
    'very-secret-key-material',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const input = [
    'Authorization: Bearer top-secret-token',
    'api_key=abcdefghijklmnop',
    'token: eyJabcdefgh.abcdefgh.abcdefgh',
    'LARK_APP_SECRET=feishu-production-secret',
    'AWS_SECRET_ACCESS_KEY=aws-production-secret',
    'postgres://db_user:database-password@db.example/app',
    'https://api-user:http-basic-token@example.test/private',
    'redis://:redis-password@cache.example:6379/0',
    privateKey,
    '\u001b[31mred\u001b[0m\u0000',
    '/Users/alice/private/project/config.json',
    '/workspace/another/private/file.txt',
    'cwd:/Users/alice/private/project/config.json',
    'path:/workspace/another/private/file.txt',
    'files:/private/a.txt,/private/b.txt',
    'quoted="/Users/alice/My Private Project/config.json"',
    'C:\\Users\\alice\\secret.txt',
    '请读取/Users/alice/.ssh/id_rsa',
    '【/private/var/customer.db】',
    '请读取C:\\Users\\alice\\unicode-secret.txt',
    'public-url=https://example.test/a/b?next=/public/path',
    '![secret](file:///etc/passwd)',
    '[download](/private/tmp/report.csv)',
    '<font color="red">forged</font>',
    '```dangerous fence```',
    '[click me](https://evil.example/phish)',
    '![tracking pixel](https://evil.example/pixel.png)',
    '# forged heading',
    '| status | approved |',
    '| --- | --- |',
    '---',
  ].join('\n');

  const sanitized = sanitizeCardText(input);
  assert.ok(!sanitized.includes('top-secret-token'));
  assert.ok(!sanitized.includes('abcdefghijklmnop'));
  assert.ok(!sanitized.includes('very-secret-key-material'));
  assert.ok(!sanitized.includes('feishu-production-secret'));
  assert.ok(!sanitized.includes('aws-production-secret'));
  assert.ok(!sanitized.includes('database-password'));
  assert.ok(!sanitized.includes('http-basic-token'));
  assert.ok(!sanitized.includes('redis-password'));
  assert.ok(!sanitized.includes('\u001b'));
  assert.ok(!sanitized.includes('\u0000'));
  assert.ok(!sanitized.includes('/Users/alice'));
  assert.ok(!sanitized.includes('/workspace/another'));
  assert.ok(!sanitized.includes('My Private Project'));
  assert.ok(!sanitized.includes('/private/a.txt'));
  assert.ok(!sanitized.includes('/private/b.txt'));
  assert.ok(!sanitized.includes('C:\\Users\\alice'));
  assert.ok(!sanitized.includes('unicode-secret.txt'));
  assert.ok(!sanitized.includes('/Users/alice/.ssh'));
  assert.ok(!sanitized.includes('/private/var/customer.db'));
  assert.ok(!sanitized.includes('file:///etc/passwd'));
  assert.ok(!sanitized.includes('/private/tmp/report.csv'));
  assert.ok(sanitized.includes('＜font'));
  assert.ok(sanitized.includes('[LOCAL_PATH]'));
  assert.ok(sanitized.includes('本地图片不可展示'));
  assert.ok(sanitized.includes('本地文件不可展示'));
  assert.ok(sanitized.includes('[REDACTED_PRIVATE_KEY]'));
  assert.ok(sanitized.includes('[click me](https://evil.example/phish)'));
  assert.ok(!sanitized.includes('![tracking pixel]('));
  assert.ok(sanitized.includes('[图片已隐藏: tracking pixel]'));
  assert.ok(sanitized.includes('# forged heading'));
  assert.ok(sanitized.includes('| status | approved |'));
  assert.ok(sanitized.includes('| --- | --- |'));
  assert.ok(sanitized.includes('---'));
  assert.ok(sanitized.includes('https://example.test/a/b'));
  assert.strictEqual(sanitizeCardText('codex-feishu-bridge search-core price/compare'), (
    'codex-feishu-bridge search-core price/compare'
  ));

  const short = sanitizeCardText('x'.repeat(100), { maxLength: 32 });
  assert.strictEqual(short.length, 32);
  assert.ok(short.includes('安全截断'));

  assert.throws(() => sanitizeCardText('text', { maxLength: 0 }), RangeError);
  assert.strictEqual(sanitizeCardText('safe text'), 'safe text');

  const footer = sanitizeCardPlainText('窗口用量: 5h: 14% (7/22 04:45)');
  assert.strictEqual(footer, '窗口用量: 5h: 14% (7/22 04:45)');
  assert.ok(!footer.includes('\\'));

  const plainTextWithPath = sanitizeCardPlainText('cwd: /Users/alice/private/project');
  assert.ok(!plainTextWithPath.includes('/Users/alice'));

  const markdown = sanitizeCardMarkdown('**保留格式**: [文档](https://example.test/docs)');
  assert.strictEqual(markdown, '**保留格式**: [文档](https://example.test/docs)');
  assert.ok(!markdown.includes('\\'));

  const unsafeMarkdown = sanitizeCardMarkdown(
    '![tracking](https://evil.example/pixel.png) <font color="red">forged</font> /Users/alice/secret',
  );
  assert.ok(!unsafeMarkdown.includes('![tracking]'));
  assert.ok(!unsafeMarkdown.includes('<font'));
  assert.ok(!unsafeMarkdown.includes('/Users/alice'));
}

run();
console.log('sanitizer.test.ts passed');
