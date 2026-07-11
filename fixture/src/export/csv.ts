import type { WebhookEvent } from "../types.js";

const COLUMNS = ["id", "endpoint", "status", "description", "receivedAt"] as const;

/** CSV export for the support team (opened in Excel / Numbers). */
export function toCsv(events: WebhookEvent[]): string {
  const header = COLUMNS.join(",");
  const rows = events.map((e) =>
    [e.id, e.endpoint, e.status, e.description, e.receivedAt].join(","),
  );
  return [header, ...rows].join("\n");
}
