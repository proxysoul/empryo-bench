import { describe, expect, it } from "bun:test";
import { backoffMs, shouldRetry } from "../src/delivery/retry.js";

describe("retry", () => {
  it("backoff grows exponentially under a cap", () => {
    expect(backoffMs(1, 500, 60_000, () => 1)).toBe(500);
    expect(backoffMs(3, 500, 60_000, () => 1)).toBe(2000);
    expect(backoffMs(20, 500, 60_000, () => 1)).toBe(60_000);
  });

  it("retries 429 and 5xx only, within attempt budget", () => {
    expect(shouldRetry(429, 1)).toBe(true);
    expect(shouldRetry(503, 5)).toBe(true);
    expect(shouldRetry(404, 1)).toBe(false);
    expect(shouldRetry(500, 6)).toBe(false);
  });
});
