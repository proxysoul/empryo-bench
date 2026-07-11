# Round 3 — six models, two providers

[Empryo](https://empryo.com)'s Forge v2 engine vs [pi](https://github.com/badlogic/pi-mono)
at its leanest possible shape. Four real merged bugs (hono + opencode), hidden
acceptance tests, six models from Haiku 4.5 to Opus 5 across Anthropic and
OpenAI. 96 recorded runs, Aug 2026. A local metering proxy sits on the Anthropic
wire and prices every response's usage at list rates — the receipts ship in
`results/*.wire.jsonl`.

**Full story with charts: [empryo.com/benchmarks/forge-v2](https://empryo.com/benchmarks/forge-v2)**

## The wins

| tier | result |
|---|---|
| **Opus 5** | **−27% cost · −40% wall clock** — $2.27 vs $3.10 a round, both fixed 4/4 |
| **GPT-5.6 luna** | **100% fixed vs 88%** — the only accuracy gap on the board, in Empryo's favor |
| **Haiku 4.5** | **−11% wall clock**, same bugs fixed \* |
| **vs our own Forge v1** | **half the price** — Opus −56%, terra −46%, luna went from fixing half to fixing all |

The smarter the model, the cheaper Empryo gets: strong models know what to do
with a live map of the code, so v2 hands them the short tour and skips the
manual. Accuracy never finished behind pi on any tier. Every run — both agents,
all six models — is in `results/`, raw.

\* On Haiku a one-cent helper model preps the ground first; pi ran barebone.

## What's here

- `run-final.sh` + `src/` — the driver: one model per invocation, three lanes
  (Forge v1 / Forge v2 / pi). The empryo lanes share one binary, one key, one
  task list — the ONLY difference is `agentFeatures.forgeV2` in the workspace
  config, so the delta is attributable to the engine
- `run-openai.sh` — the second-provider lanes (terra / luna / sol)
- `results/final-*.json` — the full board; `final-*.wire.jsonl` — the wire receipts
- `report-final.ts` — renders the scoreboard HTML from `results/` locally
- `FINALE.md` — the audited-run protocol (per-workspace keys, symmetric fail rules)

## Reproduce

```sh
bun install
cp .env.bench.example .env.bench    # your own keys, one per lane
./run-final.sh haiku                # ~$3 a round · REPS=3 for medians
./run-final.sh opus                 # the expensive one
```

Tasks are real merged fixes chosen after every current model's training cutoff.
The workspace resets to the pre-fix commit and git history is rewritten to a
single baseline commit — `git log` cannot leak the answer. Hidden acceptance is
the fix PR's own regression tests, dropped in after the run.
