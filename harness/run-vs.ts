/**
 * Head-to-head: Empryo headless vs pi headless on the hookboard fixture.
 *
 * Three REAL bugs ship committed in the fixture; prompts are written the way
 * a human reports symptoms (no file names, no instructions). Verification =
 * hidden acceptance tests dropped in AFTER the run + the fixture's own tests
 * (no regressions allowed).
 *
 * Usage (keys via env, never committed):
 *   PI_BENCH_KEY=sk-... EMPRYO_BENCH_KEY=sk-... bun bench/vs/run-vs.ts [--sanity]
 *     [--tiers haiku,sonnet,opus] [--tasks all|id,id] [--label vs-1]
 *     [--budget-stop 12]
 *
 * Runs tier by tier (cheapest first) and stops when cumulative agent-reported
 * cost crosses the budget stop. Costs are agent-self-reported; raw token
 * counts are recorded too since pricing tables differ.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VS_DIR = import.meta.dir;
const FIXTURE = resolve(VS_DIR, "..", "fixture");
const CHECKS = join(VS_DIR, "checks");
const RESULTS_DIR = resolve(VS_DIR, "..", "results");
const EMPRYO_BIN = process.env.EMPRYO_BIN ?? "empryo";
const RUN_TIMEOUT_MS = 420_000;

interface VsTask {
  id: string;
  prompt: string;
  check: string; // file in bench/vs/checks
}

const TASKS: VsTask[] = [
  {
    id: "profile-race",
    prompt:
      "People keep telling me that when they change two profile settings quickly one after another (like display name and then email), one of the changes silently disappears. I can't reproduce it when I click slowly. Can you dig into it and fix whatever is wrong?",
    check: "profile-race.test.ts",
  },
  {
    id: "csv-quoting",
    prompt:
      "Our support team exports events to CSV and opens the file in Excel. Whenever a description contains a comma or a quote, the columns go all wonky. Please fix the export so it produces proper CSV.",
    check: "csv-quoting.test.ts",
  },
  {
    id: "sort-order",
    prompt:
      "On the dashboard the events list is supposed to show newest first, but the order is all over the place — definitely not newest first. Something is off with the sorting. Can you find out why and fix it?",
    check: "sort-order.test.ts",
  },
];

const TIER_MODELS: Record<string, { empryo: string; pi: string; piExtraArgs?: string[] }> = {
  haiku: { empryo: "anthropic/claude-haiku-4-5-20251001", pi: "claude-haiku-4-5" },
  sonnet: { empryo: "anthropic/claude-sonnet-4-6", pi: "claude-sonnet-4-6" },
  // pi's model registry has no opus-4.8 (fuzzy "opus" resolves to 4-7) and its
  // default thinking config 400s on 4.8 — custom id + thinking off is the only
  // way pi runs the same model. Documented in the experiment write-up.
  opus: { empryo: "anthropic/claude-opus-4-8", pi: "claude-opus-4-8", piExtraArgs: ["--thinking", "off"] },
};

interface Row {
  task: string;
  agent: "empryo" | "pi";
  tier: string;
  model: string;
  pass: boolean;
  reason?: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  steps: number;
  toolCalls: number;
  durationMs: number;
  error?: string;
  skipped?: boolean;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const tiers = (arg("tiers")?.split(",") ?? ["haiku", "sonnet", "opus"]).filter((t) => TIER_MODELS[t]);
const label = arg("label") ?? "vs-1";
const budgetStop = Number(arg("budget-stop") ?? 12);
const taskFilter = arg("tasks");
const tasks =
  !taskFilter || taskFilter === "all" ? TASKS : TASKS.filter((t) => taskFilter.split(",").includes(t.id));

function sh(cmd: string, cwd: string, timeoutMs = 180_000): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    const proc = Bun.spawn(["bash", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(9), timeoutMs);
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
      ([out, err, code]) => {
        clearTimeout(timer);
        resolvePromise({ code, out: `${out}\n${err}`.trim() });
      },
    );
  });
}

function copyFixture(dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(FIXTURE, dest, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.includes(".empryo"),
  });
}

async function runEmpryo(dir: string, prompt: string, model: string): Promise<Partial<Row>> {
  const key = process.env.EMPRYO_BENCH_KEY;
  if (!key) throw new Error("EMPRYO_BENCH_KEY not set");
  const started = Date.now();
  const proc = Bun.spawn(
    [
      EMPRYO_BIN, "--headless", prompt, "--json", "--quiet", "--mode", "auto",
      "--model", model, "--max-steps", "40", "--timeout", String(RUN_TIMEOUT_MS), "--cwd", dir,
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, ANTHROPIC_API_KEY: key } },
  );
  const timer = setTimeout(() => proc.kill(9), RUN_TIMEOUT_MS + 60_000);
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  try {
    const j = JSON.parse(out);
    return {
      tokensIn: j.tokens?.input ?? 0,
      tokensOut: j.tokens?.output ?? 0,
      cacheRead: j.tokens?.cacheRead ?? 0,
      cacheWrite: j.tokens?.cacheWrite ?? 0,
      cost: j.cost ?? 0,
      steps: j.steps ?? 0,
      toolCalls: j.toolCalls?.length ?? 0,
      durationMs: j.duration ?? Date.now() - started,
      error: j.error,
    };
  } catch {
    return { durationMs: Date.now() - started, error: `unparseable: ${out.slice(0, 200)}` };
  }
}

async function runPi(dir: string, prompt: string, model: string, extraArgs: string[] = []): Promise<Partial<Row>> {
  const key = process.env.PI_BENCH_KEY;
  if (!key) throw new Error("PI_BENCH_KEY not set");
  const started = Date.now();
  const proc = Bun.spawn(
    ["pi", "--provider", "anthropic", "--model", model, ...extraArgs, "--api-key", key, "--no-session", "-p", "--mode", "json", prompt],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const timer = setTimeout(() => proc.kill(9), RUN_TIMEOUT_MS + 60_000);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  // Parse the JSONL stream; agent_end.messages carries per-assistant usage.
  let messages: { role: string; content?: { type: string }[]; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } }[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "agent_end" && Array.isArray(evt.messages)) messages = evt.messages;
    } catch {
      // non-JSON noise (extension logs) — ignore
    }
  }
  if (messages.length === 0) {
    return { durationMs, error: `no agent_end event; stderr: ${err.slice(-200)}` };
  }
  const assistants = messages.filter((m) => m.role === "assistant");
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let toolCalls = 0;
  for (const m of assistants) {
    tokensIn += m.usage?.input ?? 0;
    tokensOut += m.usage?.output ?? 0;
    cacheRead += m.usage?.cacheRead ?? 0;
    cacheWrite += m.usage?.cacheWrite ?? 0;
    cost += m.usage?.cost?.total ?? 0;
    toolCalls += (m.content ?? []).filter((c) => c.type === "toolCall").length;
  }
  return {
    tokensIn: tokensIn + cacheRead + cacheWrite, // align with empryo's inclusive input
    tokensOut,
    cacheRead,
    cacheWrite,
    cost,
    steps: assistants.length,
    toolCalls,
    durationMs,
  };
}

async function verify(dir: string, task: VsTask): Promise<{ pass: boolean; reason?: string }> {
  mkdirSync(join(dir, "tests-hidden"), { recursive: true });
  cpSync(join(CHECKS, task.check), join(dir, "tests-hidden", task.check));
  const acceptance = await sh("bun test tests-hidden", dir);
  if (acceptance.code !== 0) return { pass: false, reason: `acceptance: ${acceptance.out.slice(-260)}` };
  const regression = await sh("bun test tests", dir);
  if (regression.code !== 0) return { pass: false, reason: `regression: ${regression.out.slice(-260)}` };
  return { pass: true };
}

async function sanity(): Promise<void> {
  console.error("[vs] sanity: committed tests green; every hidden check fails by assertion on the broken fixture");
  let failures = 0;
  for (const task of tasks) {
    const dir = join(tmpdir(), `hookboard-sanity-${task.id}`);
    copyFixture(dir);
    const committed = await sh("bun test tests", dir);
    mkdirSync(join(dir, "tests-hidden"), { recursive: true });
    cpSync(join(CHECKS, task.check), join(dir, "tests-hidden", task.check));
    const hidden = await sh("bun test tests-hidden", dir);
    const assertionFail = hidden.code !== 0 && /\(fail\)/.test(hidden.out);
    const broken = /Cannot find module|SyntaxError/.test(hidden.out);
    const ok = committed.code === 0 && assertionFail && !broken;
    console.error(`  ${ok ? "ok " : "FAIL"} ${task.id} (committed=${committed.code}, hidden=${hidden.code}${broken ? ", harness-broken" : ""})`);
    if (!ok) failures++;
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures) process.exit(1);
  console.error("[vs] sanity passed");
}

async function main(): Promise<void> {
  if (has("sanity")) return void (await sanity());
  mkdirSync(RESULTS_DIR, { recursive: true });
  const rows: Row[] = [];
  let spent = 0;

  const agentFilter = (arg("agents")?.split(",") ?? ["empryo", "pi"]) as ("empryo" | "pi")[];
  for (const tier of tiers) {
    for (const task of tasks) {
      for (const agent of agentFilter) {
        if (spent >= budgetStop) {
          rows.push({ task: task.id, agent, tier, model: TIER_MODELS[tier]?.[agent] ?? "", pass: false, reason: "skipped: budget stop", tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0, steps: 0, toolCalls: 0, durationMs: 0, skipped: true });
          continue;
        }
        const model = TIER_MODELS[tier]?.[agent];
        if (!model) continue;
        const dir = join(tmpdir(), `hookboard-${label}-${tier}-${task.id}-${agent}`);
        copyFixture(dir);
        console.error(`[vs] ▶ ${tier} · ${task.id} · ${agent}`);
        const run =
          agent === "empryo"
            ? await runEmpryo(dir, task.prompt, model)
            : await runPi(dir, task.prompt, model, TIER_MODELS[tier]?.piExtraArgs ?? []);
        const verdict = run.error && !run.steps ? { pass: false, reason: `agent did not run: ${run.error}` } : await verify(dir, task);
        const row: Row = {
          task: task.id, agent, tier, model,
          pass: verdict.pass, reason: verdict.reason,
          tokensIn: run.tokensIn ?? 0, tokensOut: run.tokensOut ?? 0,
          cacheRead: run.cacheRead ?? 0, cacheWrite: run.cacheWrite ?? 0,
          cost: run.cost ?? 0, steps: run.steps ?? 0, toolCalls: run.toolCalls ?? 0,
          durationMs: run.durationMs ?? 0, error: run.error,
        };
        rows.push(row);
        spent += row.cost;
        console.error(
          `[vs] ${row.pass ? "✓" : "✗"} ${tier} · ${task.id} · ${agent} — $${row.cost.toFixed(4)}, ${row.steps} steps, ${(row.durationMs / 1000).toFixed(1)}s (total spent $${spent.toFixed(2)})${row.reason ? ` — ${String(row.reason).slice(0, 120)}` : ""}`,
        );
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  const outPath = join(RESULTS_DIR, `${label}.json`);
  writeFileSync(outPath, JSON.stringify({ label, when: new Date().toISOString(), tiers, budgetStop, spent, rows }, null, 2));
  console.error(`[vs] done — spent $${spent.toFixed(2)}, results at ${outPath}`);
}

await main();
