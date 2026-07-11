import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDb } from "../src/store/db.js";
import { EventStore } from "../src/store/event-store.js";
import type { WebhookEvent } from "../src/types.js";

const event = (id: string): WebhookEvent => ({
  id,
  endpoint: "billing",
  status: "received",
  description: "x",
  payloadBytes: 1,
  receivedAt: "2026-03-02T10:00:00.000Z",
});

describe("event store", () => {
  it("adds, lists and prunes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hookboard-"));
    const store = new EventStore(new JsonDb(join(dir, "events.json"), [], 1));
    await store.add(event("a"));
    await store.add(event("b"));
    await store.add(event("c"));
    expect((await store.list()).length).toBe(3);
    expect(await store.prune(2)).toBe(1);
    expect((await store.list()).map((e) => e.id)).toEqual(["b", "c"]);
  });
});
