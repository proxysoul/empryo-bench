/** One adapter per harness under test. `empryo-marionette` is the same binary
 *  with the marionette pre-pass on — an A/B of the feature, not a 5th product. */
export type AgentId = "empryo" | "empryo-marionette" | "pi" | "opencode" | "claude";

export interface Task {
  id: string;
  difficulty: "easy" | "hard";
  title: string;
  /** owner/name on GitHub. */
  repo: string;
  /** Merge commit of the real fix PR. Agents run at `mergeSha^` (bug live). */
  mergeSha: string;
  /** Test files shipped BY the fix PR — held out, dropped in after the run. */
  testFiles: string[];
  /** Files the real fix touched (recorded for the judge; never shown to agents). */
  srcFiles: string[];
  install: string[];
  /** Command that runs ONLY the hidden test files (paths appended). */
  testCmd: string[];
  testCwd?: string;
  /** Bug report given to the agent — verbatim issue text, no file hints. */
  prompt: string;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface QualityScore {
  score: number; // 0-10
  rationale: string;
  judgeModel: string;
}

export interface RunRecord {
  agent: AgentId;
  task: string;
  rep: number;
  model: string;
  /** Effort the main agent ran at, as passed to that harness's own flag. */
  effort?: string;
  /** ISO timestamp of when this run started. */
  startedAt?: string;
  pass: boolean;
  reason?: string;
  durationMs: number;
  /** True when this run shared the machine with other agents (`--parallel`).
   *  Cost and correctness stay exact; WALL TIME does not — never mix contended
   *  and serial durations in one timing claim. */
  contended?: boolean;
  /** What the agent itself claims it spent. */
  reportedCost: number;
  reportedTokens: TokenCounts;
  /** What the metering proxy actually saw on the wire (null = agent bypassed proxy). */
  realCost: number | null;
  realTokens: TokenCounts | null;
  realRequests: number;
  /** Wire usage split per upstream model id — makes a bench reconcilable
   *  against the provider's own per-model billing lines. */
  realByModel?: Record<string, TokenCounts & { cost: number; requests: number }>;
  steps: number;
  /** Present only for the marionette variant. */
  marionette?: MarionetteReport;
  toolCalls: number;
  /** Ordered tool names reported by the harness, when available. */
  toolsUsed?: string[];
  /** Files the harness reports editing, when available. */
  filesEdited?: string[];
  /** Final assistant output, for output-token/verbosity analysis. */
  output?: string;
  /** Unified diff the agent produced in the workspace. */
  diff: string;
  quality?: QualityScore | null;
  /** Manual verification of the agent's src fix against the real upstream PR. */
  fixVerdict?: { verdict: "exact" | "equivalent" | "divergent"; note: string } | null;
  /** Work-product metrics parsed from the diff (what pass/fail cannot see). */
  work?: { filesTouched: number; srcLinesChanged: number; testLinesAdded: number };
  error?: string;
}

export interface BenchResults {
  /** Bump when the shape changes — webapp consumers key on this. */
  schemaVersion?: number;
  /** Round-level context rendered as a callout in the report (methodology caveats, playfield notes). */
  note?: string;
  label: string;
  when: string;
  model: string;
  /** Reasoning effort every main agent ran at (`high`, …). Absent = defaults. */
  effort?: string;
  repeats: number;
  agents: AgentId[];
  tasks: { id: string; difficulty: "easy" | "hard"; title: string; repo: string }[];
  runs: RunRecord[];
  env?: BenchEnv;
  /** True for fabricated sample data (report renders a DEMO watermark). */
  demo?: boolean;
}

export const SCHEMA_VERSION = 1;

export interface BenchEnv {
  os: string;
  arch: string;
  bun: string;
  /** `<agent> --version` output at run time. */
  agentVersions: Partial<Record<AgentId, string>>;
  /** Which API key each agent ran on — `…last4/sha256-8`, never the key.
   *  One key per agent makes the provider's own usage page the third
   *  independent cost source, per agent. "(shared)" = fell back to the
   *  common bench key, so provider-side spend is NOT separable. */
  agentKeys?: Partial<Record<AgentId, string>>;
  /** Non-secret experiment flags that identify the binary/config lane. */
  variant?: Record<string, string>;
}

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Marionette pre-pass receipt, as reported by `empryo --headless --json`.
 *  `degradedFrom` set = the requested lane failed and index-only ran instead
 *  (its tokens were still billed) — an A/B row with it set is NOT a fast-lane
 *  measurement. */
export interface MarionetteReport {
  lane: string;
  model: string;
  cost: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite?: number };
  durationMs: number;
  lookups?: number;
  degradedFrom?: string;
  error?: string;
}
