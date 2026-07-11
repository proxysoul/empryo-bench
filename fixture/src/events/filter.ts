import type { EventStatus, WebhookEvent } from "../types.js";

export interface EventFilter {
  status?: EventStatus;
  endpoint?: string;
  search?: string;
}

export function filterEvents(events: WebhookEvent[], filter: EventFilter): WebhookEvent[] {
  const needle = filter.search?.toLowerCase();
  return events.filter((e) => {
    if (filter.status && e.status !== filter.status) return false;
    if (filter.endpoint && e.endpoint !== filter.endpoint) return false;
    if (needle && !e.description.toLowerCase().includes(needle)) return false;
    return true;
  });
}
