import { describe, expect, it } from "bun:test";
import { filterEvents } from "../src/events/filter.js";
import type { WebhookEvent } from "../src/types.js";

const event = (over: Partial<WebhookEvent>): WebhookEvent => ({
  id: "e1",
  endpoint: "billing",
  status: "received",
  description: "invoice.paid",
  payloadBytes: 128,
  receivedAt: "2026-03-02T10:00:00.000Z",
  ...over,
});

describe("filterEvents", () => {
  const events = [
    event({ id: "a", status: "failed", description: "charge.failed for acme" }),
    event({ id: "b", endpoint: "crm", description: "contact.created" }),
    event({ id: "c" }),
  ];

  it("filters by status", () => {
    expect(filterEvents(events, { status: "failed" }).map((e) => e.id)).toEqual(["a"]);
  });

  it("filters by endpoint and search together", () => {
    expect(filterEvents(events, { endpoint: "crm", search: "contact" }).map((e) => e.id)).toEqual(["b"]);
  });

  it("search is case-insensitive", () => {
    expect(filterEvents(events, { search: "ACME" }).map((e) => e.id)).toEqual(["a"]);
  });
});
