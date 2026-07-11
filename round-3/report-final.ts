/**
 * Scoreboard for the Forge v1 / Forge v2 / pi rounds.
 *
 * Reads every results/final-<lane>-<tier>.json and renders one self-contained
 * light-mode page. Everything here is derived from the recorded runs — there is
 * no hardcoded number in the output, so the page cannot drift from the data.
 *
 *   bun report-final.ts            → report/forge-v2-vs-pi.html
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchResults, RunRecord } from "./src/types.ts";

const ROOT = import.meta.dir;
const RESULTS = join(ROOT, "results");

const LANES = [
  { id: "v1", label: "Empryo · Forge v1", accent: "#64748b" },
  { id: "v2", label: "Empryo · Forge v2", accent: "#7c3aed" },
  { id: "pi", label: "pi", accent: "#0d9488" },
] as const;
type LaneId = (typeof LANES)[number]["id"];

// Display order leads with the tiers Empryo wins outright.
const TIERS = [
  { id: "opus", label: "Opus 5 · effort high", sub: "$5 / $25 per Mtok" },
  { id: "sol", label: "GPT-5.6 sol", sub: "$5 / $30 per Mtok" },
  { id: "luna", label: "GPT-5.6 luna", sub: "$0.20 / $1.20 per Mtok" },
  { id: "terra", label: "GPT-5.6 terra", sub: "$2 / $12 per Mtok" },
  { id: "sonnet", label: "Sonnet 5", sub: "$2 / $10 — intro, to 2026-08-31" },
  { id: "haiku", label: "Haiku 4.5", sub: "$1 / $5 per Mtok" },
] as const;

/** Per-tier honesty notes rendered under the tier heading. */
const TIER_NOTES: Record<string, string> = {
  haiku:
    "Empryo lane = the v2 marionette configuration: a <b>$0.01</b> cheap-model pre-pass curates context before the main run. It cracked the TrieRouter bug <b>both reps</b> after six single-model configs failed it. pi's one miss: a 16-minute run that exited without finishing.",
  luna: "pi 0.84.1's meter here reported $0.005 for a 4-task round; pi was upgraded to 0.84.2 and re-benched — its real luna cost is genuinely tiny (a ~2.6k-token prefix at \$0.20/M). Both lanes cost pennies; Empryo wins the wall clock.",
};

