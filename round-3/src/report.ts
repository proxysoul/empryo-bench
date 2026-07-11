/**
 * HTML report generator — a dark, share-ready scoreboard built for screenshots
 * (the hero section is a clean 16:9-ish card for X). Zero external assets:
 * system fonts, inline CSS, div bars — renders identically offline.
 *
 * Usage: bun src/report.ts results/<label>.json   → report/<label>.html + report/index.html
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT } from "./prep.ts";
import { costDeltaPct, fmtSecs, fmtTokens, fmtUsd, median } from "./stats.ts";
import type { AgentId, BenchResults, RunRecord } from "./types.ts";
import { aggregate, type AgentAgg } from "./aggregate.ts";

const COLORS: Record<AgentId, string> = {
  empryo: "#8b7cff",
  "empryo-marionette": "#c084fc",
  claude: "#e08363",
  opencode: "#34d399",
  pi: "#f5b544",
};
const LABELS: Record<AgentId, string> = {
  empryo: "Empryo",
  "empryo-marionette": "Empryo + Marionette",
  claude: "Claude Code",
  opencode: "opencode",
  pi: "pi",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bar(pct: number, color: string, text: string): string {
  const w = Math.max(2, Math.min(100, pct));
  return `<div class="bar"><div class="bar-fill" style="width:${w.toFixed(1)}%;background:${color}"></div><span class="bar-text">${esc(text)}</span></div>`;
}

function repDots(runs: RunRecord[]): string {
  return runs
    .sort((a, b) => a.rep - b.rep)
    .map((x) => `<span class="dot ${x.pass ? "ok" : "no"}" title="rep ${x.rep}: ${x.pass ? "pass" : esc(x.reason ?? "fail")}"></span>`)
    .join("");
}

function render(r: BenchResults): string {
  const aggs = r.agents.map((a) => aggregate(r, a)).sort((a, b) => b.score - a.score);
  const winner = aggs[0];
  const maxDur = Math.max(...aggs.map((a) => a.medDuration), 1);
  const maxCost = Math.max(...aggs.map((a) => Math.max(a.medReported, a.medReal ?? 0)), 0.0001);
  const anyQuality = aggs.some((a) => a.medQuality !== null);
  // Contended runs shared the machine with other agents: their wall time is
  // not comparable, so the report says so instead of ranking on it.
      const anyContended = r.runs.some((x) => x.contended);
  const testLines = (agent: AgentId): number =>
    r.runs.filter((x) => x.agent === agent).reduce((s, x) => s + (x.work?.testLinesAdded ?? 0), 0);
  const anyWork = r.runs.some((x) => x.work);
  const maxTestLines = Math.max(...r.agents.map(testLines), 1);

  const heroCards = aggs
    .map((a, i) => {
      const c = COLORS[a.agent];
      const delta = costDeltaPct(a.medReported, a.medReal);
      return `
      <div class="card ${i === 0 ? "card-winner" : ""}" style="--c:${c}">
        <div class="card-rank">#${i + 1}</div>
        <div class="card-name">${LABELS[a.agent]}</div>
        <div class="card-pass">${a.passes}<span class="of">/${a.total}</span></div>
        <div class="card-passlabel">tasks solved</div>
        <div class="card-stats">
          <div><b>${fmtSecs(a.medDuration)}</b><span>median time${anyContended ? " (contended)" : ""}</span></div>
          <div><b>${fmtUsd(a.medReal ?? a.medReported)}</b><span>median cost${a.medReal === null ? " (self-rep.)" : ""}</span></div>
          ${anyQuality ? `<div><b>${a.medQuality === null ? "—" : a.medQuality.toFixed(1)}</b><span>code quality /10</span></div>` : ""}
          <div><b>${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`}</b><span>reported vs real $</span></div>
        </div>
      </div>`;
    })
    .join("\n");

  const metricRows = (title: string, fmt: (a: AgentAgg) => string, pct: (a: AgentAgg) => number) =>
    `<div class="metric"><h3>${title}</h3>${aggs
      .map((a) => `<div class="metric-row"><span class="metric-name" style="color:${COLORS[a.agent]}">${LABELS[a.agent]}</span>${bar(pct(a), COLORS[a.agent], fmt(a))}</div>`)
      .join("")}</div>`;

  const taskSections = r.tasks
    .map((t) => {
      const rows = r.agents
        .map((agent) => {
          const runs = r.runs.filter((x) => x.agent === agent && x.task === t.id);
          const agg = aggregate(r, agent, t.id);
          const delta = costDeltaPct(agg.medReported, agg.medReal);
          return `<tr>
            <td><span class="chip" style="--c:${COLORS[agent]}">${LABELS[agent]}</span></td>
            <td class="dots">${repDots(runs)}</td>
            <td>${fmtSecs(agg.medDuration)}</td>
            <td>${fmtUsd(agg.medReported)}</td>
            <td>${fmtUsd(agg.medReal)}</td>
            <td>${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`}</td>
            <td>${agg.medQuality === null ? "—" : `${agg.medQuality.toFixed(1)}/10`}</td>
            <td>${fmtTokens(agg.medTokensOut)}</td>
          </tr>`;
        })
        .join("\n");
      const receipts = r.runs
        .filter((x) => x.task === t.id)
        .sort((a, b) => (a.agent === b.agent ? a.rep - b.rep : a.agent.localeCompare(b.agent)))
        .map(
          (x) => `<tr>
            <td><span class="chip" style="--c:${COLORS[x.agent]}">${LABELS[x.agent]}</span></td>
            <td>${x.rep}</td>
            <td>${x.pass ? "✓" : "✗"}</td>
            <td>${fmtSecs(x.durationMs)}</td>
            <td>${fmtUsd(x.reportedCost)}</td>
            <td>${fmtUsd(x.realCost)}</td>
            <td>${x.realRequests}</td>
            <td>${x.steps}</td>
            <td>${fmtTokens(x.reportedTokens.output)}</td>
            <td>${x.quality ? x.quality.score.toFixed(1) : "—"}</td>
          </tr>`,
        )
        .join("\n");
        const verifs = r.runs
          .filter((x) => x.task === t.id && x.fixVerdict)
          .sort((a, b) => a.agent.localeCompare(b.agent))
          .map(
            (x) => `<div class="verif-row">
              <span class="chip" style="--c:${COLORS[x.agent]}">${LABELS[x.agent]}</span>
              <span class="verdict v-${x.fixVerdict?.verdict}">${esc(x.fixVerdict?.verdict ?? "")}</span>
              <span class="verif-note">${esc(x.fixVerdict?.note ?? "")}${
                x.work
                  ? ` <span class=\"work-stat\">· ${x.work.srcLinesChanged} src lines · ${x.work.testLinesAdded} test lines · ${x.work.filesTouched} files</span>`
                  : ""
              }</span>
            </div>`,
          )
          .join("\n");
        return `
      <section class="task">
        <div class="task-head">
          <span class="diff diff-${t.difficulty}">${t.difficulty}</span>
          <h2>${esc(t.title)}</h2>
          <span class="repo">${esc(t.repo)}</span>
        </div>
        <table>
          <thead><tr><th>agent</th><th>runs</th><th>time*</th><th>cost (self)*</th><th>cost (wire)*</th><th>Δ$</th><th>quality*</th><th>out tok*</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <details class="receipts">
          <summary>per-run receipts (${r.runs.filter((x) => x.task === t.id).length} runs)</summary>
          <table>
            <thead><tr><th>agent</th><th>rep</th><th>ok</th><th>time</th><th>cost self</th><th>cost wire</th><th>req</th><th>steps</th><th>out tok</th><th>quality</th></tr></thead>
            <tbody>${receipts}</tbody>
          </table>
          </details>
          ${
            verifs
              ? `<div class="verif"><h3>Fix verification vs the merged upstream PR</h3>${verifs}</div>`
              : ""
          }
        </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bench-soul — ${esc(r.label)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: #07090f; color: #e6e9f2;
    font: 15px/1.5 -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 40px 28px 80px; }
  .hero {
    position: relative; border-radius: 24px; padding: 44px 44px 40px; overflow: hidden;
    background:
      radial-gradient(900px 380px at 15% -10%, rgba(139,124,255,.22), transparent 60%),
      radial-gradient(700px 320px at 90% 0%, rgba(224,131,99,.16), transparent 55%),
      radial-gradient(600px 300px at 60% 110%, rgba(52,211,153,.10), transparent 60%),
      #0b0e17;
    border: 1px solid rgba(255,255,255,.07);
  }
  .kicker { letter-spacing: .28em; font-size: 11px; font-weight: 700; color: #9aa3c0; text-transform: uppercase; }
  h1 { font-size: 42px; letter-spacing: -.02em; margin: 8px 0 4px; font-weight: 800; }
  h1 .vs { color: #6b7394; font-weight: 400; }
  .sub { color: #9aa3c0; margin-bottom: 30px; }
  .sub b { color: #cdd3e6; font-weight: 600; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 99px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.09); font-size: 12px; color: #cdd3e6; margin-right: 6px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 14px; }
  @media (max-width: 880px) { .cards { grid-template-columns: repeat(2, 1fr); } }
  .card {
    border-radius: 16px; padding: 18px 18px 16px; background: rgba(255,255,255,.035);
    border: 1px solid rgba(255,255,255,.07); border-top: 3px solid var(--c);
  }
  .card-winner { background: linear-gradient(180deg, color-mix(in srgb, var(--c) 14%, transparent), rgba(255,255,255,.03)); box-shadow: 0 12px 40px -18px var(--c); }
  .card-rank { font-size: 11px; color: #8890ad; font-weight: 700; }
  .card-name { font-size: 17px; font-weight: 700; margin: 2px 0 10px; }
  .card-pass { font-size: 44px; font-weight: 800; line-height: 1; color: var(--c); }
  .card-pass .of { font-size: 20px; color: #6b7394; font-weight: 600; }
  .card-passlabel { font-size: 11px; color: #8890ad; margin: 4px 0 14px; text-transform: uppercase; letter-spacing: .08em; }
  .card-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 8px; }
  .card-stats b { display: block; font-size: 14px; }
  .card-stats span { font-size: 10.5px; color: #8890ad; }
  .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 28px 40px; margin: 46px 6px 8px; }
  @media (max-width: 880px) { .metrics { grid-template-columns: 1fr; } }
  .metric h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: #8890ad; margin-bottom: 12px; }
  .metric-row { display: grid; grid-template-columns: 132px 1fr; gap: 10px; align-items: center; margin-bottom: 8px; }
  .metric-name { font-size: 13px; font-weight: 600; }
  .bar { position: relative; height: 24px; border-radius: 6px; background: rgba(255,255,255,.05); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; opacity: .85; }
  .bar-text { position: absolute; inset: 0; display: flex; align-items: center; padding-left: 10px; font-size: 12px; font-weight: 600; color: #0b0e17; mix-blend-mode: normal; color: #eef1fa; text-shadow: 0 1px 2px rgba(0,0,0,.5); }
  .task { margin-top: 46px; }
  .task-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .task-head h2 { font-size: 20px; letter-spacing: -.01em; }
  .repo { color: #6b7394; font-size: 13px; font-family: ui-monospace, monospace; }
  .diff { font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; padding: 3px 8px; border-radius: 6px; }
  .diff-easy { background: rgba(52,211,153,.15); color: #34d399; }
  .diff-hard { background: rgba(244,114,182,.15); color: #f472b6; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #8890ad; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
  td { padding: 10px; border-bottom: 1px solid rgba(255,255,255,.05); }
  .chip { font-weight: 700; color: var(--c); }
  .dots { letter-spacing: 3px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 99px; margin-right: 4px; }
  .dot.ok { background: #34d399; box-shadow: 0 0 8px rgba(52,211,153,.5); }
  .dot.no { background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.2); }
  .receipts { margin-top: 10px; }
  .receipts summary { cursor: pointer; font-size: 12px; color: #8890ad; user-select: none; }
  .receipts table { margin-top: 8px; font-size: 12.5px; }
  .verif { margin-top: 18px; padding: 14px 16px; border-radius: 12px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06); }
  .verif h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #8890ad; margin-bottom: 10px; }
  .verif-row { display: grid; grid-template-columns: 150px 88px 1fr; gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,.04); font-size: 13px; }
  .verif-row:last-child { border-bottom: none; }
  .verdict { font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; padding: 2px 8px; border-radius: 6px; text-align: center; }
  .v-exact { background: rgba(52,211,153,.15); color: #34d399; }
  .v-equivalent { background: rgba(245,181,68,.15); color: #f5b544; }
  .v-divergent { background: rgba(244,114,182,.15); color: #f472b6; }
  .verif-note { color: #9aa3c0; font-size: 12.5px; }
  .work-stat { color: #6b7394; font-size: 11.5px; white-space: nowrap; }
  .note { margin: 26px 6px 0; padding: 16px 18px; border-radius: 12px; font-size: 13.5px; line-height: 1.65; color: #b9c0d8;
    background: rgba(139,124,255,.06); border: 1px solid rgba(139,124,255,.18); }
  .note b { color: #cdd3e6; }
  .foot { margin-top: 56px; color: #6b7394; font-size: 12.5px; line-height: 1.7; border-top: 1px solid rgba(255,255,255,.06); padding-top: 20px; }
  .foot code { color: #9aa3c0; font-family: ui-monospace, monospace; }
  .demo-mark {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    pointer-events: none; z-index: 9;
  }
  .demo-mark span {
    transform: rotate(-24deg); font-size: 90px; font-weight: 900; letter-spacing: .1em;
    color: rgba(255,255,255,.045); text-transform: uppercase; white-space: nowrap;
  }
</style>
</head>
<body>
${r.demo ? '<div class="demo-mark"><span>sample data</span></div>' : ""}
<div class="wrap">
  <div class="hero">
    <div class="kicker">bench-soul · coding-agent benchmark</div>
    <h1>${aggs.map((a) => LABELS[a.agent]).join('<span class="vs"> vs </span>')}</h1>
    <div class="sub">
      Same model <b>(${esc(r.model)})</b> · real merged bugs in <b>${esc(r.tasks[0]?.repo ?? "")}</b> ·
              ${r.repeats === 1 ? "single run per agent·task" : `${r.repeats}× repeats, medians`} · <b>${r.runs.length} recorded runs</b> · hidden upstream regression tests as the judge of correctness.
    </div>
    <div class="cards">
${heroCards}
    </div>
  </div>

  <div class="metrics">
          ${metricRows(anyContended ? "Median wall time (CONTENDED — agents ran in parallel, not comparable)" : "Median wall time (lower is better)", (a) => fmtSecs(a.medDuration), (a) => (a.medDuration / maxDur) * 100)}
    ${metricRows("Median cost on the wire (lower is better)", (a) => fmtUsd(a.medReal ?? a.medReported), (a) => (((a.medReal ?? a.medReported) || 0) / maxCost) * 100)}
    ${metricRows("Tasks solved", (a) => `${a.passes}/${a.total}`, (a) => a.passRate * 100)}
      ${anyQuality ? metricRows("Code quality (blind LLM judge, /10)", (a) => (a.medQuality === null ? "—" : a.medQuality.toFixed(1)), (a) => ((a.medQuality ?? 0) / 10) * 100) : ""}
      ${anyWork ? metricRows("Regression-test lines written (work pass/fail can't see)", (a) => String(testLines(a.agent)), (a) => (testLines(a.agent) / maxTestLines) * 100) : ""}
    </div>

    ${r.note ? `<div class="note"><b>Round note.</b> ${esc(r.note)}</div>` : ""}

${taskSections}

  <div class="foot">
    <p><b>Winner:</b> ${LABELS[winner.agent]} — ${winner.passes}/${winner.total} solved. * = ${r.repeats === 1 ? "single run — no repeats, treat rankings as directional" : `median across ${r.repeats} repeats`}.</p>
    <p><b>Method.</b> Each task is a real bug whose fix is merged upstream; the workspace is reset to the commit
    <em>before</em> the fix with git history rewritten to a single baseline commit. Agents get the verbatim issue text —
    no file hints. Correctness = the fix PR's own regression tests (held out, dropped in after the run) passing.
    <b>Cost (self)</b> is what the agent claims; <b>cost (wire)</b> is measured by a local metering proxy that parses
    every Anthropic API response and prices tokens at list rates; <b>Δ$</b> is reported-vs-wire drift.
    Quality is a blind LLM judge scoring each diff against the real upstream fix (root cause, minimality, style, robustness).
    Each agent runs on its own API key in its own Anthropic workspace, which isolates the prompt cache per agent at the provider.${anyContended ? " <b>Wall time in this round is contended</b> — agents ran concurrently on one machine, so durations are not comparable between agents; cost and correctness are unaffected." : ""}</p>
    <p>Generated ${esc(r.when)} · label <code>${esc(r.label)}</code> · <code>github.com/…/bench-soul</code></p>
  </div>
</div>
</body>
</html>`;
}

function main(): void {
  const file = process.argv[2] ?? join(ROOT, "sample", "sample-results.json");
  const results = JSON.parse(readFileSync(file, "utf8")) as BenchResults;
  const html = render(results);
  const outDir = join(ROOT, "report");
  mkdirSync(outDir, { recursive: true });
  const name = basename(file).replace(/\.json$/, "");
  writeFileSync(join(outDir, `${name}.html`), html);
  writeFileSync(join(outDir, "index.html"), html);
  console.error(`[report] wrote report/${name}.html (+ index.html)`);
}

main();
