/**
 * Key sanity — loads .env.bench, checks presence/distinctness, then hits the
 * FREE count_tokens endpoint once per key so a dead key is caught before the
 * round starts. No tokens are billed. Usage: bun preflight-keys.ts
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL(".env.bench", import.meta.url), "utf8");
const keys = new Map<string, string>();
for (const line of envText.split("\n")) {
  const m = line.match(/^(BENCH_KEY_[A-Z_]+)=(\S+)/);
  if (m) keys.set(m[1], m[2]);
}

const wanted = [
  "BENCH_KEY_EMPRYO",
  "BENCH_KEY_EMPRYO_MARIONETTE",
  "BENCH_KEY_PI",
  "BENCH_KEY_OPENCODE",
  "BENCH_KEY_CLAUDE",
];
let bad = 0;
for (const w of wanted) if (!keys.get(w)) { console.error(`MISSING ${w}`); bad++; }
if (new Set(keys.values()).size !== keys.size) { console.error("DUPLICATE keys present"); bad++; }

for (const [name, key] of keys) {
  const resp = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "x" }] }),
  });
  console.error(`${name.padEnd(30)} HTTP ${resp.status} ${resp.ok ? "✓" : `✗ ${(await resp.text()).slice(0, 120)}`}`);
  if (!resp.ok) bad++;
}
process.exit(bad ? 1 : 0);
