/**
 * Checks whether a validated process ID still exists. Only ESRCH proves absence;
 * authorization and other probe failures must fail closed as potentially alive.
 */
export function isProcessAlive(
  pid: number,
  signal: typeof process.kill = process.kill,
): boolean {
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) !== 'ESRCH';
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error
    ? (error as Error & { readonly code?: string }).code
    : undefined;
}
