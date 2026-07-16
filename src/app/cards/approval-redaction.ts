/** Redacts credential-shaped values only in approval operation summaries. */
export function redactApprovalSecrets(text: string): string {
  if (!text) {
    return text;
  }
  let clean = text;
  const prefixPatterns = [
    /(authorization:\s*bearer\s+)[^\s'"]+/gi,
    /(token=)[^&\s]+/gi,
    /(api[_-]?key=)[^&\s]+/gi,
    /(secret=)[^&\s]+/gi,
    /(password=)[^&\s]+/gi,
    /(passwd=)[^&\s]+/gi,
    /(openai[_-]?api[_-]?key=)[^&\s]+/gi,
    /(\b(?:openai[_-]?)?api[_-]?key\b\s*[:=]\s*['"]?)[a-zA-Z0-9_-]+/gi,
    /(\bpassword\b\s*[:=]\s*['"]?)[a-zA-Z0-9_-]+/gi,
  ];
  for (const pattern of prefixPatterns) {
    clean = clean.replace(pattern, '$1[REDACTED]');
  }
  return clean.replace(/sk-[a-zA-Z0-9_-]{20,}/gi, '[REDACTED]');
}
