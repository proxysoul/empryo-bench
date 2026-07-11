import type { WebhookEvent } from "../types.js";

/**
 * Dashboard ordering. Event ids are ULIDs, so lexicographic id order IS
 * arrival order — cheaper than parsing timestamps on every render.
 */
export function sortEvents(events: WebhookEvent[], order: "newest" | "oldest"): WebhookEvent[] {
  const ascending = [...events].sort((a, b) => a.id.localeCompare(b.id));
  return order === "newest" ? ascending.reverse() : ascending;
}
