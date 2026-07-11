/**
 * bench-soul orchestrator — 4 coding agents, same model, real merged bugs,
 * N repeats, median-aggregated.
 *
 * Usage:
 *   BENCH_ANTHROPIC_KEY=sk-... bun src/run.ts \
 *     [--label soul-1] [--agents empryo,pi,opencode,claude] [--tasks all|id,..]
 *     [--reps 3] [--model claude-sonnet-4-6] [--budget-stop 30]
 *     [--cooldown 0] [--no-cache-bust] [--no-proxy] [--prep-only] [--resume]
 *
 * Prompt-cache hygiene (Anthropic 5-minute TTL):
 *  - PRIMARY: one Anthropic workspace (and key) per agent. Anthropic isolates
 *    the cache per workspace, so a cross-agent cache hit is impossible rather
 *    than merely unlikely — this replaces the cooldown, which is why the
 *    default is now 0
 *  - run order is rep → task → agent, so the same (agent, task) pair never
 *    repeats back-to-back
 *  - every run also prepends a unique nonce line to the task prompt
 *    (--no-cache-bust disables) — free, and the only thing still guarding a
 *    rep from riding the SAME agent's own warm prefix inside its workspace
 *  - --cooldown <seconds> is still there for a single-workspace setup
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, AGENTS, type AgentContext } from "./agents.ts";
import { copyWorkspace, prepTask, ROOT, sh, verify } from "./prep.ts";
import { startMeter } from "./proxy.ts";
import { fmtSecs, fmtUsd } from "./stats.ts";
import { TASKS } from "./tasks.ts";
import { SCHEMA_VERSION, type AgentId, type BenchResults, type RunRecord } from "./types.ts";
import { writeManifest } from "./aggregate.ts";
import { createHash } from "node:crypto";

const RESULTS_DIR = join(ROOT, "results");

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const label = arg("label") ?? `soul-${new Date().toISOString().slice(0, 10)}`;
const model = arg("model") ?? "claude-opus-5";
/** Reasoning effort for the MAIN agent of every harness — one knob, translated
 *  per adapter (empryo/claude `--effort`, opencode `--variant`, pi
 *  `--thinking`). Empty string = each agent's own default. */
const effort = arg("effort") ?? "";
const repeats = Number(arg("reps") ?? 2);
const budgetStop = Number(arg("budget-stop") ?? 30);
/** Off by default: with one Anthropic WORKSPACE per agent the prompt cache is
 *  isolated by the provider, so no agent can ride another's warm prefix. Set
 *  `--cooldown 300` when every agent shares one workspace/key. */
const cooldownMs = Number(arg("cooldown") ?? 0) * 1000;
const cacheBust = !has("no-cache-bust");
/** Run the AGENTS of a task concurrently (tasks stay sequential). Costs stay
 *  exact — the proxy meters per API key — but wall time is contended, so those
 *  rows are marked and excluded from timing claims. */
const parallel = has("parallel");
/** Shared per-run agent timeout — the binding limit for every harness. */
const RUN_TIMEOUT_MS = Number(arg("run-timeout") ?? 480) * 1000;
const useProxy = !has("no-proxy");
const agents = (arg("agents")?.split(",") ?? AGENT_IDS).filter((a) =>
  AGENT_IDS.includes(a as AgentId),
) as AgentId[];
const taskFilter = arg("tasks");
const tasks =
  !taskFilter || taskFilter === "all"
    ? TASKS
    : TASKS.filter((t) => taskFilter.split(",").includes(t.id));

/** git diff of everything the agent changed, harness artifacts excluded. */
function captureDiff(dir: string): string {
  sh(["git", "add", "-N", "."], dir);
  const r = sh(
    [
      "git", "diff", "--",
      ".",
      ":(exclude)opencode.json",
      ":(exclude).empryo",
      ":(exclude).claude",
      ":(exclude).opencode",
      ":(exclude).pi",
      ":(exclude)node_modules",
    ],
    dir,
  );
  return r.out.trim();
}

