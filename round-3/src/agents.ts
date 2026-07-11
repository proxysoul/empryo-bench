/**
 * Agent adapters — one per harness, all driven the same way:
 * same prompt, same model, same workspace, non-interactive, auto-approve.
 *
 * Each adapter returns the agent's SELF-REPORTED numbers; the metering proxy
 * (proxy.ts) independently records what actually hit the API.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, MarionetteReport, TokenCounts } from "./types.ts";
import { ZERO_TOKENS } from "./types.ts";

export interface AgentRunResult {
  reportedCost: number;
  reportedTokens: TokenCounts;
  steps: number;
  toolCalls: number;
  durationMs: number;
  /** Marionette pre-pass receipt (empryo-marionette only). */
  marionette?: MarionetteReport;
  error?: string;
  toolsUsed?: string[];
  filesEdited?: string[];
  output?: string;
}

export interface AgentContext {
  dir: string;
  prompt: string;
  /** Bare Anthropic model id, e.g. claude-sonnet-4-6. */
  model: string;
  apiKey: string;
  /** Metering proxy base url (http://127.0.0.1:PORT) — empty disables wiring. */
  proxyUrl: string;
  timeoutMs: number;
  /** Reasoning effort for the MAIN agent, e.g. `high`. Every harness spells it
   *  differently — empryo `--effort`, claude code `--effort`, opencode
   *  `--variant`, pi `--thinking` — so it is normalised here and translated
   *  per adapter. Empty = each agent's own default. */
  effort: string;
}

interface Spawned {
  out: string;
  err: string;
  code: number;
  durationMs: number;
}

async function spawn(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Spawned> {
  const started = Date.now();
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1", ...env },
  });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { out, err, code: proc.exitCode ?? 1, durationMs: Date.now() - started };
}

function fail(r: Spawned, what: string): AgentRunResult {
  return {
    reportedCost: 0,
    reportedTokens: { ...ZERO_TOKENS },
    steps: 0,
    toolCalls: 0,
    durationMs: r.durationMs,
    error: `${what}: exit=${r.code} ${r.err.slice(-300) || r.out.slice(-300)}`,
  };
}

// ── empryo ──────────────────────────────────────────────────────────────────

/** Pre-pass model for the marionette variant — deliberately cheap: the point of
 *  the A/B is whether a small model compiling the prompt pays for itself.
 *  Per-lane: the pre-pass must ride the SAME provider as the main model or the
 *  lane's key can't pay for it ("openai/claude-haiku-4-5" is not a model). */
const MARIONETTE_MODEL_BY_LANE: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.6-luna",
};

/** A bare model id runs on the anthropic lane; a provider-qualified one
 *  (e.g. `proxy/claude-haiku-4-5-…`) is passed through untouched. */
function qualify(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}

async function runEmpryoWith(ctx: AgentContext, marionette: boolean): Promise<AgentRunResult> {
  const modelId = qualify(ctx.model);
  const lane = modelId.slice(0, modelId.indexOf("/"));
  const empryoBin = process.env.EMPRYO_BIN || "empryo";
  const projectConfig = process.env.EMPRYO_PROJECT_CONFIG;
  if (projectConfig) {
    const configDir = join(ctx.dir, ".empryo");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    if (!existsSync(configPath)) writeFileSync(configPath, `${projectConfig}\n`);
  }
  const r = await spawn(
    [
      empryoBin, "--headless", ctx.prompt, "--json", "--quiet", "--mode", "auto",
      "--model", modelId,
      "--max-steps", "150", // high ceiling: the 480s timeout is the binding limit, same as every other agent
      ...(ctx.effort ? ["--effort", ctx.effort] : []),
      ...(marionette
        ? [
            "--marionette-mode",
            "fast",
            "--marionette-model",
            `${lane}/${MARIONETTE_MODEL_BY_LANE[lane] ?? "claude-haiku-4-5"}`,
          ]
        : []),
      "--timeout", String(ctx.timeoutMs), "--cwd", ctx.dir,
    ],
    ctx.dir,
    {
      // Key goes to the env var the model's OWN provider reads. Handing an
      // OpenAI key to ANTHROPIC_API_KEY fails as "Incorrect API key provided"
      // in 0.4s, which the harness would record as "agent did not run" for the
      // entire GPT leg. The metering proxy speaks the Anthropic wire only, so
      // non-Anthropic lanes go direct and report self-measured cost.
      ...(lane === "openai"
        ? { OPENAI_API_KEY: ctx.apiKey || undefined }
        : {
            ANTHROPIC_API_KEY: ctx.apiKey || undefined,
            ANTHROPIC_BASE_URL: ctx.proxyUrl || undefined,
          }),
      // Sterile home: the engine resolves ~/.empryo via $HOME, so without this
      // every bench prompt inherits the operator's PERSONAL state — memory
      // auto-recall stubs, the installed-skills catalog (2.2KB in a captured
      // request body) and ~/.empryo/instructions.md, plus a synthetic
      // ack-turn pair. Machine-specific, unreproducible, and an unfair delta
      // vs baselines that run bare. BENCH_STERILE_HOME must be pre-hydrated
      // once (`HOME=<dir> empryo doctor`) so native libs resolve. pi keeps the
      // real HOME — the baseline runs as shipped.
      HOME: process.env.BENCH_STERILE_HOME || undefined,
      EMPRYO_E2E: "1",
    },
    ctx.timeoutMs + 60_000,
  );
  try {
    const j = JSON.parse(r.out);
    return {
      reportedCost: j.cost ?? 0,
      reportedTokens: {
        input: j.tokens?.input ?? 0,
        output: j.tokens?.output ?? 0,
        cacheRead: j.tokens?.cacheRead ?? 0,
        cacheWrite: j.tokens?.cacheWrite ?? 0,
      },
      steps: j.steps ?? 0,
      // `--json` reports the pre-pass separately (lane, its own model, its own
      // cost) — record it so a degraded `fast` → index-only lane is visible in
      // the results instead of hiding behind an unchanged total.
      marionette: j.marionette,
      toolCalls: Array.isArray(j.toolCalls) ? j.toolCalls.length : (j.toolCalls ?? 0),
      toolsUsed: Array.isArray(j.toolCalls)
        ? j.toolCalls.filter((name: unknown): name is string => typeof name === "string")
        : undefined,
      filesEdited: Array.isArray(j.filesEdited)
        ? j.filesEdited.filter((path: unknown): path is string => typeof path === "string")
        : undefined,
      output: typeof j.output === "string" ? j.output : undefined,
      durationMs: j.duration ?? r.durationMs,
      error: j.error,
    };
  } catch {
    return fail(r, "empryo: unparseable json");
  }
}

