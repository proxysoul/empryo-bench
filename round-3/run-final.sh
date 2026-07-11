#!/usr/bin/env bash
# Forge v1 vs Forge v2 vs pi — one model per invocation, all four tasks.
#
# The ONLY difference between the two empryo lanes is `agentFeatures.forgeV2`
# in the workspace config: same binary, same flags, same key, same tasks. That
# is what makes the delta attributable to the engine rather than to a build.
#
#   ./run-final.sh haiku          # claude-haiku-4-5, 1 rep   (~$3)
#   REPS=3 ./run-final.sh haiku   # medians
#   ./run-final.sh sonnet         # claude-sonnet-5 (intro pricing to 2026-08-31)
#   ./run-final.sh opus           # claude-opus-5 --effort high   (the expensive one)
#   LANES="v2 pi" ./run-final.sh haiku
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env.bench ] && set -a && . ./.env.bench && set +a

TIER="${1:?usage: run-final.sh <haiku|sonnet|opus|terra|luna|sol>}"
REPS="${REPS:-1}"
LANES="${LANES:-v1 v2 pi}"
BIN="${EMPRYO_BIN:-$HOME/.empryo/bin/empryo-v21}"
TASKS="${TASKS:-hono-client-cookies,hono-trie-multipart-param,opencode-grep-symlink-path,opencode-message-boundaries}"
# The opencode tasks live in a 30-package monorepo and run ~6 min on Haiku, all
# of it API time (measured: 345s span, 1s local). 480s would score slow-but-
# correct runs as failures, so the ceiling moves with the fixture, not the agent
# — it is identical for every lane.
RUN_TIMEOUT="${RUN_TIMEOUT:-900}"

case "$TIER" in
  haiku)  MODEL=claude-haiku-4-5; EFFORT="" ;;
  sonnet) MODEL=claude-sonnet-5;  EFFORT=high ;;
  opus)   MODEL=claude-opus-5;    EFFORT=high ;;
  terra)  MODEL=openai/gpt-5.6-terra; EFFORT=high ;;
  luna)   MODEL=openai/gpt-5.6-luna;  EFFORT=high ;;
  sol)    MODEL=openai/gpt-5.6-sol;   EFFORT=high ;;
  *) echo "unknown tier: $TIER" >&2; exit 1 ;;
esac

[ -x "$BIN" ] || { echo "missing empryo binary: $BIN" >&2; exit 1; }

# One key for every lane. Serial runs only, so the metering proxy still
# attributes each request by flushing the lane at the end of each run — see the
# --parallel guard in src/run.ts, which refuses exactly this setup concurrently.
case "$TIER" in
  terra|luna|sol) KEY="${BENCH_KEY_OPENAI:?add BENCH_KEY_OPENAI to .env.bench}" ;;
  *)              KEY="${BENCH_ANTHROPIC_KEY:?add BENCH_ANTHROPIC_KEY to .env.bench}" ;;
esac

run_lane() {
  local lane="$1" label="final-${1}-${TIER}"
  local extra=(); [ -n "$EFFORT" ] && extra+=(--effort "$EFFORT")
  echo "== ${label}: ${MODEL} reps=${REPS} =="
  case "$lane" in
    v1|v2)
      local cfg='{"agentFeatures":{"forgeV2":false}}'
      [ "$lane" = v2 ] && cfg='{"agentFeatures":{"forgeV2":true}}'
      BENCH_KEY_EMPRYO="$KEY" EMPRYO_BIN="$BIN" EMPRYO_PROJECT_CONFIG="$cfg" \
        bun src/run.ts --label "$label" --agents empryo --tasks "$TASKS" \
          --reps "$REPS" --model "$MODEL" --resume --allow-agent-keys \
          --run-timeout "$RUN_TIMEOUT" ${extra[@]+"${extra[@]}"}
      ;;
    pi)
      BENCH_KEY_PI="$KEY" \
        bun src/run.ts --label "$label" --agents pi --tasks "$TASKS" \
          --reps "$REPS" --model "$MODEL" --resume --allow-agent-keys \
          --run-timeout "$RUN_TIMEOUT" ${extra[@]+"${extra[@]}"}
      ;;
    *) echo "unknown lane: $lane" >&2; exit 1 ;;
  esac
}

for lane in $LANES; do run_lane "$lane"; done
echo "done — results/final-*-${TIER}.json"
