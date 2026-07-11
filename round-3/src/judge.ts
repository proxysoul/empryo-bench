/**
 * Code-quality judge — blind LLM review of each run's diff.
 *
 * The judge sees: the bug report, the agent's diff, and the REAL upstream fix
 * as reference. It never sees which agent produced the diff (runs are judged
 * in shuffled order, identity stripped). Scores land back in the results file.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun src/judge.ts results/<label>.json \
 *     [--judge-model claude-opus-4-8] [--force]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { HIDDEN_DIR } from "./prep.ts";
import { taskById } from "./tasks.ts";
import type { BenchResults, RunRecord } from "./types.ts";
import { writeManifest } from "./aggregate.ts";

const RUBRIC = `You are reviewing a bug-fix diff produced by an anonymous coding agent.
You are given: the original bug report, the agent's unified diff, and the real
upstream fix that maintainers merged (as reference — a different-but-correct
approach must NOT be penalized for differing from it).

Score 0-10 as the sum of:
- root cause (0-4): fixes the actual cause, not a symptom or special-case patch
- minimality (0-2): no unrelated churn, no drive-by refactors, no dead code
- style (0-2): matches the surrounding codebase's conventions and idioms
- robustness (0-2): handles the edge cases the bug class implies

An empty diff scores 0. Reply with STRICT JSON only:
{"score": <number>, "rationale": "<one dense sentence>"}`;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function judgeOne(
  run: RunRecord,
  judgeModel: string,
  apiKey: string,
): Promise<{ score: number; rationale: string }> {
  if (!run.diff.trim()) return { score: 0, rationale: "empty diff — no change produced" };
  const task = taskById(run.task);
  const refPath = join(HIDDEN_DIR, run.task, "_reference-fix.patch");
  const reference = existsSync(refPath) ? readFileSync(refPath, "utf8") : "(unavailable)";

  const body = {
    model: judgeModel,
    max_tokens: 500,
    system: RUBRIC,
    messages: [
      {
        role: "user",
        content:
          `## Bug report\n\n${task.prompt}\n\n` +
          `## Agent diff\n\n\`\`\`diff\n${run.diff.slice(0, 60_000)}\n\`\`\`\n\n` +
          `## Reference (real upstream fix)\n\n\`\`\`diff\n${reference.slice(0, 30_000)}\n\`\`\``,
      },
    ],
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`judge API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const j = (await resp.json()) as { content?: { type: string; text?: string }[] };
  const text = (j.content ?? []).find((c) => c.type === "text")?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`judge returned no JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]) as { score: number; rationale: string };
  return {
    score: Math.max(0, Math.min(10, Number(parsed.score))),
    rationale: String(parsed.rationale ?? "").slice(0, 500),
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || !existsSync(file)) {
    console.error("usage: bun src/judge.ts results/<label>.json [--judge-model m] [--force]");
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.BENCH_ANTHROPIC_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY (or BENCH_ANTHROPIC_KEY) is required");
    process.exit(1);
  }
  const judgeModel = arg("judge-model") ?? "claude-opus-4-8";
  const force = process.argv.includes("--force");

  const results = JSON.parse(readFileSync(file, "utf8")) as BenchResults;
  // Blind order: shuffle so scoring position can't correlate with agent.
  const pending = results.runs
    .map((run, i) => ({ run, i }))
    .filter(({ run }) => force || run.quality == null)
    .sort(() => Math.random() - 0.5);

  console.error(`[judge] ${pending.length} runs to score with ${judgeModel}`);
  for (const { run, i } of pending) {
    try {
      const q = await judgeOne(run, judgeModel, apiKey);
      results.runs[i].quality = { ...q, judgeModel };
      console.error(
        `[judge] ${run.task} rep${run.rep} (#${i}) → ${q.score}/10 — ${q.rationale.slice(0, 90)}`,
      );
    } catch (err) {
      console.error(`[judge] #${i} failed: ${err instanceof Error ? err.message : err}`);
    }
    writeFileSync(file, JSON.stringify(results, null, 2));
  }
  writeManifest(dirname(file));
  console.error(`[judge] done — scores merged into ${file} (manifest rebuilt)`);
}

await main();
