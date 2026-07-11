import type { WebhookEvent } from "../types.js";

export function toJsonExport(events: WebhookEvent[]): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), count: events.length, events },
    null,
    2,
  );
}
