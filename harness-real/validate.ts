/**
 * Round-3 validation — no LLM calls, no API keys.
 *
 * For every task in tasks.ts, prove the benchmark gates correctly:
 *   1. clone the repo, checkout mergeSha^ (pre-fix: the bug is live)
 *   2. install deps
 *   3. drop in the fix PR's TEST files (from mergeSha) — they must FAIL
 *   4. checkout the full fix (mergeSha) — the same tests must PASS
 *
 * A task passes validation only if the hidden tests discriminate: fail on the
 * bug, pass on the real fix. Anything else (import errors, env problems,
 * flaky suites) disqualifies the task before any tokens are spent.
 *
 *   bun bench/vs-real/validate.ts [--tasks id,id] [--keep]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_TASKS, type RealTask } from "./tasks.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const onlyIdx = args.indexOf("--tasks");
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1]?.split(",") ?? []) : null;

function run(
  cmd: string[],
  cwd: string,
  timeoutMs = 600_000,
): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    env: { ...process.env, CI: "1" },
  });
  const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  return { code: proc.exitCode ?? 1, out };
}

async function validate(task: RealTask): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), `vsr-${task.id}-`));
  console.log(`\n▶ ${task.id} (${task.repo}) → ${dir}`);
  try {
    // Fetch merge commit with depth 2 so its parent (pre-fix state) exists.
    let r = run(["git", "init", "-q", "."], dir);
    r = run(
      ["git", "fetch", "-q", "--depth", "2", `https://github.com/${task.repo}.git`, task.mergeSha],
      dir,
      300_000,
    );
    if (r.code !== 0) return fail("fetch", r.out);
    r = run(["git", "checkout", "-q", `${task.mergeSha}^`], dir);
    if (r.code !== 0) return fail("checkout base", r.out);

    console.log(`  install: ${task.install.join(" ")}`);
    r = run(task.install, dir, 600_000);
    if (r.code !== 0) return fail("install", r.out.slice(-1500));

    // Hidden tests onto the buggy base.
    r = run(["git", "checkout", "-q", task.mergeSha, "--", ...task.testFiles], dir);
    if (r.code !== 0) return fail("apply hidden tests", r.out);

    const testDir = task.testCwd ? join(dir, task.testCwd) : dir;
    const relTests = task.testFiles.map((f) =>
      task.testCwd && f.startsWith(`${task.testCwd}/`) ? f.slice(task.testCwd.length + 1) : f,
    );
    console.log("  hidden tests on BUGGY base (must FAIL)…");
    r = run([...task.testCmd, ...relTests], testDir, 600_000);
    if (r.code === 0) return fail("tests PASSED on the buggy base — non-discriminating", r.out.slice(-1200));
    // Distinguish assertion failures from a broken runner: a crash before any
    // test executes would "fail on bug" for the wrong reason.
    if (!/fail|✗|✘|AssertionError|expected/i.test(r.out)) {
      return fail("runner crashed on base (not an assertion failure)", r.out.slice(-1200));
    }
    console.log("  ✓ fail on bug");

    console.log("  full fix (must PASS)…");
    r = run(["git", "checkout", "-q", task.mergeSha], dir);
    if (r.code !== 0) return fail("checkout fix", r.out);
    // Reinstall in case the fix changed deps (rare for bugfixes; cheap no-op otherwise).
    run(task.install, dir, 600_000);
    r = run([...task.testCmd, ...relTests], testDir, 600_000);
    if (r.code !== 0) return fail("tests FAILED on the real fix", r.out.slice(-1500));
    console.log("  ✓ pass on fix — task validated");
    return true;
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`  (kept: ${dir})`);
  }

  function fail(stage: string, detail: string): false {
    console.log(`  ✗ ${stage}\n${detail.split("\n").slice(-14).join("\n")}`);
    return false;
  }
}

let ok = 0;
let bad = 0;
for (const task of REAL_TASKS) {
  if (only && !only.has(task.id)) continue;
  (await validate(task)) ? ok++ : bad++;
}
console.log(`\n${ok} validated, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
