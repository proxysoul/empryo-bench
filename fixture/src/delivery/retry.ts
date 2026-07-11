/** Exponential backoff with full jitter, capped. Attempt is 1-based. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 60_000, random = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * exp);
}

export function shouldRetry(status: number, attempt: number, maxAttempts = 6): boolean {
  if (attempt >= maxAttempts) return false;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}
