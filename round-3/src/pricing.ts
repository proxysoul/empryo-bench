import type { TokenCounts } from "./types.ts";

/**
 * Anthropic list prices, USD per million tokens (verified 2026-08-11).
 * Cache read = 10% of input; 5-minute cache write = 1.25x input.
 * Update here if Anthropic changes rates — this table is the single source
 * for "real cost" computed by the metering proxy.
 */
const PRICES: Record<string, { in: number; out: number; cacheWrite?: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-1": { in: 15, out: 75 },
  "claude-opus-4-5": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  // Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31 — bump to 3/15 after.
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
  // OpenAI gpt-5.6 family (models.dev, verified 2026-08-15). Cache READ is 0.1x
  // input here too, but there is no write PREMIUM: OpenAI's prefix caching is
  // automatic, and a token being cached for later does not cost extra — it is
  // billed once, as ordinary input. Hence 1x, not Anthropic's 1.25x.
  //
  // NOT 0x. OpenAI reports only `cached_tokens` (reads) and never a write
  // count, so this multiplier should never fire; if some future caller does
  // populate cacheWrite on this lane, those tokens were still paid for at full
  // input price. 1x can at worst double-count against `input`, while 0x would
  // silently drop real spend — and a cost harness must never round its own
  // bill down.
  "gpt-5.6-luna": { in: 0.2, out: 1.2, cacheWrite: 1 },
  "gpt-5.6-terra": { in: 2, out: 12, cacheWrite: 1 },
  "gpt-5.6-sol": { in: 5, out: 30, cacheWrite: 1 },
  "gpt-5.6": { in: 5, out: 30, cacheWrite: 1 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

export function priceFor(
  modelId: string,
): { in: number; out: number; cacheWrite?: number } | null {
  const bare = modelId.replace(/^.*\//, "");
  for (const [key, p] of Object.entries(PRICES)) {
    if (bare === key || bare.startsWith(`${key}-`)) return p;
  }
  return null;
}

/** Real cost in USD for a set of token counts on a model. */
export function costOf(modelId: string, t: TokenCounts): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  return (
    (t.input * p.in +
      t.output * p.out +
      t.cacheRead * p.in * CACHE_READ_MULT +
      t.cacheWrite * p.in * (p.cacheWrite ?? CACHE_WRITE_MULT)) /
    1e6
  );
}