async function main(): Promise<void> {
  const keys = Object.fromEntries(
    agents.map((a) => [a, resolveAgentKey(a)]),
  ) as Record<AgentId, { key: string; dedicated: boolean }>;
  const missing = agents.filter((a) => !keys[a].key);
  if (missing.length > 0 && !has("prep-only")) {
    if (has("allow-agent-keys")) {
      // Serial mode only: the shared tally is flushed between runs, so an
      // agent on its own stored key still meters correctly. In parallel mode
      // an unbound agent's requests would land in the shared tally while
      // runOne reads flushLane(agent) — spend silently lost/misattributed.
      if (parallel) {
        console.error(
          `[run] --parallel cannot meter agents without a bench key: ${missing.join(", ")} — ` +
            "lanes are keyed by API key, and an agent on its own stored key never binds one. " +
            "Give each agent a dedicated key, or drop --parallel.",
        );
        process.exit(1);
      }
      console.error(
        `[run] no key for ${missing.join(", ")} — those agents fall back to their own stored keys ` +
          "(wire metering still works in serial mode; provider-side attribution is fuzzier)",
      );
    } else {
      console.error(
        `missing API key for: ${missing.map((a) => `${a} (${keyEnvName(a)})`).join(", ")}\n` +
          "set a per-agent key, or BENCH_ANTHROPIC_KEY for all of them (--allow-agent-keys to bypass)",
      );
      process.exit(1);
    }
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  for (const task of tasks) prepTask(task);
  if (has("prep-only")) {
    console.error("[run] prep complete — no benchmarks executed");
    return;
  }

  // Per-request wire log: the audit trail that makes a bench reconcilable
  // against the provider's billing page after the fact.
  const wireLog = join(RESULTS_DIR, `${label}.wire.jsonl`);
  const meter = useProxy ? startMeter(0, wireLog) : null;
  if (meter) console.error(`[run] metering proxy on ${meter.url} — wire log ${wireLog}`);
  // Bind each agent's key to its own metering lane so concurrent runs stay
  // attributable. Agents sharing a key cannot be told apart — refuse rather
  // than silently merge their spend.
  if (meter && parallel) {
    const seen = new Map<string, AgentId>();
    for (const a of agents) {
      const k = keys[a].key;
      const other = seen.get(k);
      if (k && other) {
        console.error(
          `[run] --parallel needs one key per agent: ${a} and ${other} share one — ` +
            "their wire cost would be indistinguishable",
        );
        process.exit(1);
      }
      if (k) {
        seen.set(k, a);
        meter.bind(a, k);
      }
    }
  }

  const agentVersions = Object.fromEntries(
    agents.map((a) => [a, agentVersion(a)]),
  );
  console.error(`[run] agent versions: ${JSON.stringify(agentVersions)}`);

  // Recorded so a results file can be reconciled against per-key billing
  // months later — fingerprints only, never the keys.
  const agentKeys = Object.fromEntries(
    agents.map((a) => [
      a,
      `${keyFingerprint(keys[a].key)}${keys[a].dedicated ? "" : " (shared)"}`,
    ]),
  );
  const dedicated = agents.filter((a) => keys[a].dedicated);
  console.error(
    `[run] keys: ${dedicated.length}/${agents.length} dedicated — ${JSON.stringify(agentKeys)}`,
  );

  const results: BenchResults = {
    schemaVersion: SCHEMA_VERSION,
    label,
    when: new Date().toISOString(),
      model,
      effort: effort || undefined,
      repeats,
    agents,
    tasks: tasks.map((t) => ({ id: t.id, difficulty: t.difficulty, title: t.title, repo: t.repo })),
    runs: [],
    env: {
      os: `${process.platform} ${(await import("node:os")).release()}`,
      arch: process.arch,
      bun: Bun.version,
      agentVersions,
        agentKeys,
        variant: Object.fromEntries(
          Object.entries(process.env)
            .filter(
              ([key, value]) =>
                value != null &&
                (key.startsWith("EMPRYO_LEAN_") ||
                  key === "EMPRYO_REQUEST_CORE" ||
                  key === "EMPRYO_GENOME_BUDGET" ||
                  key === "EMPRYO_BIN" ||
                  key === "EMPRYO_PROJECT_CONFIG"),
            )
            .map(([key, value]) => [
              key,
              key === "EMPRYO_PROJECT_CONFIG" ? "set" : String(value),
            ]),
        ),
      },
  };
  const outPath = join(RESULTS_DIR, `${label}.json`);
  // --resume picks a crashed/killed run back up: completed (agent, task, rep)
  // triples are kept and skipped, so hours of paid work survive a laptop sleep,
  // an agent that wedges, or a Ctrl-C. Without it, an existing label is refused.
  const resuming = has("resume") && existsSync(outPath);
  if (existsSync(outPath) && !resuming) {
    console.error(`[run] refusing to overwrite ${outPath} — pick another --label (or --resume)`);
    process.exit(1);
  }
  if (resuming) {
    const prior = JSON.parse(readFileSync(outPath, "utf8")) as BenchResults;
    results.runs = prior.runs ?? [];
    results.when = prior.when ?? results.when;
    console.error(`[run] resuming ${label} — ${results.runs.length} run(s) already recorded`);
  }
  const done = new Set(results.runs.map((r) => `${r.agent}|${r.task}|${r.rep}`));
  const save = () => {
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    writeManifest(RESULTS_DIR);
  };

  // Resumed runs count against the budget: the money is already spent.
  let spent = results.runs.reduce((s, r) => s + (r.realCost ?? r.reportedCost), 0);
  const lastFinished: Partial<Record<AgentId, number>> = {};

  /** One (agent, task, rep) run, start to recorded row. In parallel mode the
   *  agents of a task run as concurrent copies of this. */
  const runOne = async (agent: AgentId, task: (typeof tasks)[number], rep: number) => {
    const dir = join(tmpdir(), `soul-${label}-${task.id}-${agent}-r${rep}`);
    copyWorkspace(task, dir);
    // Serial mode meters into the shared tally; parallel mode meters per lane,
    // keyed by the agent's own API key (see meter.bind).
    if (!parallel) meter?.flush();

    const prompt = cacheBust
      ? `[bench run ${crypto.randomUUID().slice(0, 8)} — ignore this tag]\n\n${task.prompt}`
      : task.prompt;
    const startedAt = new Date().toISOString();
    console.error(
      `[run] ▶ rep${rep} · ${task.id} · ${agent}${effort ? ` · effort ${effort}` : ""}`,
    );
    const ctx: AgentContext = {
      dir,
      prompt,
      model,
      apiKey: keys[agent].key,
      proxyUrl: meter?.url ?? "",
      timeoutMs: RUN_TIMEOUT_MS,
      effort,
    };
    const run = await AGENTS[agent].run(ctx);
    const wire = parallel ? (meter?.flushLane(agent) ?? null) : (meter?.flush() ?? null);
    lastFinished[agent] = Date.now();

    const diff = captureDiff(dir);
    // "Did not run" = errored with nothing to show (no steps, or no code
    // change). claude's auth-retry loop reports num_turns:1 with an empty
    // diff — without the diff clause that misclassifies as a wrong answer.
    // An agent that errored AFTER producing a diff still gets verified.
    const verdict =
      run.error && (run.steps === 0 || !diff.trim())
        ? { pass: false, reason: `agent did not run: ${run.error}` }
        : verify(dir, task);

    const row: RunRecord = {
      agent,
      task: task.id,
      rep,
      model,
      ...(effort ? { effort } : {}),
      startedAt,
      pass: verdict.pass,
      reason: verdict.reason,
      durationMs: run.durationMs,
      // Wall time under contention is NOT comparable to a serial run's.
      ...(parallel ? { contended: true } : {}),
      reportedCost: run.reportedCost,
      reportedTokens: run.reportedTokens,
      realCost: wire && wire.requests > 0 ? wire.cost : null,
      realTokens: wire && wire.requests > 0 ? wire.tokens : null,
      realRequests: wire?.requests ?? 0,
      realByModel: wire && wire.requests > 0 ? wire.byModel : undefined,
      steps: run.steps,
      ...(run.marionette ? { marionette: run.marionette } : {}),
      toolCalls: run.toolCalls,
        ...(run.toolsUsed ? { toolsUsed: run.toolsUsed } : {}),
        ...(run.filesEdited ? { filesEdited: run.filesEdited } : {}),
        ...(run.output != null ? { output: run.output } : {}),
      diff,
      quality: null,
      error: scrubIds(run.error),
    };
    results.runs.push(row);
    spent += row.realCost ?? row.reportedCost;
    save();
    console.error(
      `[run] ${row.pass ? "✓" : "✗"} rep${rep} · ${task.id} · ${agent} — ` +
        `${fmtSecs(row.durationMs)}, reported ${fmtUsd(row.reportedCost)}, ` +
        `wire ${fmtUsd(row.realCost)} (${row.realRequests} req) — total ${fmtUsd(spent)}` +
        `${row.reason ? ` — ${String(row.reason).slice(0, 100)}` : ""}`,
    );
    rmSync(dir, { recursive: true, force: true });
  };

  // rep → task → agent. Tasks stay sequential either way; --parallel runs the
  // AGENTS of one task at once, which is safe for cost (per-key metering, own
  // workspace, own temp clone) but not for wall time — those rows get
  // `contended: true` and the report stops claiming they are comparable.
  for (let rep = 1; rep <= repeats; rep++) {
    for (const task of tasks) {
      const pending = agents.filter((agent) => {
        if (done.has(`${agent}|${task.id}|${rep}`)) {
          console.error(`[run] ↷ skip rep${rep} · ${task.id} · ${agent} (already recorded)`);
          return false;
        }
        return true;
      });
      if (pending.length === 0) continue;

      if (spent >= budgetStop) {
        console.error(`[run] budget stop ($${spent.toFixed(2)} ≥ $${budgetStop}) — halting`);
        save();
        meter?.stop();
        return;
      }

      if (parallel) {
        console.error(`[run] ║ ${task.id} rep${rep}: ${pending.length} agents in parallel`);
        const settled = await Promise.allSettled(pending.map((a) => runOne(a, task, rep)));
        for (const [i, s] of settled.entries()) {
          if (s.status === "rejected") {
            console.error(`[run] ✗ ${pending[i]} threw: ${String(s.reason).slice(0, 200)}`);
          }
        }
        continue;
      }

      for (const agent of pending) {
        if (spent >= budgetStop) {
          console.error(`[run] budget stop ($${spent.toFixed(2)} ≥ $${budgetStop}) — halting`);
          save();
          meter?.stop();
          return;
        }
        // Only meaningful when agents share a workspace/key — default is 0.
        const since = Date.now() - (lastFinished[agent] ?? 0);
        if (cooldownMs > 0 && since < cooldownMs) {
          const wait = cooldownMs - since;
          console.error(`[run] cache cooldown: ${agent} idles ${Math.ceil(wait / 1000)}s`);
          await new Promise((r) => setTimeout(r, wait));
        }
        await runOne(agent, task, rep);
      }
    }
  }

  save();
  meter?.stop();
  console.error(`[run] done — spent ${fmtUsd(spent)}, results at ${outPath}`);
  console.error(`[run] next: bun src/judge.ts ${outPath} && bun src/report.ts ${outPath}`);
}

await main();
/** `<binary> --version`, last non-empty line — recorded into results.env.
 *  Agent ids are variants, not binaries: `empryo-marionette` is the empryo
 *  binary with the pre-pass on. */
function agentVersion(agent: AgentId): string {
  const bin = agent.startsWith("empryo") ? process.env.EMPRYO_BIN || "empryo" : agent;
  try {
    const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const lines = proc.stdout.toString().trim().split("\n").filter((l) => l.trim());
    return (lines[lines.length - 1] ?? "unknown").trim().slice(0, 60);
  } catch {
    return "unknown";
  }
}
/**
 * Per-agent API keys — one key per agent makes provider-side billing
 * attributable without a metering proxy at all: each agent's spend lands on
 * its own key's usage page. `BENCH_KEY_<AGENT>` (agent id uppercased, `-` →
 * `_`), falling back to the shared `BENCH_ANTHROPIC_KEY` / `ANTHROPIC_API_KEY`.
 *   BENCH_KEY_EMPRYO, BENCH_KEY_EMPRYO_MARIONETTE, BENCH_KEY_PI,
 *   BENCH_KEY_OPENCODE, BENCH_KEY_CLAUDE
 */
function keyEnvName(agent: AgentId): string {
  return `BENCH_KEY_${agent.toUpperCase().replace(/-/g, "_")}`;
}

function resolveAgentKey(agent: AgentId): { key: string; dedicated: boolean } {
  const own = process.env[keyEnvName(agent)];
  if (own) return { key: own, dedicated: true };
  return {
    key: process.env.BENCH_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    dedicated: false,
  };
}

/** Non-secret key identity for the results file: enough to match a run against
 *  a console usage page, useless to anyone who steals the JSON. */
function keyFingerprint(key: string): string {
  if (!key) return "none";
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `…${key.slice(-4)}/${hash}`;
}

/** Provider error bodies name the account (`in organization org-…`, `project proj_…`); results are published, so drop the ids. */
function scrubIds(text: string | undefined): string | undefined {
  return text?.replace(/\b(org|proj|acct|user)[-_][A-Za-z0-9]{16,}\b/g, "$1-REDACTED");
}
