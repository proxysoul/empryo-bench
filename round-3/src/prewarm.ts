/**
 * Pre-warm the genome index inside each cache fixture, so every APFS clone a
 * run makes starts with a ready .empryo/genome.db instead of paying a cold
 * 60–105s index on the monorepo fixtures.
 *
 * Fairness: the db is derived purely from repo content; the engine's scan is
 * mtime/size-incremental, and `cp -cR` preserves both, so a clone re-verifies
 * the index instead of rebuilding it — exactly the returning-user/CI shape.
 * The cold one-time index cost stays reported separately in the method notes.
 * pi is unaffected either way (it has no index to warm).
 *
 *   bun src/prewarm.ts             → warms every cache/<task>
 *   bun src/prewarm.ts <task-id>   → warms one
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Dev-only utility: needs an empryo source checkout to import the genome engine.
const EMPRYO_REPO = process.env.EMPRYO_REPO ?? "";
if (!EMPRYO_REPO) {
  console.error("set EMPRYO_REPO to an empryo source checkout (prewarm is optional — runs just pay the one-time cold index instead)");
  process.exit(1);
}
const CACHE = join(import.meta.dir, "..", "cache");

const only = process.argv[2];
const dirs = readdirSync(CACHE).filter((d) => {
  if (only && d !== only) return false;
  return existsSync(join(CACHE, d, ".git")) || existsSync(join(CACHE, d, "package.json"));
});

const { Genome } = await import(join(EMPRYO_REPO, "packages", "genome", "src", "genome.ts"));

for (const d of dirs) {
  const dir = join(CACHE, d);
  const t0 = performance.now();
  const genome = new Genome(dir);
  try {
    await genome.scan();
    const stats = genome.getStats();
    console.log(
      `[prewarm] ${d}: ${String(stats.files)} files · ${String(stats.symbols)} symbols · ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    genome.close();
  }
}
