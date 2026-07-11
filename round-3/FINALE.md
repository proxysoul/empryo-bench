# The Finale — audited Forge v2 vs pi rounds

Dev-loop iteration is done; the engine configuration is frozen at empryo `3502325c`
(binary `bin/empryo-v29`). This file is the exact protocol for the audited rounds
whose numbers go in the published report.

## 1 · What you provision (once)

**Anthropic** — three workspaces in the Console, one API key each:

| Workspace | Key lands in `.env.bench` as |
|---|---|
| `bench-v1` | `BENCH_KEY_V1` |
| `bench-v2` | `BENCH_KEY_V2` |
| `bench-pi` | `BENCH_KEY_PI` |

**OpenAI** — three projects, one key each: `BENCH_KEY_V1_OAI`, `BENCH_KEY_V2_OAI`,
`BENCH_KEY_PI_OAI`.

Per-workspace/project keys mean the provider's own billing page shows each lane's
exact spend — no self-reported numbers survive into the final report (pi's luna
self-report claimed "$0.005, 4 steps" for a 4-task round; the passes were real,
the meter was not).

## 2 · What runs

All serial (wall-time fairness), sterile home for empryo lanes, `bin/empryo-v29`:

| Tier | Lanes | Reps | Est. cost |
|---|---|---|---|
| Haiku 4.5 | v1, **v2+marionette**, pi | **3** (hard tasks are rate games) | ~$18 |
| Sonnet 5 | v1, v2, pi | 1 | ~$8 |
| Opus 5 (effort high) | v1, v2, pi | 1 | ~$11 |
| gpt-5.6-luna | v1, v2, pi | 2 (cheap, kills variance) | ~$1 |
| gpt-5.6-terra (high) | v1, v2, pi | 1 | ~$4 |
| gpt-5.6-sol (high) | v1, v2, pi | 1 | ~$12 |

Total ≈ **$54** across both providers (Option B pacing: ×3 where variance
decides, ×1 where runs are stable and expensive — see the cost options table
discussed in-session; Option C drops v1 from opus/sol/terra for ≈$37).

Marionette is no longer optional for haiku: the dev loop's hard-pair A/B
(`mar-v2-haiku`) scored 3/4 — including the ONLY empryo-haiku trie pass in six
attempts — for a $0.012/task pre-pass. `v2+marionette` IS the haiku lane.
It is haiku-ONLY: on terra the same pre-pass measured NEGATIVE (4/4 held but
$0.903 vs plain v2's $0.705, worse wall) — a capable model pays the pre-pass
tax without needing the rescue. Same law as every other v2 surface: priced to
capability.

Note: luna's dev-loop 4/4 ran pre-budget-tier (map still on). v29 makes luna
mapless — the finale's luna reps double as that validation (cost of being
wrong: ~$0.08).

## 2.5 · Wall-time policy (user ruling)

Benchmarks time the AGENT WORKING, not pre-working: fixture caches carry a
pre-built genome index (`bun src/prewarm.ts`, mtime-verified by the engine on
open), so the one-time cold index never sits inside a run's wall clock. The
cold index is reported once as a fixed number (96–100s opencode / 8s hono).
Re-run prewarm after any `prep.ts` cache rebuild.

## 3 · How to read the outcome

- Every empryo number is triple-sourced: engine self-report, metering-proxy wire
  count (Anthropic lanes), provider billing page. All three must agree.
- pi numbers: provider billing page (theirs) + our verify() correctness. Steps
  and wall from the harness.
- Blocked runs render as blocked. n is printed per cell. Nothing is dropped.

## 4 · Session findings already frozen into the engine

1. Result governor (86k-token single-result class dead)
2. Price-gated lean belt (eager schemas 35.7k→18.4k bytes on frontier models)
3. `<root_causing>` empirical-debugging discipline (cheap tiers)
4. Budget tier: no upfront map ≤$1/M — controlled A/B: map 0/2+0/2 vs mapless 2/2 on the multi-file bug
5. Response chaining opt-in (reasoning retention costs more than replay at high effort)
6. Hypothesis-loop steer, lean skills directive, sticky price verdicts
7. Bench integrity: sterile home, OpenAI usage-convention normalization, honest blocked rendering
