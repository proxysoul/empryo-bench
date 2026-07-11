/**
 * Round 3 — Empryo vs pi on REAL bugs in REAL OSS repos (SWE-bench-style).
 *
 * Per task (see tasks.ts): the repo is prepared at the fix PR's parent commit
 * (bug live), with git history REWRITTEN to a single baseline commit so the
 * real fix is unreachable (agents can and do run `git log`). The fix PR's own
 * regression tests are held OUTSIDE the workspace and dropped in after the
 * run. All fixes merged post-2026-01 — past both models' training cutoffs.
 *
 * Usage (keys via env, never committed):
 *   PI_BENCH_KEY=... EMPRYO_BENCH_KEY=... bun bench/vs-real/run.ts \
 *     [--tiers haiku,opus] [--tasks all|id,id] [--agents empryo,pi] \
 *     [--label vs-real-1] [--budget-stop 12] [--prep-only]
 *
 * `--prep-only` builds the per-task caches (clone+install+scrub) and exits —
 * run it once before spending tokens.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REAL_TASKS, type RealTask } from "./tasks.ts";

const VS_DIR = import.meta.dir;
const REPO_ROOT = resolve(VS_DIR, "..");
const RESULTS_DIR = join(REPO_ROOT, "results");
const CACHE_DIR = join(REPO_ROOT, ".cache", "vs-real");
const HIDDEN_DIR = join(CACHE_DIR, "_hidden");
const EMPRYO_BIN = process.env.EMPRYO_BIN ?? "empryo";
const RUN_TIMEOUT_MS = 420_000;

const TIER_MODELS: Record<string, { empryo: string; pi: string; piExtraArgs?: string[] }> = {
  haiku: { empryo: "anthropic/claude-haiku-4-5-20251001", pi: "claude-haiku-4-5" },
  sonnet: { empryo: "anthropic/claude-sonnet-4-6", pi: "claude-sonnet-4-6" },
  // pi's registry has no opus-4.8 and its default thinking config 400s on it —
  // custom id + thinking off is the documented way pi runs this model (r1+r2).
  opus: {
    empryo: "anthropic/claude-opus-4-8",
    pi: "claude-opus-4-8",
    piExtraArgs: ["--thinking", "off"],
  },
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
  prewarmMs?: number;
  error?: string;
  skipped?: boolean;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const tiers = (arg("tiers")?.split(",") ?? ["haiku", "opus"]).filter((t) => TIER_MODELS[t]);
const label = arg("label") ?? "vs-real-1";
const budgetStop = Number(arg("budget-stop") ?? 12);
const taskFilter = arg("tasks");
const tasks =
  !taskFilter || taskFilter === "all"
    ? REAL_TASKS
    : REAL_TASKS.filter((t) => taskFilter.split(",").includes(t.id));

function sh(cmd: string[], cwd: string, timeoutMs = 600_000): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    env: { ...process.env, CI: "1" },
  });
  return { code: proc.exitCode ?? 1, out: `${proc.stdout.toString()}\n${proc.stderr.toString()}` };
}

/** Build the pristine per-task workspace cache: bug live, history scrubbed,
 *  deps installed, hidden tests extracted. Idempotent. */
function prepTask(task: RealTask): void {
  const cache = join(CACHE_DIR, task.id);
  const marker = join(cache, ".vs-real-ready");
  if (existsSync(marker)) return;
  console.error(`[vs-real] prep ${task.id} (${task.repo})…`);
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });

  let r = sh(["git", "init", "-q", "."], cache);
  r = sh(
    ["git", "fetch", "-q", "--depth", "2", `https://github.com/${task.repo}.git`, task.mergeSha],
    cache,
  );
  if (r.code !== 0) throw new Error(`fetch failed for ${task.id}: ${r.out.slice(-400)}`);

  // Extract the hidden tests from the FIX before the fix ceases to exist here.
  sh(["git", "checkout", "-q", task.mergeSha], cache);
  for (const f of task.testFiles) {
    const dest = join(HIDDEN_DIR, task.id, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(cache, f)));
  }

  // Pre-fix state, then scrub history: a single baseline commit is all the
  // agent may see — `git log`/`git diff` must not be able to reveal the fix.
  r = sh(["git", "checkout", "-q", `${task.mergeSha}^`], cache);
  if (r.code !== 0) throw new Error(`checkout base failed for ${task.id}`);
  rmSync(join(cache, ".git"), { recursive: true, force: true });
  sh(["git", "init", "-q", "-b", "main", "."], cache);
  sh(["git", "add", "-A"], cache);
  sh(
    ["git", "-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-q", "-m", "baseline"],
    cache,
  );

  console.error(`[vs-real]   install: ${task.install.join(" ")}`);
  r = sh(task.install, cache, 900_000);
  if (r.code !== 0) throw new Error(`install failed for ${task.id}: ${r.out.slice(-400)}`);
  writeFileSync(marker, new Date().toISOString());
  console.error(`[vs-real]   ${task.id} ready`);
}

