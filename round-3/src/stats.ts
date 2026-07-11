export function median(values: number[]): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function fmtUsd(v: number | null): string {
  if (v === null) return "—";
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

export function fmtSecs(ms: number): string {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Signed percent delta of reported vs real: +12% = agent over-reports. */
export function costDeltaPct(reported: number, real: number | null): number | null {
  if (real === null || real <= 0) return null;
  return ((reported - real) / real) * 100;
}
