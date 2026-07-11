// Hidden acceptance: CSV export must be RFC-4180 parseable.
import { describe, expect, it } from "bun:test";
import { toCsv } from "../src/export/csv.js";
import type { WebhookEvent } from "../src/types.js";

const event = (id: string, description: string): WebhookEvent => ({
  id,
  endpoint: "billing",
  status: "received",
  description,
  payloadBytes: 64,
  receivedAt: "2026-03-02T10:00:00.000Z",
});

/** Minimal RFC-4180 parser: quoted fields, doubled quotes, embedded commas/newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("csv export (hidden)", () => {
  it("descriptions with commas and quotes round-trip without column shift", () => {
    const tricky = 'He said "retry, please" and hung up';
    const rows = parseCsv(toCsv([event("e1", tricky), event("e2", "plain")]));
    expect(rows[0]).toEqual(["id", "endpoint", "status", "description", "receivedAt"]);
    expect(rows[1]?.length).toBe(5);
    expect(rows[1]?.[3]).toBe(tricky);
    expect(rows[2]?.[3]).toBe("plain");
  });

  it("newlines inside descriptions stay in one logical row", () => {
    const rows = parseCsv(toCsv([event("e1", "line one\nline two")]));
    expect(rows.length).toBe(2);
    expect(rows[1]?.[3]).toBe("line one\nline two");
  });
});
