// Hidden acceptance: newest-first must follow receivedAt, not id luck.
import { describe, expect, it } from "bun:test";
import { sortEvents } from "../src/events/sort.js";
import type { WebhookEvent } from "../src/types.js";

const at = (id: string, iso: string): WebhookEvent => ({
  id,
  endpoint: "billing",
  status: "received",
  description: "x",
  payloadBytes: 1,
  receivedAt: iso,
});

describe("event sorting (hidden)", () => {
  // Random hex ids deliberately anti-correlated with time.
  const events = [
    at("ffffaaaa00000001", "2026-03-01T09:00:00.000Z"),
    at("00000000deadbeef", "2026-03-03T18:30:00.000Z"),
    at("7777bbbb12341234", "2026-03-02T12:15:00.000Z"),
  ];

  it("newest first by receivedAt", () => {
    expect(sortEvents(events, "newest").map((e) => e.receivedAt)).toEqual([
      "2026-03-03T18:30:00.000Z",
      "2026-03-02T12:15:00.000Z",
      "2026-03-01T09:00:00.000Z",
    ]);
  });

  it("oldest first by receivedAt", () => {
    expect(sortEvents(events, "oldest").map((e) => e.receivedAt)).toEqual([
      "2026-03-01T09:00:00.000Z",
      "2026-03-02T12:15:00.000Z",
      "2026-03-03T18:30:00.000Z",
    ]);
  });
});
