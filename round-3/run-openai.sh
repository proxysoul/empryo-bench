#!/bin/bash
# OpenAI-lane rounds — the price-tier hypothesis on a second provider.
# Native defer_loading does NOT exist here: LEAN_DESC (+ genome diet) is the
# provider-agnostic half of lean, which is exactly what these rounds test.
#
#   terra (cheap/dumb)  ×3 old  vs ×3 desc+gd   → guided-tier check
#   sol   (expensive)   ×1 old  vs ×1 desc+gd   → lean-tier check
#   luna  (mid)         ×1 old  vs ×1 desc+gd   → only if budget remains
#
# HARD BUDGET: $4 on the key. The gate below stops before each round if the
# self-reported spend so far exceeds BUDGET_STOP. No wire metering on this
# lane (the bench proxy speaks Anthropic) — self-report is the ledger, and
# soul-1 proved empryo self-report honest to <0.5%.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env.bench ] && set -a && . ./.env.bench && set +a

AB_BIN="${AB_BIN:-$HOME/.empryo/bin/empryo-ab}"
TASK="${TASK:-hono-client-cookies}"
BUDGET_STOP="${BUDGET_STOP:-3.20}"
: "${BENCH_KEY_OPENAI:?add BENCH_KEY_OPENAI to .env.bench}"

[ -x "$AB_BIN" ] || { echo "missing $AB_BIN" >&2; exit 1; }

spent() {
  bun -e '
    const { readdirSync, existsSync } = require("fs");
    let total = 0;
    for (const f of readdirSync("results")) {
      if (!f.startsWith("oai-") || !f.endsWith(".json")) continue;
      const r = await Bun.file("results/" + f).json();
      for (const x of r.runs ?? []) total += x.reportedCost ?? 0;
    }
    console.log(total.toFixed(3));
  '
}

# <label> <model> <reps> <desc|-> <budget|->
run_round() {
  local label="$1" model="$2" reps="$3" desc="$4" budget="$5"
  local sofar; sofar="$(spent)"
  if bun -e "process.exit(Number('$sofar') > Number('$BUDGET_STOP') ? 0 : 1)"; then
    echo "== ${label}: SKIPPED — spent \$${sofar} > \$${BUDGET_STOP} gate =="
    return 0
  fi
  echo "== ${label}: ${model} reps=${reps}${desc:+ DESC}${budget:+ GB=$budget} — spent so far \$${sofar} =="
  BENCH_KEY_EMPRYO="$BENCH_KEY_OPENAI" \
  OPENAI_API_KEY="$BENCH_KEY_OPENAI" \
  EMPRYO_BIN="$AB_BIN" \
  EMPRYO_LEAN_DESC="$desc" \
  EMPRYO_GENOME_BUDGET="$budget" \
  bun src/run.ts --label "$label" --agents empryo --tasks "$TASK" \
    --reps "$reps" --model "openai/${model}" --resume --no-proxy
}

run_round oai-old-terra  gpt-5.6-terra 3 ""  ""
run_round oai-desc-terra gpt-5.6-terra 3 "1" "4000"
run_round oai-old-sol    gpt-5.6-sol   1 ""  ""
run_round oai-desc-sol   gpt-5.6-sol   1 "1" "4000"
run_round oai-old-luna   gpt-5.6-luna  1 ""  ""
run_round oai-desc-luna  gpt-5.6-luna  1 "1" "4000"

echo ""
echo "done — total OpenAI spend: \$$(spent) · results/oai-*.json"
