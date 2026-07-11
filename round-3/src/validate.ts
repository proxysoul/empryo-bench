/**
 * Harness validity check — proves every task is a REAL, discriminating test
 * without spending a single LLM token:
 *
 *   1. pristine workspace (bug live) → hidden tests must FAIL
 *   2. apply the real upstream fix    → hidden tests must PASS
 *
 * If (1) passes the bug isn't live (agents would win for free); if (2) fails
 * the acceptance gate is broken (agents could never win). Run this after
 * adding or editing any task, and once before every paid bench.
 *
 * Usage: bun src/validate.ts [--tasks id,id]
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWorkspace, HIDDEN_DIR, prepTask, sh, verify } from "./prep.ts";
import { TASKS } from "./tasks.ts";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const taskFilter = arg("tasks");
const tasks =
  !taskFilter || taskFilter === "all"
    ? TASKS
    : TASKS.filter((t) => taskFilter.split(",").includes(t.id));

let failures = 0;
for (const task of tasks) {
  prepTask(task);
  const dir = join(tmpdir(), `soul-validate-${task.id}`);
  copyWorkspace(task, dir);

  const before = verify(dir, task);
  if (before.pass) {
    console.error(`[validate] ✗ ${task.id}: hidden tests PASS on the buggy baseline — bug not live`);
    failures++;
    rmSync(dir, { recursive: true, force: true });
    continue;
  }
  console.error(`[validate] · ${task.id}: buggy baseline fails hidden tests (good)`);

  const patch = join(HIDDEN_DIR, task.id, "_reference-fix.patch");
  const applied = sh(["git", "apply", patch], dir);
  if (applied.code !== 0) {
    console.error(`[validate] ✗ ${task.id}: reference fix does not apply — ${applied.out.slice(-200)}`);
    failures++;
    rmSync(dir, { recursive: true, force: true });
    continue;
  }

  const after = verify(dir, task);
  if (!after.pass) {
    console.error(`[validate] ✗ ${task.id}: hidden tests still fail WITH the real fix — ${after.reason?.slice(-200)}`);
    failures++;
  } else {
    console.error(`[validate] ✓ ${task.id}: real fix turns hidden tests green — task is sound`);
  }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`[validate] ${failures} task(s) INVALID`);
  process.exit(1);
}
console.error(`[validate] all ${tasks.length} task(s) sound — fail-before, pass-after`);
