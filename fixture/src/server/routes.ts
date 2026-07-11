import { filterEvents, type EventFilter } from "../events/filter.js";
import { sortEvents } from "../events/sort.js";
import { toCsv } from "../export/csv.js";
import { toJsonExport } from "../export/json.js";
import type { EventStore } from "../store/event-store.js";
import type { ProfileStore } from "../store/profile-store.js";
import type { Profile } from "../types.js";

export interface RouteResult {
  status: number;
  body: string;
  contentType: string;
}

const json = (status: number, body: unknown): RouteResult => ({
  status,
  body: JSON.stringify(body),
  contentType: "application/json",
});

/** Dispatcher the HTTP layer calls into (kept transport-free for tests). */
export async function handle(
  stores: { events: EventStore; profile: ProfileStore },
  method: string,
  path: string,
  query: Record<string, string>,
  body: unknown,
): Promise<RouteResult> {
  if (method === "GET" && path === "/events") {
    const filter: EventFilter = {
      status: query.status as EventFilter["status"],
      endpoint: query.endpoint,
      search: query.search,
    };
    const order = query.order === "oldest" ? "oldest" : "newest";
    const events = sortEvents(filterEvents(await stores.events.list(), filter), order);
    return json(200, events);
  }
  if (method === "GET" && path === "/events/export.csv") {
    const events = sortEvents(await stores.events.list(), "newest");
    return { status: 200, body: toCsv(events), contentType: "text/csv" };
  }
  if (method === "GET" && path === "/events/export.json") {
    return {
      status: 200,
      body: toJsonExport(await stores.events.list()),
      contentType: "application/json",
    };
  }
  if (method === "GET" && path === "/profile") {
    return json(200, await stores.profile.get());
  }
  if (method === "PATCH" && path === "/profile") {
    return json(200, await stores.profile.update(body as Partial<Profile>));
  }
  return json(404, { error: "not found" });
}
