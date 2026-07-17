import { SanitizedCardText } from '../domain';

export interface SanitizeCardTextOptions {
  readonly maxLength?: number;
}

/**
 * Preserves the original application behavior: card text is projected exactly
 * as received. The retained function name is only a type-boundary adapter for
 * the new Desktop event pipeline; it must not rewrite Markdown or punctuation.
 */
export function sanitizeCardText(
  input: string,
  options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return boundCardText(input, options.maxLength);
}

/** Preserves plain text exactly as received. */
export function sanitizeCardPlainText(
  input: string,
  options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return boundCardText(input, options.maxLength);
}

/** Preserves Markdown exactly as received. */
export function sanitizeCardMarkdown(
  input: string,
  options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return boundCardText(input, options.maxLength);
}

/**
 * Applies only a transport-size boundary. It deliberately does not escape,
 * normalize, trim, or otherwise rewrite the original Markdown/text content.
 */
function boundCardText(input: string, maxLength: number | undefined): SanitizedCardText {
  const text = String(input ?? '');
  if (maxLength === undefined || maxLength < 1 || text.length <= maxLength) {
    return text as SanitizedCardText;
  }
  if (maxLength === 1) {
    return '…' as SanitizedCardText;
  }
  return `${text.slice(0, maxLength - 1)}…` as SanitizedCardText;
}
