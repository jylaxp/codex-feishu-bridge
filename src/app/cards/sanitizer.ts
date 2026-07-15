import { SanitizedCardText } from '../domain';

const DEFAULT_MAX_LENGTH = 10_000;
const TRUNCATION_SUFFIX = '\n\n… [内容已安全截断]';

export interface SanitizeCardTextOptions {
  readonly maxLength?: number;
}

function redactSecrets(value: string): string {
  let sanitized = value;

  sanitized = sanitized.replace(
    /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)[^\s,;&]+/g,
    '$1[REDACTED]',
  );
  sanitized = sanitized.replace(
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
    '[REDACTED_PRIVATE_KEY]',
  );
  sanitized = sanitized.replace(
    /\b((?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]*):([^@/\s]+)@/gi,
    '$1$2:[REDACTED]@',
  );
  sanitized = sanitized.replace(
    /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'"`]+/gi,
    '$1[REDACTED]',
  );
  sanitized = sanitized.replace(
    new RegExp(
      '\\b((?:api[_-]?key|app[_-]?secret|client[_-]?secret|password|passwd|token|'
        + 'access[_-]?token|refresh[_-]?token)\\s*[:=]\\s*)'
        + '(\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"|[^\\s,;&]+)',
      'gi',
    ),
    '$1[REDACTED]',
  );
  sanitized = sanitized.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, '[REDACTED]');
  sanitized = sanitized.replace(/\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g, '[REDACTED]');
  sanitized = sanitized.replace(/\bxox[baprs]-[a-zA-Z0-9-]{16,}\b/g, '[REDACTED]');
  sanitized = sanitized.replace(
    /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
    '[REDACTED_JWT]',
  );
  return sanitized;
}

function removeAnsiAndControls(value: string): string {
  return value
    .replace(/\u001B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function removeLocalFileRendering(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(
    /!\[([^\]]*)\]\((?:file:\/\/|\/|[a-zA-Z]:[\\/])[^)]+\)/g,
    (_match, alt: string) => `[本地图片不可展示${alt ? `: ${alt}` : ''}]`,
  );
  sanitized = sanitized.replace(
    /\[([^\]]*)\]\((?:file:\/\/|\/|[a-zA-Z]:[\\/])[^)]+\)/g,
    (_match, label: string) => `[本地文件不可展示${label ? `: ${label}` : ''}]`,
  );
  sanitized = sanitized.replace(/\bfile:\/\/[^\s)\]}>'"]+/gi, '[LOCAL_FILE_BLOCKED]');
  return sanitized;
}

function redactAbsolutePaths(value: string): string {
  return value
    .replace(
      /(["'])\/(?!\/)[^\r\n]*?\1/g,
      '$1[LOCAL_PATH]$1',
    )
    .replace(
      /(["'])[a-zA-Z]:[\\/][^\r\n]*?\1/g,
      '$1[LOCAL_PATH]$1',
    )
    .replace(
      /(^|[^A-Za-z0-9/])\/(?!\/)[^\s<>()\[\]{}'"`]+/gm,
      '$1[LOCAL_PATH]',
    )
    .replace(
      /(^|[^A-Za-z0-9])[a-zA-Z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/]?)+/gm,
      '$1[LOCAL_PATH]',
    );
}

function removeMarkdownImages(value: string): string {
  return value.replace(
    /!\[([^\]]*)\]\((?:\\.|[^)])*\)/g,
    (_match, alt: string) => `[图片已隐藏${alt ? `: ${alt}` : ''}]`,
  );
}

function neutralizeRawHtml(value: string): string {
  return value.replace(/<\/?[A-Za-z][^>]*>/g, (markup) => (
    markup.replaceAll('<', '＜').replaceAll('>', '＞')
  ));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= TRUNCATION_SUFFIX.length) {
    return value.slice(0, maxLength);
  }
  return value.slice(0, maxLength - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function sanitizeCardTextInternal(
  input: string,
  options: SanitizeCardTextOptions,
  rendering: 'plain' | 'markdown',
): SanitizedCardText {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 20_000) {
    throw new RangeError('maxLength must be an integer between 1 and 20000');
  }

  let sanitized = String(input ?? '').normalize('NFKC');
  sanitized = removeAnsiAndControls(sanitized);
  sanitized = redactSecrets(sanitized);
  sanitized = removeLocalFileRendering(sanitized);
  sanitized = redactAbsolutePaths(sanitized);
  if (rendering === 'markdown') {
    sanitized = removeMarkdownImages(sanitized);
    sanitized = neutralizeRawHtml(sanitized);
  }
  return truncate(sanitized, maxLength) as SanitizedCardText;
}

/**
 * Converts untrusted model/user/tool text into display-only CardKit content.
 * It never reads or uploads referenced local files.
 */
export function sanitizeCardText(
  input: string,
  options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return sanitizeCardTextInternal(input, options, 'markdown');
}

/**
 * Converts text for a CardKit plain_text element.
 *
 * The element does not parse Markdown, so keeping punctuation literal is safe
 * and avoids rendering implementation-owned status text with escape slashes.
 */
export function sanitizeCardPlainText(
  input: string,
  options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return sanitizeCardTextInternal(input, options, 'plain');
}

/**
 * Converts untrusted text for CardKit's Markdown element without turning
 * normal punctuation into visible backslash escapes.
 *
 * Inline images and raw HTML are neutralized while text redaction and local
 * file blocking remain in force.
 */
export function sanitizeCardMarkdown(
  input: string,
  options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return sanitizeCardTextInternal(input, options, 'markdown');
}
