/**
 * Shared aggregation — the ONE place medians/rankings are computed, used by
 * the HTML report, the results manifest, and (later) the webapp benchmarks
 * page. Also maintains results/index.json: a cheap-to-fetch catalog of every
 * benchmark with pre-computed summaries.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { median } from "./stats.ts";
import type { AgentId, BenchResults } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export interface AgentAgg {
  agent: AgentId;
  passes: number;
  total: number;
  passRate: number;
  medDuration: number;
  /** Median wall time over PASSING runs only (fast failures don't flatter). */
  medDurationSolved: number | null;
  medReported: number;
  medReal: number | null;
  medQuality: number | null;
  medTokensOut: number;
  score: number;
}

export function aggregate(r: BenchResults, agent: AgentId, taskId?: string): AgentAgg {
  const runs = r.runs.filter((x) => x.agent === agent && (!taskId || x.task === taskId));
  const passes = runs.filter((x) => x.pass).length;
  const reals = runs.map((x) => x.realCost).filter((x): x is number => x !== null);
  const quals = runs.map((x) => x.quality?.score).filter((x): x is number => x != null);
  const passRate = runs.length ? passes / runs.length : 0;
  const medQuality = quals.length ? median(quals) : null;
  return {
    agent,
    passes,
    total: runs.length,
    passRate,
    medDuration: median(runs.map((x) => x.durationMs)),
    medDurationSolved: passes > 0 ? median(runs.filter((x) => x.pass).map((x) => x.durationMs)) : null,
    medReported: median(runs.map((x) => x.reportedCost)),
    medReal: reals.length ? median(reals) : null,
    medQuality,
    medTokensOut: median(runs.map((x) => x.reportedTokens.output)),
    // Composite for ranking only: correctness dominates, quality tie-breaks.
    score: passRate * 100 + (medQuality ?? 0),
  };
}

export interface BenchSummary {
  file: string;
  label: string;
  when: string;
  model: string;
  repeats: number;
  demo: boolean;
  tasks: BenchResults["tasks"];
  env?: BenchResults["env"];
  agents: AgentAgg[];
  winner: AgentId | null;
}

export function summarize(r: BenchResults, file: string): BenchSummary {
  const agents = r.agents.map((a) => aggregate(r, a)).sort((a, b) => b.score - a.score);
  return {
    file,
    label: r.label,
    when: r.when,
    model: r.model,
    repeats: r.repeats,
    demo: r.demo === true,
    tasks: r.tasks,
    env: r.env,
    agents,
    winner: agents[0]?.agent ?? null,
  };
}

/**
 * Rebuild results/index.json from every results file. Demo/sample data is
 * excluded — the manifest is the brag sheet, only real runs belong.
 */
export function writeManifest(resultsDir: string): void {
  const benchmarks: BenchSummary[] = [];
  for (const f of readdirSync(resultsDir).sort()) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    try {
      const r = JSON.parse(readFileSync(join(resultsDir, f), "utf8")) as BenchResults;
      if (!Array.isArray(r.runs) || r.demo) continue;
      benchmarks.push(summarize(r, f));
    } catch {
      // unreadable file — skip
    }
  }
  benchmarks.sort((a, b) => (a.when < b.when ? 1 : -1));
  writeFileSync(
    join(resultsDir, "index.json"),
    JSON.stringify(
      { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), benchmarks },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "results");
  writeManifest(dir);
  console.error(`[manifest] rebuilt ${join(dir, "index.json")}`);
}