// ── pi ──────────────────────────────────────────────────────────────────────

async function runPi(ctx: AgentContext): Promise<AgentRunResult> {
  // Lane-aware: the model id carries the provider ("openai/gpt-5.6-terra"), and
  // pi wants them as separate flags. Hardcoding anthropic here silently sent
  // an OpenAI model id to the Anthropic provider — which fails as an auth
  // error, i.e. it would have scored as "pi did not run" on the entire GPT leg.
  const slash = ctx.model.indexOf("/");
  const provider = slash > 0 ? ctx.model.slice(0, slash) : "anthropic";
  const bareModel = slash > 0 ? ctx.model.slice(slash + 1) : ctx.model;
  const r = await spawn(
    [
      "pi", "--provider", provider, "--model", bareModel, "--api-key", ctx.apiKey,
      ...(ctx.effort ? ["--thinking", ctx.effort] : []),
      "--no-session", "-p", "--mode", "json", ctx.prompt,
    ],
    ctx.dir,
    { ANTHROPIC_BASE_URL: ctx.proxyUrl || undefined },
    ctx.timeoutMs + 60_000,
  );
  interface PiMsg {
    role: string;
    content?: Array<{ type: string; name?: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost?: { total: number };
    };
  }
  let messages: PiMsg[] = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "agent_end" && Array.isArray(evt.messages)) messages = evt.messages;
    } catch {
      // non-JSON noise
    }
  }
  if (messages.length === 0) return fail(r, "pi: no agent_end event");
  // A dead key still produces an agent_end with one errored assistant message
  // (zero usage, stopReason "error"). That is "did not run", not a wrong
  // answer — without this check it records as an acceptance failure.
  const errored = messages.filter((m) => m.role === "assistant" && m.stopReason === "error");
  const worked = messages.some(
    (m) => m.role === "assistant" && m.stopReason !== "error" && (m.usage?.output ?? 0) > 0,
  );
  if (errored.length > 0 && !worked) {
    return fail(r, `pi: ${errored[errored.length - 1]?.errorMessage ?? "agent errored"}`);
  }
  const t: TokenCounts = { ...ZERO_TOKENS };
  let cost = 0;
  let toolCalls = 0;
  const toolsUsed: string[] = [];
  const assistants = messages.filter((m) => m.role === "assistant");
  for (const m of assistants) {
    t.input += m.usage?.input ?? 0;
    t.output += m.usage?.output ?? 0;
    t.cacheRead += m.usage?.cacheRead ?? 0;
    t.cacheWrite += m.usage?.cacheWrite ?? 0;
    cost += m.usage?.cost?.total ?? 0;
    for (const content of m.content ?? []) {
      if (content.type !== "toolCall") continue;
      toolCalls++;
      if (typeof content.name === "string") toolsUsed.push(content.name);
    }
  }
  return {
    reportedCost: cost,
    reportedTokens: t,
    steps: assistants.length,
    toolCalls,
    toolsUsed,
    output: assistants
      .flatMap((message) => message.content ?? [])
      .filter((content) => content.type === "text" && typeof content.text === "string")
      .map((content) => content.text)
      .join("\n"),
    durationMs: r.durationMs,
  };
}

// ── opencode ────────────────────────────────────────────────────────────────

