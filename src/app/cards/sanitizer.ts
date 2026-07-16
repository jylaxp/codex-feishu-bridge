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
  _options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return String(input ?? '') as SanitizedCardText;
}

/** Preserves plain text exactly as received. */
export function sanitizeCardPlainText(
  input: string,
  _options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return String(input ?? '') as SanitizedCardText;
}

/** Preserves Markdown exactly as received. */
export function sanitizeCardMarkdown(
  input: string,
  _options: SanitizeCardTextOptions = {},
): SanitizedCardText {
  return String(input ?? '') as SanitizedCardText;
}
