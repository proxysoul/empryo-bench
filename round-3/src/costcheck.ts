/**
 * Third source of truth for cost — Anthropic's own billing.
 *
 * Pulls the org Cost Report for a bench's time window and prints it next to
 * the wire cost the metering proxy recorded, so both can be sanity-checked
 * against what Anthropic actually charges. Needs an ADMIN key (sk-ant-admin…,
 * Console → Settings → Organization → Admin keys) — a regular API key cannot
 * read billing.
 *
 * Note: billing data lags minutes-to-hours and is org-wide with daily (UTC)
 * granularity — run the bench on a dedicated key/org for clean attribution.
 *
 * Usage:
 *   ANTHROPIC_ADMIN_KEY=sk-ant-admin... bun src/costcheck.ts results/<label>.json
 */
import { readFileSync } from "node:fs";
import { fmtUsd } from "./stats.ts";
import type { BenchResults } from "./types.ts";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun src/costcheck.ts results/<label>.json");
    process.exit(1);
  }
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) {
    console.error("ANTHROPIC_ADMIN_KEY is required (admin key, not a regular API key)");
    process.exit(1);
  }
  const results = JSON.parse(readFileSync(file, "utf8")) as BenchResults;

  const starts = results.runs.map((r) => r.startedAt).filter((s): s is string => !!s);
  const first = starts.length ? starts.sort()[0] : results.when;
  const startDay = new Date(`${first.slice(0, 10)}T00:00:00Z`);
  const endDay = new Date(startDay.getTime() + 2 * 86_400_000); // window + 1 day pad

  const wire = results.runs.reduce((s, r) => s + (r.realCost ?? 0), 0);
  const reported = results.runs.reduce((s, r) => s + r.reportedCost, 0);

  const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  url.searchParams.set("starting_at", startDay.toISOString());
  url.searchParams.set("ending_at", endDay.toISOString());
  url.searchParams.set("group_by[]", "description");
  const resp = await fetch(url, {
    headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01" },
  });
  if (!resp.ok) {
    console.error(`cost_report API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const j = (await resp.json()) as {
    data?: { results?: { amount?: string; description?: string; currency?: string }[] }[];
  };
  let billed = 0;
  const lines: string[] = [];
  for (const bucket of j.data ?? []) {
    for (const item of bucket.results ?? []) {
      const amt = Number(item.amount ?? 0);
      billed += amt;
      if (amt > 0) lines.push(`  ${fmtUsd(amt)}  ${item.description ?? "?"}`);
    }
  }

  console.error(`[costcheck] ${results.label} — window ${startDay.toISOString().slice(0, 10)} +2d (UTC, org-wide)`);
  for (const l of lines) console.error(l);
  console.error(`[costcheck] Anthropic billed (window): ${fmtUsd(billed)}`);
  console.error(`[costcheck] proxy wire total:          ${fmtUsd(wire)}`);
  console.error(`[costcheck] agents self-reported:      ${fmtUsd(reported)}`);
  console.error(
    "[costcheck] billed ≥ wire is expected if the org had other traffic; billed < wire means the pricing table or proxy parse is wrong — investigate.",
  );
}

await main();