async function runOpencode(ctx: AgentContext): Promise<AgentRunResult> {
  // opencode does NOT read ANTHROPIC_API_KEY from the environment — it resolves
  // credentials from its own auth store, so a bench key has to be handed to the
  // provider explicitly or every run dies on a 401 in ~2s. `{env:…}` keeps the
  // secret out of the workspace file; opencode expands it at load.
  const options: Record<string, string> = {};
  if (ctx.proxyUrl) options.baseURL = `${ctx.proxyUrl}/v1`;
  if (ctx.apiKey) options.apiKey = "{env:ANTHROPIC_API_KEY}";
  if (Object.keys(options).length > 0) {
    writeFileSync(
      join(ctx.dir, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          provider: { anthropic: { options } },
        },
        null,
        2,
      ),
    );
  }
  const r = await spawn(
    [
      "opencode", "run", ctx.prompt, "-m", `anthropic/${ctx.model}`,
      ...(ctx.effort ? ["--variant", ctx.effort] : []),
      "--format", "json", "--auto", "--dir", ctx.dir,
    ],
    ctx.dir,
    { ANTHROPIC_API_KEY: ctx.apiKey || undefined },
    ctx.timeoutMs + 60_000,
  );
  // The json format is a raw event stream; assistant message snapshots carry
  // cumulative {tokens, cost}. Dedupe by message id, last snapshot wins.
  const byId = new Map<string, { tokens: TokenCounts; cost: number }>();
  const toolIds = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const o = node as Record<string, unknown>;
    const tok = o.tokens as
      | { input?: number; output?: number; cache?: { read?: number; write?: number } }
      | undefined;
    if (tok && typeof tok.input === "number" && (o.role === undefined || o.role === "assistant")) {
      const id = String(o.id ?? `anon-${byId.size}`);
      byId.set(id, {
        tokens: {
          input: tok.input ?? 0,
          output: tok.output ?? 0,
          cacheRead: tok.cache?.read ?? 0,
          cacheWrite: tok.cache?.write ?? 0,
        },
        cost: typeof o.cost === "number" ? o.cost : 0,
      });
    }
    // Tool parts are re-emitted on every state update — dedupe by part id.
    if (o.type === "tool") toolIds.add(String(o.id ?? o.callID ?? `t${toolIds.size}`));
    for (const v of Object.values(o)) visit(v);
  };
  let sawJson = false;
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
      sawJson = true;
    } catch {
      // non-JSON noise
    }
  }
  if (!sawJson) return fail(r, "opencode: no json events");
  // JSON came back but not a single assistant message: the run never reached
  // the model (auth/provider error). Report it as "did not run" instead of a
  // silent $0 zero-step failure that reads like a wrong answer.
  if (byId.size === 0) return fail(r, "opencode: no assistant messages");
  const t: TokenCounts = { ...ZERO_TOKENS };
  let cost = 0;
  for (const m of byId.values()) {
    t.input += m.tokens.input;
    t.output += m.tokens.output;
    t.cacheRead += m.tokens.cacheRead;
    t.cacheWrite += m.tokens.cacheWrite;
    cost += m.cost;
  }
  return {
    reportedCost: cost,
    reportedTokens: t,
    steps: byId.size,
    toolCalls: toolIds.size,
    durationMs: r.durationMs,
  };
}

// ── claude code ─────────────────────────────────────────────────────────────

async function runClaude(ctx: AgentContext): Promise<AgentRunResult> {
  const r = await spawn(
    [
      "claude", "-p", ctx.prompt, "--output-format", "json", "--model", ctx.model,
      ...(ctx.effort ? ["--effort", ctx.effort] : []),
      "--dangerously-skip-permissions", "--strict-mcp-config",
    ],
    ctx.dir,
    {
      ANTHROPIC_API_KEY: ctx.apiKey || undefined,
      ANTHROPIC_BASE_URL: ctx.proxyUrl || undefined,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    ctx.timeoutMs + 60_000,
  );
  try {
    // stdout is a single JSON result object (possibly preceded by noise lines).
    const start = r.out.indexOf("{");
    const j = JSON.parse(r.out.slice(start));
    const u = j.usage ?? {};
    return {
      reportedCost: j.total_cost_usd ?? 0,
      reportedTokens: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      steps: j.num_turns ?? 0,
      toolCalls: 0, // not exposed in the result payload
      durationMs: j.duration_ms ?? r.durationMs,
      error: j.is_error ? String(j.result ?? "claude reported error") : undefined,
    };
  } catch {
    return fail(r, "claude: unparseable json");
  }
}

// ── registry ────────────────────────────────────────────────────────────────

export const AGENTS: Record<
  AgentId,
  { label: string; run: (ctx: AgentContext) => Promise<AgentRunResult> }
> = {
  empryo: { label: "Empryo", run: (ctx) => runEmpryoWith(ctx, false) },
  "empryo-marionette": {
    label: "Empryo + Marionette",
    run: (ctx) => runEmpryoWith(ctx, true),
  },
  pi: { label: "pi", run: runPi },
  opencode: { label: "opencode", run: runOpencode },
  claude: { label: "Claude Code", run: runClaude },
}

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];