/** APFS clonefile copy — node_modules included, near-instant, symlink-safe. */
function copyWorkspace(task: RealTask, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  const r = sh(["cp", "-cR", join(CACHE_DIR, task.id), dest], tmpdir());
  if (r.code !== 0) {
    // Non-APFS fallback.
    cpSync(join(CACHE_DIR, task.id), dest, { recursive: true, verbatimSymlinks: true });
  }
  rmSync(join(dest, ".vs-real-ready"), { force: true });
}

/** The official runs pre-warm Empryo's genome index from source and report it
 *  separately (prewarmMs in the results). The portable harness has no source
 *  access, so indexing happens inside the timed run — Empryo's wall-clock here
 *  is slightly WORSE than the official methodology, never better. */
async function prewarmGenome(_dir: string): Promise<number> {
  return 0;
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
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ANTHROPIC_API_KEY: key } },
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

async function runPi(
  dir: string,
  prompt: string,
  model: string,
  extraArgs: string[] = [],
): Promise<Partial<Row>> {
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

  let messages: {
    role: string;
    content?: { type: string }[];
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } };
  }[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "agent_end" && Array.isArray(evt.messages)) messages = evt.messages;
    } catch {
      // non-JSON noise — ignore
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

/** Drop the fix PR's tests over the workspace and run them. The PR's test
 *  file = the module's pre-existing cases + the new regression cases, so a
 *  pass simultaneously proves the fix works and the module didn't regress. */
function verify(dir: string, task: RealTask): { pass: boolean; reason?: string } {
  for (const f of task.testFiles) {
    const src = join(HIDDEN_DIR, task.id, f);
    const dest = join(dir, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
  }
  const testDir = task.testCwd ? join(dir, task.testCwd) : dir;
  const relTests = task.testFiles.map((f) =>
    task.testCwd && f.startsWith(`${task.testCwd}/`) ? f.slice(task.testCwd.length + 1) : f,
  );
  const r = sh([...task.testCmd, ...relTests], testDir, 600_000);
  if (r.code !== 0) return { pass: false, reason: `acceptance: ${r.out.slice(-260)}` };
  return { pass: true };
}

async function main(): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(HIDDEN_DIR, { recursive: true });
  for (const task of tasks) prepTask(task);
  if (has("prep-only")) {
    console.error("[vs-real] prep complete");
    return;
  }

  const rows: Row[] = [];
  let spent = 0;
  const agentFilter = (arg("agents")?.split(",") ?? ["empryo", "pi"]) as ("empryo" | "pi")[];

  for (const tier of tiers) {
    for (const task of tasks) {
      for (const agent of agentFilter) {
        if (spent >= budgetStop) {
          rows.push({
            task: task.id, agent, tier, model: TIER_MODELS[tier]?.[agent] ?? "",
            pass: false, reason: "skipped: budget stop",
            tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
            cost: 0, steps: 0, toolCalls: 0, durationMs: 0, skipped: true,
          });
          continue;
        }
        const model = TIER_MODELS[tier]?.[agent];
        if (!model) continue;
        const dir = join(tmpdir(), `vsr-${label}-${tier}-${task.id}-${agent}`);
        copyWorkspace(task, dir);
        let prewarmMs: number | undefined;
        if (agent === "empryo") prewarmMs = await prewarmGenome(dir);
        console.error(`[vs-real] ▶ ${tier} · ${task.id} · ${agent}`);
        const run =
          agent === "empryo"
            ? await runEmpryo(dir, task.prompt, model)
            : await runPi(dir, task.prompt, model, TIER_MODELS[tier]?.piExtraArgs ?? []);
        const verdict =
          run.error && !run.steps
            ? { pass: false, reason: `agent did not run: ${run.error}` }
            : verify(dir, task);
        const row: Row = {
          task: task.id, agent, tier, model,
          pass: verdict.pass, reason: verdict.reason,
          tokensIn: run.tokensIn ?? 0, tokensOut: run.tokensOut ?? 0,
          cacheRead: run.cacheRead ?? 0, cacheWrite: run.cacheWrite ?? 0,
          cost: run.cost ?? 0, steps: run.steps ?? 0, toolCalls: run.toolCalls ?? 0,
          durationMs: run.durationMs ?? 0, prewarmMs, error: run.error,
        };
        rows.push(row);
        spent += row.cost;
        console.error(
          `[vs-real] ${row.pass ? "✓" : "✗"} ${tier} · ${task.id} · ${agent} — $${row.cost.toFixed(4)}, ${row.steps} steps, ${(row.durationMs / 1000).toFixed(1)}s (total spent $${spent.toFixed(2)})${row.reason ? ` — ${String(row.reason).slice(0, 120)}` : ""}`,
        );
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  const outPath = join(RESULTS_DIR, `${label}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ label, when: new Date().toISOString(), tiers, budgetStop, spent, rows }, null, 2),
  );
  console.error(`[vs-real] done — spent $${spent.toFixed(2)}, results at ${outPath}`);
}

await main();
