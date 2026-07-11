export function nowIso(): string {
  return new Date().toISOString();
}

export function isoToMillis(iso: string): number {
  return new Date(iso).getTime();
}

/** "2h ago" style label for the dashboard. */
export function ageLabel(iso: string, nowMs = Date.now()): string {
  const mins = Math.max(0, Math.round((nowMs - isoToMillis(iso)) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
