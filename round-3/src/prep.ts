/**
 * Workspace prep — builds a pristine per-task cache once, then each run gets
 * an instant APFS clonefile copy of it.
 *
 * Per task:
 *  1. fetch the fix PR's merge commit (depth 2)
 *  2. extract the PR's own test files + the real fix patch → hidden/ (judge +
 *     acceptance material, never inside a workspace)
 *  3. checkout mergeSha^ (bug live), DELETE history, re-init as a single
 *     "baseline" commit — `git log` / `git diff` cannot reveal the fix
 *  4. install deps
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TASKS } from "./tasks.ts";
import type { Task } from "./types.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const CACHE_DIR = join(ROOT, "cache");
export const HIDDEN_DIR = join(CACHE_DIR, "_hidden");

export function sh(
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
  return { code: proc.exitCode ?? 1, out: `${proc.stdout.toString()}\n${proc.stderr.toString()}` };
}

export function prepTask(task: Task): void {
  const cache = join(CACHE_DIR, task.id);
  const marker = join(cache, ".bench-soul-ready");
  if (existsSync(marker)) return;
  console.error(`[prep] ${task.id} (${task.repo})…`);
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });

  sh(["git", "init", "-q", "."], cache);
  let r = sh(
    ["git", "fetch", "-q", "--depth", "2", `https://github.com/${task.repo}.git`, task.mergeSha],
    cache,
  );
  if (r.code !== 0) throw new Error(`fetch failed for ${task.id}: ${r.out.slice(-400)}`);

  // Hidden material: the fix PR's tests + the reference fix patch (for the judge).
  sh(["git", "checkout", "-q", task.mergeSha], cache);
  for (const f of task.testFiles) {
    const dest = join(HIDDEN_DIR, task.id, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(cache, f)));
  }
  const patch = sh(
    ["git", "diff", `${task.mergeSha}^`, task.mergeSha, "--", ...task.srcFiles],
    cache,
  );
  mkdirSync(join(HIDDEN_DIR, task.id), { recursive: true });
  writeFileSync(join(HIDDEN_DIR, task.id, "_reference-fix.patch"), patch.out);

  // Bug-live state with scrubbed history.
  r = sh(["git", "checkout", "-q", `${task.mergeSha}^`], cache);
  if (r.code !== 0) throw new Error(`checkout base failed for ${task.id}`);
  rmSync(join(cache, ".git"), { recursive: true, force: true });
  sh(["git", "init", "-q", "-b", "main", "."], cache);
  sh(["git", "add", "-A"], cache);
  sh(
    ["git", "-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-q", "-m", "baseline"],
    cache,
  );

  console.error(`[prep]   install: ${task.install.join(" ")}`);
  r = sh(task.install, cache, 900_000);
  if (r.code !== 0) throw new Error(`install failed for ${task.id}: ${r.out.slice(-400)}`);
  writeFileSync(marker, new Date().toISOString());
  console.error(`[prep]   ${task.id} ready`);
}

/** APFS clonefile copy — node_modules included, near-instant, symlink-safe. */
export function copyWorkspace(task: Task, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  const r = sh(["cp", "-cR", join(CACHE_DIR, task.id), dest], tmpdir());
  if (r.code !== 0) {
    cpSync(join(CACHE_DIR, task.id), dest, { recursive: true, verbatimSymlinks: true });
  }
  rmSync(join(dest, ".bench-soul-ready"), { force: true });
}

/** Drop the fix PR's tests over the workspace and run them. A pass proves the
 *  fix works AND the module didn't regress (the PR test file = pre-existing
 *  cases + new regression cases). */
export function verify(dir: string, task: Task): { pass: boolean; reason?: string } {
  for (const f of task.testFiles) {
    const src = join(HIDDEN_DIR, task.id, f);
    const dest = join(dir, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
  }
  const testDir = task.testCwd ? join(dir, task.testCwd) : dir;
  const relTests = task.testFiles.map((f) =>
    task.testCwd && f.startsWith(`${task.testCwd}/`) ? f.slice(task.testCwd.length + 1) : f,
  );
  const r = sh([...task.testCmd, ...relTests], testDir, 600_000);
  if (r.code !== 0) return { pass: false, reason: `acceptance: ${r.out.slice(-300)}` };
  return { pass: true };
}

if (import.meta.main) {
  for (const task of TASKS) prepTask(task);
  console.error("[prep] all task caches ready");
}
