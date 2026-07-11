import { createHmac, timingSafeEqual } from "node:crypto";

/** hookboard-style signature header: "v1=<hex hmac of ts.payload>". */
export function signPayload(secret: string, timestamp: number, payload: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `v1=${mac}`;
}

export function verifySignature(
  secret: string,
  timestamp: number,
  payload: string,
  header: string,
  toleranceSec = 300,
  nowMs = Date.now(),
): boolean {
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, payload));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