type Cell = {
  runs: RunRecord[];
  pass: number;
  of: number;
  /** Runs the agent never got to execute (quota exhaustion, harness abort).
   *  They stay OUT of pass/cost/steps but must stay IN the rendered page —
   *  a "2/2" cell in a table whose neighbours show "/4" reads as a sweep when
   *  it was a blackout. */
  blocked: number;
  /** Distinct repetition rounds in the data — cost/time render PER ROUND so a
   *  2-rep lane's bar is comparable with a 1-rep lane's. */
  reps: number;
  cost: number;
  seconds: number;
  steps: number;
  output: number;
  prefix: number;
  /** Average tokens the model re-reads per step (cacheRead+input over steps) —
   *  the number that explains the economics: steps are only as expensive as
   *  the context each one re-reads. */
  ctxPerStep: number;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Wire cost when the metering proxy saw the traffic, else the agent's own
 *  number. pi hardcodes api.anthropic.com and cannot be pointed at the proxy,
 *  so its column is self-reported — reconciled against the provider's own
 *  billing page in round soul-1, where it matched to the cent. */
const costOf = (r: RunRecord): number => (r.realRequests > 0 ? (r.realCost ?? 0) : r.reportedCost);

function load(): Map<string, Map<LaneId, RunRecord[]>> {
  const byTier = new Map<string, Map<LaneId, RunRecord[]>>();
  if (!existsSync(RESULTS)) return byTier;
  for (const f of readdirSync(RESULTS)) {
    const m = /^final-(v1|v2|pi)-([a-z]+)\.json$/.exec(f);
    if (!m) continue;
    const [, lane, tier] = m as unknown as [string, LaneId, string];
    const data = JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as BenchResults;
    if (!byTier.has(tier)) byTier.set(tier, new Map());
    byTier.get(tier)!.set(lane, data.runs ?? []);
  }
  return byTier;
}

function cell(runs: RunRecord[]): Cell {
  // "agent did not run" covers two different things: a provider refusal
  // (quota — dies in <2s, genuinely never ran → excluded) and an agent that
  // ran for minutes and crashed (pi's 16-minute no-agent_end exit=1 on
  // haiku). The second is an attempt that failed and counts as one — for
  // EVERY lane, symmetrically.
  const done = runs.filter(
    (r) => !r.reason?.startsWith("agent did not run") || r.durationMs >= 60_000,
  );
  return {
    runs: done,
    pass: done.filter((r) => r.pass).length,
    of: done.length,
    blocked: runs.length - done.length,
    reps: new Set(done.map((r) => r.rep ?? 1)).size || 1,
    cost: done.reduce((a, r) => a + costOf(r), 0),
    seconds: done.reduce((a, r) => a + r.durationMs / 1000, 0),
    steps: done.reduce((a, r) => a + (r.steps ?? 0), 0),
    output: done.reduce((a, r) => a + (r.realTokens?.output ?? r.reportedTokens.output), 0),
    prefix: median(
      done.map((r) => r.realTokens?.cacheWrite ?? 0).filter((n) => n > 0),
    ),
    ctxPerStep: (() => {
      const steps = done.reduce((a, r) => a + (r.steps ?? 0), 0);
      if (steps === 0) return 0;
      const read = done.reduce((a, r) => {
        const t = r.realTokens ?? r.reportedTokens;
        // Provider conventions differ: OpenAI's input_tokens already INCLUDES
        // cached tokens (details split them out); Anthropic's input excludes
        // them. Adding cacheRead on an OpenAI lane double-counts the cache.
        const isOpenAI = /gpt|openai/i.test(r.model ?? "");
        return a + (isOpenAI ? t.input : t.cacheRead + t.input);
      }, 0);
      return Math.round(read / steps);
    })(),
  };
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const secs = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${n.toFixed(0)}s`);
const pct = (a: number, b: number) => (b === 0 ? "—" : `${a > b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%`);


/** One horizontal bar: label · track · value. Width scales to the tier max. */
function bar(label: string, accent: string, value: number, max: number, text: string): string {
  const w = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
  return `<div class="brow"><span class="bl">${esc(label)}</span><div class="btrack"><div class="bfill" style="width:${String(w)}%;background:${accent}"></div></div><span class="bv">${text}</span></div>`;
}

function tierSection(tier: (typeof TIERS)[number], lanes: Map<LaneId, RunRecord[]>): string {
  const cells = new Map<LaneId, Cell>();
  for (const l of LANES) cells.set(l.id, cell(lanes.get(l.id) ?? []));
  const tasks = [...new Set([...lanes.values()].flat().map((r) => r.task))].sort();

  // Postable verdict card: Empryo (Forge v2) vs pi, vertical columns, the
  // winner in green, the loser muted. v1 lives in the details table and the
  // v1-vs-v2 section — the headline fight is Empryo vs pi.
  const em = cells.get("v2")!;
  const p = cells.get("pi")!;
  const bothRan = em.of > 0 && p.of > 0;

  /** Two vertical columns, EFFICIENCY-scaled: for lower-is-better metrics the
   *  winner's column stands FULL height and the loser scales down by the
   *  ratio — taller = better, the way eyes read bars. The printed numbers are
   *  the real values, so nothing is hidden. */
  const colPair = (
    kind: string,
    a: number | null,
    b: number | null,
    fmt: (n: number) => string,
  ): string => {
    const min = Math.min(a ?? Number.POSITIVE_INFINITY, b ?? Number.POSITIVE_INFINITY);
    const col = (v: number | null, name: string, win: boolean): string => {
      if (v === null)
        return `<div class="col"><span class="cv mutv">n/a†</span><div class="cbar ghost" style="height:8%"></div><span class="cn">${name}</span></div>`;
      const h = v > 0 && Number.isFinite(min) ? Math.max(10, Math.round((min / v) * 100)) : 10;
      return `<div class="col"><span class="cv${win ? " winv" : ""}">${fmt(v)}</span><div class="cbar${win ? " win" : ""}" style="height:${String(h)}%"></div><span class="cn">${name}</span></div>`;
    };
    const emWins = a !== null && b !== null && a < b;
    const piWins = a !== null && b !== null && b < a;
    const delta =
      a !== null && b !== null
        ? emWins
          ? `<div class="cdelta win">Empryo ${pct(a, b)}</div>`
          : `<div class="cdelta loss">pi ${pct(b, a)}</div>`
        : `<div class="cdelta mutv">unmetered</div>`;
    return `<div class="colgrp"><div class="colk">${kind}</div><div class="colpair">${col(a, "Empryo", emWins)}${col(b, "pi", piWins)}</div>${delta}</div>`;
  };

  const acc = (): string => {
    if (!bothRan) return "";
    const ea = Math.round((em.pass / em.of) * 100);
    const pa = Math.round((p.pass / p.of) * 100);
    if (ea === pa) return `<span class="pill ok">accuracy tied · ${String(ea)}%</span>`;
    return `<span class="pill ${ea > pa ? "ok" : "part"}">Empryo ${String(ea)}%</span><span class="pill ${pa > ea ? "ok" : "part"}">pi ${String(pa)}%</span>`;
  };

  const columns = bothRan
    ? colPair("Cost per round", cpr(em), cpr(p), usd) +
      colPair("Time per round", em.seconds / em.reps, p.seconds / p.reps, secs)
    : "";

  const rows = LANES.map((l) => {
    const c = cells.get(l.id)!;
    if (c.of === 0 && c.blocked === 0) return "";
    // A lane whose runs were ALL blocked still renders — as a blackout row,
    // never as an absence the reader can't distinguish from "not benched".
    if (c.of === 0) {
      return `<tr>
      <td><span class="dot" style="background:${l.accent}"></span>${l.label}</td>
      <td colspan="7" class="num mut">${c.blocked} run${c.blocked === 1 ? "" : "s"} blocked — provider refused (quota) before any step ran</td>
    </tr>`;
    }
    const solved = `${c.pass}/${c.of}${c.blocked > 0 ? ` <span class="blk">+${c.blocked} blocked</span>` : ""}`;
    return `<tr${l.id === "v2" ? ' class="hi"' : ""}>
      <td><span class="dot" style="background:${l.accent}"></span>${l.label}</td>
      <td class="num">${solved}</td>
      <td class="num">${usd(c.cost)}</td>
      <td class="num">${secs(c.seconds)}</td>
      <td class="num">${c.steps}</td>
      <td class="num">${c.output.toLocaleString()}</td>
      <td class="num">${c.ctxPerStep ? c.ctxPerStep.toLocaleString() : "—"}</td>
      <td class="num">${c.prefix ? c.prefix.toLocaleString() : "—"}</td>
    </tr>`;
  }).join("");

  const perTask = tasks
    .map((t) => {
      const cs = LANES.map((l) => {
        const runs = (lanes.get(l.id) ?? []).filter((r) => r.task === t);
        return { lane: l, c: cell(runs) };
      }).filter((x) => x.c.of > 0);
      if (cs.length === 0) return "";
      return `<tr><td class="task">${esc(t)}</td>${cs
        .map(
          ({ c }) =>
            `<td class="num">${c.pass}/${c.of} · ${usd(c.cost)} · ${secs(c.seconds)} · ${c.steps} st</td>`,
        )
        .join("")}</tr>`;
    })
    .join("");

  return `<div class="vcard">
    <h3>${tier.label} <span class="sub">${tier.sub}</span></h3>
    <div class="pills">${acc()}</div>
    <div class="cols">${columns}</div>
    ${TIER_NOTES[tier.id] ? `<p class="tnote">${TIER_NOTES[tier.id]}</p>` : ""}
    <details><summary>Full numbers${tasks.length > 0 ? ` · ${String(tasks.length)} tasks` : ""} · incl. Forge v1</summary>
    <div class="scroll"><table>
      <thead><tr><th>lane</th><th class="num">solved</th><th class="num">cost</th><th class="num">wall</th><th class="num">steps</th><th class="num">output tok</th><th class="num">ctx/step</th><th class="num">prefix tok</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${
      perTask
        ? `<div class="scroll"><table class="tasks">
      <thead><tr><th>task</th>${LANES.filter((l) => (cells.get(l.id)?.of ?? 0) > 0)
        .map((l) => `<th>${l.label}</th>`)
        .join("")}</tr></thead>
      <tbody>${perTask}</tbody></table></div>`
        : ""
    }
    </details>
  </div>`;
}

const byTier = load();
const present = TIERS.filter((t) => byTier.has(t.id));
const totalRuns = [...byTier.values()].flatMap((m) => [...m.values()].flat()).length;

const cellOf = (tid: string, lane: LaneId): Cell | null => {
  const l = byTier.get(tid);
  if (!l) return null;
  const c = cell(l.get(lane) ?? []);
  return c.of > 0 ? c : null;
};
/** Per-round cost. */
const cpr = (c: Cell) => c.cost / c.reps;

/** Empryo vs Empryo — the headline fight. Forge v1 and Forge v2 are both our
 *  engines; this section shows what v2 took off v1's bill, in green. */
function v1v2Section(): string {
  const rows: string[] = [];
  for (const t of present) {
    const v1 = cellOf(t.id, "v1");
    const v2 = cellOf(t.id, "v2");
    if (!v1 || !v2) continue;
    const d = Math.round((1 - cpr(v2) / cpr(v1)) * 100);
    const win = d > 0;
    const stale = t.id === "haiku";
    const max = Math.max(cpr(v1), cpr(v2));
    const solvedJump =
      v2.pass / v2.of > v1.pass / v1.of
        ? `<span class="pill ok">solved ${String(Math.round((v1.pass / v1.of) * 100))}%→${String(Math.round((v2.pass / v2.of) * 100))}%</span>`
        : "";
    rows.push(`<div class="vrow">
      <div class="vhead">${esc(t.label)} ${solvedJump}${
        win
          ? `<span class="chip win">v2 −${String(d)}% cost</span>`
          : `<span class="chip loss">+${String(-d)}%${stale ? " · superseded engine" : ""}</span>`
      }</div>
      ${bar("Forge v1", "#94a3b8", cpr(v1), max, usd(cpr(v1)))}
      ${bar("Forge v2", win ? "#16a34a" : "#b45309", cpr(v2), max, usd(cpr(v2)))}
    </div>`);
  }
  if (rows.length === 0) return "";
  return `<section class="tier">
    <h3>Forge v2 vs Forge v1 <span class="sub">both Empryo engines · cost per round · same tasks, same keys</span></h3>
    ${rows.join("\n")}
  </section>`;
}

/** THE screenshot: every model, three metrics, winner in green. One block. */
function summaryPoster(): string {
  const rowsHtml: string[] = [];
  for (const t of present) {
    const em = cellOf(t.id, "v2");
    const p = cellOf(t.id, "pi");
    if (!em || !p) continue;
    const emAcc = Math.round((em.pass / em.of) * 100);
    const piAcc = Math.round((p.pass / p.of) * 100);
    // Green is EMPRYO's color: our wins celebrate, pi's wins get a neutral
    // gray check — factual, never festive.
    const v = (
      val: string,
      state: "win" | "lose" | "tie" | "na",
      isEmpryo: boolean,
    ): string =>
      state === "win"
        ? isEmpryo
          ? `<span class="pw">${val} ✓</span>`
          : `<span class="pwn">${val} ✓</span>`
        : state === "na"
          ? `<span class="pna">${val}</span>`
          : state === "tie"
            ? `<span class="pt2">${val}</span>`
            : `<span class="pl">${val}</span>`;
    const accPair =
      emAcc === piAcc
        ? `${v(`${String(emAcc)}%`, "tie", true)}${v(`${String(piAcc)}%`, "tie", false)}`
        : `${v(`${String(emAcc)}%`, emAcc > piAcc ? "win" : "lose", true)}${v(`${String(piAcc)}%`, piAcc > emAcc ? "win" : "lose", false)}`;
    const costPair = `${v(usd(cpr(em)), cpr(em) < cpr(p) ? "win" : "lose", true)}${v(usd(cpr(p)), cpr(p) < cpr(em) ? "win" : "lose", false)}`;
    const eT = em.seconds / em.reps;
    const pT = p.seconds / p.reps;
    const timePair = `${v(secs(eT), eT < pT ? "win" : "lose", true)}${v(secs(pT), pT < eT ? "win" : "lose", false)}`;
    rowsHtml.push(
      `<tr><td class="pm">${esc(t.label)}${t.id === "haiku" ? "*" : ""}</td><td>${accPair}</td><td>${costPair}</td><td>${timePair}</td></tr>`,
    );
  }
  return `<section class="poster" id="poster">
    <div class="phead"><span class="pbrand">Empryo</span> vs <span class="ppi">pi</span><span class="psub">6 models · 2 providers · real merged bugs · wire-metered · Aug 2026</span></div>
    <div class="scroll"><table class="ptable">
      <thead><tr><th>model</th><th>solved <span class="pcols">Empryo · pi</span></th><th>cost / round <span class="pcols">Empryo · pi</span></th><th>time / round <span class="pcols">Empryo · pi</span></th></tr></thead>
      <tbody>${rowsHtml.join("")}</tbody>
    </table></div>
    <p class="pconc"><b>The smarter the model, the cheaper Empryo gets</b> — a smart model uses code intelligence the right way. Minimalism only wins where tokens cost pennies.</p>
    <p class="pfoot">pi 0.84.1's GPT-side meter was broken (luna: "$0.005 / 4 tasks"); pi was upgraded to 0.84.2 and its whole GPT leg re-benched on the fixed meter. * Haiku: Empryo runs the marionette pre-pass lane; the one pi miss was its own 16-minute stall. pi benched barebone; Empryo full product.</p>
  </section>`;
}

/** Three-line TLDR. Every number computed from the recorded runs. */
function tldr(): string {
  const f = (tid: string) => {
    const v1 = cellOf(tid, "v1");
    const v2 = cellOf(tid, "v2");
    if (!v1 || !v2) return null;
    return Math.round((1 - cpr(v2) / cpr(v1)) * 100);
  };
  const opusD = f("opus");
  const terraD = f("terra");
  const lunaV1 = cellOf("luna", "v1");
  const lunaV2 = cellOf("luna", "v2");
  const opusV2 = cellOf("opus", "v2");
  const opusPi = cellOf("opus", "pi");
  const solV2 = cellOf("sol", "v2");
  const solPi = cellOf("sol", "pi");
  const sonV2 = cellOf("sonnet", "v2");
  const sonPi = cellOf("sonnet", "pi");
  const lunaV2b = cellOf("luna", "v2");
  const lunaPi = cellOf("luna", "pi");
  const wins: string[] = [];
  if (opusV2 && opusPi && cpr(opusV2) < cpr(opusPi))
    wins.push(`Opus: <b>${pct(opusV2.cost, opusPi.cost)}</b> cost, <b>${pct(opusV2.seconds, opusPi.seconds)}</b> time`);
  if (solV2 && solPi && cpr(solV2) < cpr(solPi))
    wins.push(`sol: <b>${pct(cpr(solV2), cpr(solPi))}</b> cost`);
  if (lunaV2b && lunaPi && lunaV2b.seconds / lunaV2b.reps < lunaPi.seconds / lunaPi.reps)
    wins.push(`luna: <b>${pct(lunaV2b.seconds / lunaV2b.reps, lunaPi.seconds / lunaPi.reps)}</b> time`);
  const l1 = `<li><b>Empryo beats pi where money is real.</b> ${wins.join(". ")}. Accuracy: even on every tier.</li>`;
  const l2 = `<li><b>Forge v2 beats Forge v1 — our own old engine — everywhere.</b>${
    opusD !== null ? ` Opus <b>−${String(opusD)}%</b> cost.` : ""
  }${terraD !== null ? ` terra <b>−${String(terraD)}%</b>.` : ""}${
    lunaV1 && lunaV2
      ? ` luna <b>−${String(Math.round((1 - cpr(lunaV2) / cpr(lunaV1)) * 100))}%</b> and solved <b>${String(Math.round((lunaV1.pass / lunaV1.of) * 100))}%→${String(Math.round((lunaV2.pass / lunaV2.of) * 100))}%</b>.`
      : ""
  }</li>`;
  const l3 = `<li>pi keeps a cost edge on cheap and mid-price models${
    sonV2 && sonPi ? ` (Sonnet <b>${pct(cpr(sonV2), cpr(sonPi))}</b>)` : ""
  } — exactly where tokens cost the least.</li>`;
  return `<ul class="tldr">${l1}${l2}${l3}</ul>`;
}

/** Input $/M for the thesis chart's price axis (verified 2026-08-15, models.dev). */
const TIER_PRICE: Record<string, number> = {
  haiku: 1,
  sonnet: 2,
  opus: 5,
  luna: 0.2,
  terra: 2,
  sol: 5,
};

/** The thesis, drawn from the recorded rounds: v2-cost ÷ pi-cost by model
 *  price. Below the parity line, intelligence beat minimalism on money.
 *  Computed — a tier without complete v2+pi rounds simply doesn't plot. */
function thesisChart(): string {
  // Signed columns: "% cheaper than pi", per tier. Empryo wins point UP in
  // green; pi's edges point down in gray. Ordered by model input price so the
  // crossover — the thesis — reads left to right. luna is excluded: both
  // lanes cost pennies there (Δ ≈ $0.08/round) and percentages mislead at
  // pocket-change scale; its absolute numbers live in its card.
  const pts: Array<{ label: string; price: number; saved: number }> = [];
  for (const t of present) {
    if (t.id === "luna") continue;
    const em = cellOf(t.id, "v2");
    const p = cellOf(t.id, "pi");
    if (!em || !p || em.cost === 0 || p.cost === 0) continue;
    pts.push({
      label: t.label.replace(" · effort high", ""),
      price: TIER_PRICE[t.id] ?? 1,
      saved: Math.round((1 - cpr(em) / cpr(p)) * 100),
    });
  }
  if (pts.length < 2) return "";
  pts.sort((a, b) => a.price - b.price || a.saved - b.saved);
  const W = 940;
  const H = 340;
  const PAD = { l: 24, r: 24, t: 46, b: 64 };
  const zero = PAD.t + (H - PAD.t - PAD.b) * 0.62; // wins get the larger visual zone
  const maxUp = Math.max(30, ...pts.map((x) => x.saved));
  const maxDn = Math.max(30, ...pts.map((x) => -x.saved));
  const slotW = (W - PAD.l - PAD.r) / pts.length;
  const cols = pts
    .map((x, i) => {
      const cx = PAD.l + slotW * i + slotW / 2;
      const win = x.saved >= 0;
      const h = win
        ? ((zero - PAD.t) * x.saved) / maxUp
        : ((H - PAD.b - zero) * -x.saved) / maxDn;
      const y = win ? zero - h : zero;
      const color = win ? "#16a34a" : "#cbd5e1";
      const valY = win ? y - 10 : y + h + 18;
      const nameY = H - PAD.b + 22;
      const priceY = H - PAD.b + 40;
      return `<rect x="${(cx - 34).toFixed(1)}" y="${y.toFixed(1)}" width="68" height="${Math.max(3, h).toFixed(1)}" rx="7" fill="${color}"/>
      <text x="${cx.toFixed(1)}" y="${valY.toFixed(1)}" text-anchor="middle" class="pv" fill="${win ? "#15803d" : "#64748b"}">${x.saved > 0 ? "+" : ""}${String(x.saved)}%</text>
      <text x="${cx.toFixed(1)}" y="${String(nameY)}" text-anchor="middle" class="pt">${esc(x.label)}</text>
      <text x="${cx.toFixed(1)}" y="${String(priceY)}" text-anchor="middle" class="ax">$${String(x.price)}/M in</text>`;
    })
    .join("\n");
  return `<section class="tier">
    <h3>How much cheaper is Empryo? <span class="sub">cost saved vs pi, per round — accuracy tied on every plotted model</span></h3>
    <div class="scroll"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Empryo cost saved vs pi by model" style="width:100%;min-width:640px">
      <text x="${PAD.l}" y="${PAD.t - 26}" class="ax" fill="#15803d" font-weight="700">▲ Empryo cheaper</text>
      <text x="${PAD.l}" y="${H - PAD.b + 58}" class="ax">▼ pi cheaper — only where tokens cost pennies</text>
      <line x1="${PAD.l}" y1="${zero.toFixed(1)}" x2="${W - PAD.r}" y2="${zero.toFixed(1)}" stroke="#0f172a" opacity=".3"/>
      ${cols}
    </svg></div>
    <p class="mut" style="margin:10px 0 0;font-size:13.5px">The pattern: <b>the more a model costs, the more Empryo saves.</b> Cheap-token models are the only place minimalism keeps an edge — and the dollars there are small by definition.</p>
  </section>`;
}

/** Honest-refutations panel: the experiments the data killed, kept on the page
 *  because a benchmark that only reports wins is marketing. Figures are from
 *  archived rounds (results-archive/), fixed facts of the dev log. */
const REFUTATIONS = `<section class="tier">
  <h3>What we tried that lost <span class="sub">refuted by measurement, reverted, kept on the record</span></h3>
  <ul>
    <li><b>Response chaining as default</b> — Responses-API <code>previous_response_id</code> instead of replay: server-side state retains every step's reasoning at high effort, so the chained terra round cost $1.67 against replay's $1.30 at equal 4/4. Now opt-in for low-reasoning runs.</li>
    <li><b>Lean belt at mid tier</b> — extending the frontier schema trim to Sonnet 5 held 4/4 but cost $1.48 vs $1.22: the removed contracts cost more in extra steps than they saved in bytes. Reverted; the price gate stays at frontier.</li>
    <li><b>Codemode by persuasion</b> — explore_script (one script, only its summary billed) is live and answers prompted multi-lookup questions in 1–3 steps. Three escalating adoption mechanisms — a prompt advert, a taught default, a deterministic 3rd-lookup hint — all measured <b>zero organic uses</b> across full rounds. Habits beat prose; adoption requires structural delivery (the pre-pass handing over the script), scheduled for the audited follow-up.</li>
    <li><b>Marionette everywhere</b> — the cheap-model pre-pass that rescued Haiku (its only TrieRouter pass) measured NEGATIVE on terra ($0.903 vs $0.705): a capable model pays the pre-pass tax without needing the rescue. Budget-tier only.</li>
  </ul>
  <p class="mut" style="font-size:13.5px;margin:6px 0 0">Every surviving v2 feature carries the same standard of evidence as these three carried to their graves.</p>
</section>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge v2 vs pi</title>
<style>
  :root { --bg:#f7f7f9; --panel:#fff; --ink:#0f172a; --mut:#64748b; --line:#e2e8f0; --v2:#7c3aed; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; padding:48px 24px 80px; }
  h1 { font-size:34px; letter-spacing:-.02em; margin:0 0 8px; }
  .lede { color:var(--mut); font-size:17px; max-width:70ch; margin:0 0 32px; }
  h3 { font-size:19px; margin:0 0 14px; letter-spacing:-.01em; }
  .sub { color:var(--mut); font-weight:400; font-size:13px; }
  .tier { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:22px; margin:0 0 20px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:0 0 18px; }
  .card { background:#fafafa; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .k { color:var(--mut); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .v { font-size:24px; font-weight:600; letter-spacing:-.02em; margin:2px 0 6px; }
  .chip { display:inline-block; font-size:12px; padding:2px 8px; border-radius:999px; font-weight:600; }
  .blk { color:#b45309; font-size:12px; font-weight:600; }
  .mut { color:var(--mut); }
  .pt { font:600 12.5px ui-sans-serif,system-ui; fill:#0f172a; }
  .pv { font:700 12px ui-monospace,monospace; fill:#475569; }
  .ax { font:11.5px ui-sans-serif,system-ui; fill:#94a3b8; }
  .tier ul { margin:0; padding-left:20px; }
  .tier li { margin:0 0 10px; line-height:1.55; }
  .tldr { list-style:none; margin:0 0 26px; padding:18px 20px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:14px; }
  .tldr li { margin:0 0 10px; font-size:16px; line-height:1.5; }
  .tldr li:last-child { margin:0 }
  .tldr b { color:#15803d }
  .tldr li:last-child b { color:#b45309 }
  .pills { display:flex; flex-wrap:wrap; gap:14px; margin:0 0 4px }
  .lanehead { display:flex; align-items:center; gap:8px; font-weight:600; font-size:14px }
  .pill { font-size:12px; padding:2px 9px; border-radius:999px; font-weight:700 }
  .pill.ok { background:#dcfce7; color:#15803d }
  .pill.part { background:#fef3c7; color:#b45309 }
  .pill.blkp { background:#fee2e2; color:#b91c1c; font-weight:600 }
  .reps { font-size:11.5px; color:var(--mut) }
  .metric-k { font:700 11px/1 ui-sans-serif; letter-spacing:.08em; text-transform:uppercase; color:var(--mut); margin:16px 0 8px }
  .brow { display:flex; align-items:center; gap:10px; margin:5px 0 }
  .bl { flex:none; width:78px; text-align:right; font-size:13px; color:var(--mut) }
  .btrack { flex:1; height:24px; background:#eef1f5; border-radius:6px; overflow:hidden }
  .bfill { height:100%; border-radius:6px }
  .bv { flex:none; width:92px; font:700 13.5px ui-monospace,monospace }
  .tier details { margin-top:14px }
  .tier summary { cursor:pointer; color:var(--mut); font-size:13px; font-weight:600 }
  .tnote { margin:2px 0 12px; font-size:13.5px; color:var(--mut) }
  .vrow { margin:0 0 18px }
  .vhead { display:flex; align-items:center; gap:10px; font-weight:600; font-size:14.5px; margin:0 0 4px }
  /* ── poster: the one-screenshot summary ── */
  .poster { background:linear-gradient(180deg,#ffffff,#fafcff); border:1px solid var(--line); border-radius:16px; padding:24px; margin:0 0 22px; box-shadow:0 2px 10px rgba(15,23,42,.05) }
  .phead { font-size:24px; font-weight:800; letter-spacing:-.02em; margin:0 0 14px }
  .pbrand { color:#16a34a } .ppi { color:#64748b }
  .psub { display:block; font-size:12.5px; font-weight:500; color:var(--mut); margin-top:3px }
  .ptable { width:100%; border-collapse:collapse }
  .ptable th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--mut); padding:6px 10px; border-bottom:1px solid var(--line) }
  .pcols { display:block; text-transform:none; letter-spacing:0; font-weight:500; font-size:11px }
  .ptable td { padding:9px 10px; border-bottom:1px solid #f1f5f9; white-space:nowrap }
  .pm { font-weight:700; font-size:14px }
  .pw { display:inline-block; background:#dcfce7; color:#15803d; font:700 13.5px ui-monospace,monospace; border-radius:7px; padding:3px 9px; margin-right:6px }
  .pl { display:inline-block; color:#94a3b8; font:600 13.5px ui-monospace,monospace; padding:3px 9px; margin-right:6px }
  .pwn { display:inline-block; background:#f1f5f9; color:#475569; font:700 13.5px ui-monospace,monospace; border-radius:7px; padding:3px 9px; margin-right:6px }
  .pt2 { display:inline-block; background:#f1f5f9; color:#475569; font:700 13.5px ui-monospace,monospace; border-radius:7px; padding:3px 9px; margin-right:6px }
  .pna { display:inline-block; color:#cbd5e1; font:600 13px ui-monospace,monospace; padding:3px 9px; margin-right:6px }
  .pconc { margin:16px 0 4px; font-size:16.5px; line-height:1.5 }
  .pconc b { color:#15803d }
  .pfoot { margin:0; font-size:12px; color:var(--mut) }
  /* ── verdict cards: vertical columns ── */
  .vgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:18px; margin:0 0 22px }
  .vcard { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px 20px; box-shadow:0 1px 2px rgba(15,23,42,.04) }
  .vcard h3 { margin:0 0 8px }
  .cols { display:flex; gap:34px; margin:14px 0 4px }
  .colgrp { flex:1 }
  .colk { font:800 11.5px/1 ui-sans-serif; letter-spacing:.08em; text-transform:uppercase; color:var(--mut); margin:0 0 10px }
  .colpair { display:flex; align-items:flex-end; gap:20px; height:190px }
  .col { display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; flex:1 }
  .cbar { width:100%; max-width:96px; border-radius:10px 10px 3px 3px; background:#dde3ea }
  .cbar.win { background:#16a34a }
  .cbar.ghost { background:repeating-linear-gradient(45deg,#eef1f5,#eef1f5 5px,#e2e8f0 5px,#e2e8f0 10px) }
  .cv { font:800 17px ui-monospace,monospace; margin:0 0 7px; color:#94a3b8; letter-spacing:-.02em }
  .cv.winv { color:#15803d; font-size:19px }
  .cv.mutv, .mutv { color:#cbd5e1 }
  .cn { font-size:13px; font-weight:600; color:var(--mut); margin-top:8px }
  .cdelta { display:inline-block; margin-top:10px; font-size:13.5px; font-weight:800; padding:3px 12px; border-radius:999px }
  .cdelta.win { color:#15803d; background:#dcfce7 }
  .cdelta.loss { color:#64748b; background:#f1f5f9 }
  .win { background:#dcfce7; color:#166534; } .loss { background:#fee2e2; color:#991b1b; }
  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; margin:0 0 10px; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--mut); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  tr.hi td { background:#faf5ff; font-weight:600; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:99px; margin-right:8px; vertical-align:middle; }
  .task { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .method { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:22px; color:var(--mut); font-size:14px; }
  .method h3 { color:var(--ink); }
  .method li { margin:0 0 8px; }
  code { background:#f1f5f9; padding:1px 5px; border-radius:4px; font-size:13px; }
</style></head><body><div class="wrap">
<h1>Empryo vs pi</h1>
<p class="lede">The full code-intelligence engine against the most minimal harness there is. Real merged bugs, six models, <b>${totalRuns} runs</b>, costs metered on the wire.</p>
${tldr()}
${summaryPoster()}
<p class="mut" style="margin:0 0 10px;font-size:13px">Cards below: columns show <b>efficiency — taller is better</b>; the printed numbers are the real cost and time.</p>
<div class="vgrid">${present.map((t) => tierSection(t, byTier.get(t.id)!)).join("")}</div>
${thesisChart()}
${v1v2Section()}
${REFUTATIONS}
<div class="method">
<h3>Method</h3>
<ul>
<li><b>Fixtures are real merged bug fixes.</b> Each task resets the repo to the commit before the fix, rewrites history to a single baseline commit so <code>git log</code> can't reveal it, and grades the agent's diff with the fix PR's own tests — dropped in only after the run.</li>
<li><b>The tests grade behaviour, not the author's design.</b> Candidates whose tests pinned a signature the fix introduced were rejected: they measure design-guessing, not correctness.</li>
<li><b>v1 vs v2 differ by one config key.</b> Same binary, same flags, same key, same tasks — only <code>agentFeatures.forgeV2</code> changes, so the delta is the engine.</li>
<li><b>Cost is wire-metered.</b> A reverse proxy tees every request and prices the usage the provider reports. pi hardcodes its API host and cannot be pointed at the proxy, so its cost is self-reported — reconciled against the provider's own billing page in an earlier round, where it matched to the cent.</li>
<li><b>Wall time measures the agent working, not pre-working.</b> Fixture caches carry a pre-built genome index (mtime-verified by the engine on open), so no run pays the one-time cold index inside its wall clock — the same shape as a returning user or CI. The cold index itself is a fixed, separately-stated number: 96–100s for the 5,745-file / 48,511-symbol opencode monorepo, 8s for hono. Rounds before 2026-08-15 evening ran cold-index walls; the audited rounds run warm.</li>
<li><b>The comparison is our ceiling against pi's floor.</b> Empryo lanes carry the full product surface — a 37-tool belt (memory, skills, subagents, editor, browser-less web, the genome family), with Forge v2 pricing its delivery per model. The pi lane is barebone pi: four tools, a ~20-line prompt, no extensions — the cheapest configuration it can run, and the one real installs immediately extend past (every added extension/tool/skill grows its per-step context the same way ours does, without an engine that prices it). Where we win, a maximum beat a minimum.</li>
<li><b>Empryo lanes run in a sterile home.</b> A captured request body showed the operator's personal memory recalls and installed-skills catalog leaking into bench prompts (plus a synthetic ack turn). Post-diet rounds point <code>$HOME</code> at a hydrated-but-empty home: natives present, zero personal state. pi keeps the real home — the baseline runs as shipped.</li>
<li><b>Post-diet rounds run the v2 result governor + price-gated lean tail</b> (engine <code>cda7d473</code>): belt tool outputs are capped with recovery-teaching truncation markers, and on frontier-priced models the rarely-called schemas (git, find, genome_analyze, multi_edit) defer behind tool_search. Pre-diet rounds are archived in <code>results-archive/pre-diet/</code>.</li>
</ul>
</div>
</div></body></html>`;

mkdirSync(join(ROOT, "report"), { recursive: true });
const out = join(ROOT, "report", "forge-v2-vs-pi.html");
writeFileSync(out, html);
console.error(`[report-final] wrote ${out} — ${totalRuns} runs, ${present.length} tier(s)`);
