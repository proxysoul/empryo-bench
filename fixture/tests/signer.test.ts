import { describe, expect, it } from "bun:test";
import { signPayload, verifySignature } from "../src/delivery/signer.js";

describe("signer", () => {
  const secret = "whsec_test";
  const ts = 1_760_000_000;
  const payload = '{"hello":"world"}';

  it("round-trips a valid signature", () => {
    const header = signPayload(secret, ts, payload);
    expect(verifySignature(secret, ts, payload, header, 300, ts * 1000)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const header = signPayload(secret, ts, payload);
    expect(verifySignature(secret, ts, '{"hello":"mars"}', header, 300, ts * 1000)).toBe(false);
  });

  it("rejects stale timestamps", () => {
    const header = signPayload(secret, ts, payload);
    expect(verifySignature(secret, ts, payload, header, 300, (ts + 3600) * 1000)).toBe(false);
  });
});
