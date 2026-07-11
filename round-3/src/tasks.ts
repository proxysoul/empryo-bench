/**
 * Task manifest — real bugs, real repo (honojs/hono), real merged fixes.
 *
 * Selection rules:
 *  - the fix PR is MERGED upstream; the workspace is reset to `mergeSha^`
 *    (parent of the merge = bug live), history rewritten to a single baseline
 *    commit so `git log` cannot reveal the fix
 *  - the bug report contains NO file/line hints — agents must localize
 *  - the fix PR ships its own regression tests → those are the hidden
 *    acceptance checks, dropped in AFTER the agent runs
 *  - those tests must grade BEHAVIOUR, not the shape of the author's fix. A
 *    test that pins a signature the fix introduced (a new parameter, a new
 *    exported helper, an exact cache-key format) grades design-guessing: a
 *    correct fix that named things differently fails it. Candidates rejected
 *    for exactly this: opencode's retry-jitter fix (its test pins
 *    `delay(attempt, error, random)` and the precise jitter formula), its
 *    branch-keyed repository cache (pins `cachePath(root, ref, branch)` and
 *    the `@branch` naming), and its compaction fix (asserts verbatim prompt
 *    strings). Screen with: does every hidden assertion call an API that
 *    already exists on the buggy baseline?
 *  - the fix must be merged AFTER every current model's training cutoff so
 *    the patch cannot be memorized. Verified 2026-08-11: fixes merged
 *    2026-08-09 (#5202) and 2026-08-05 (#5189); latest Anthropic training
 *    cutoffs are May 2026 (Opus 5) and Jan 2026 (Sonnet 5 / Fable 5).
 *    Re-check this margin when new models ship.
 *  - NEVER benched before by any of the four agents' vendors as far as we can
 *    tell — earlier drafts of this harness reused tasks from an internal
 *    Empryo bench; those were replaced precisely to kill that selection bias.
 *
 * Why hono and not node/bun core: core runtimes need multi-hour native builds
 * per run, which makes the full matrix unbenchable. Hono is a real, widely
 * deployed OSS project whose suite runs in seconds on Bun — the bugs are just
 * as real.
 *
 * Why sst/opencode as a second repo: hono is small and flat, so localisation is
 * one grep and a code-intelligence layer has nothing to earn back. opencode is a
 * 30-package monorepo where the same bug class is fixed in several packages at
 * once — the shape that actually exercises cross-file reasoning. Install is
 * ~14s and the scoped suites run in 1-5s, so it stays benchable.
 * CAVEAT: opencode is also one of the harnesses this bench can measure. Never
 * score the opencode agent on an opencode task — its authors' own repo is a
 * home-field advantage no other agent gets.
 *
 * Run `bun run validate` after ANY edit to this file.
 */
import type { Task } from "./types.ts";

export const TASKS: Task[] = [
  {
    id: "hono-client-cookies",
    difficulty: "easy",
    title: "RPC client mangles multiple cookies",
    repo: "honojs/hono",
    mergeSha: "f2a72d333aed37b1bf2c18540a0a1df9fdb5c58c",
    testFiles: ["src/client/client.test.ts"],
    srcFiles: ["src/client/client.ts"],
    install: ["bun", "install"],
    testCmd: ["bunx", "vitest", "run"],
    prompt: `RPC client: multiple cookies are not sent correctly

What steps can reproduce the bug?

Create an RPC client and pass more than one cookie on a request:

const client = hc<AppType>('http://localhost/api')
await client.hello.$get(
  {},
  {
    init: {
      // two cookies for the request
    },
  },
)

When the client serializes two cookies, the server receives a Cookie header like:

hello=world; Path=/,goodbye=moon; Path=/

What is the expected result?
The server should receive both cookies as a standard request Cookie header:

hello=world; goodbye=moon

What do you see instead?
Response-only attributes like "Path=/" leak into the request header, and because the pairs are joined with a comma instead of "; ", Hono's cookie parser on the server reads the second pair as part of the Path attribute — the goodbye cookie never arrives.

Please find the root cause in this repo and fix it. Fix the source only — do NOT write or modify tests; the fix will be verified against an existing held-out test suite.`,
  },
  {
    id: "hono-trie-multipart-param",
    difficulty: "hard",
    title: "TrieRouter breaks when a regexp param spans 3+ path parts",
    repo: "honojs/hono",
    mergeSha: "569b4191a291ef7a4116881e521c3a0179407332",
    testFiles: ["src/router/common.case.test.ts", "src/router/trie-router/node.test.ts"],
    srcFiles: ["src/router/trie-router/node.ts"],
    install: ["bun", "install"],
    testCmd: ["bunx", "vitest", "run"],
    prompt: `Routes with a multi-part regexp param stop matching at depth 3, and middleware runs twice

Both symptoms reproduce on a plain new Hono() app — RegExpRouter reports UnsupportedPathError for these routes, so SmartRouter falls through to TrieRouter.

Symptom 1 — a route stops matching once the captured path spans 3 or more parts:

app.get('/:dirs{.+}/file.html', (c) => c.text('ok'))

/foo/file.html          → 200
/foo/bar/file.html      → 200
/foo/bar/baz/file.html  → 404   (expected 200)
/a/b/c/d/file.html      → 404   (expected 200)

Symptom 2 — middleware registered with a pattern like this runs twice per request:

const app = new Hono()
let runs = 0
app.use('/:path{.*}/*', async (c, next) => { runs++; await next() })
app.get('/a/b/c', (c) => c.text('ok'))

await app.request('/a/b/c')
// runs === 2, expected 1

At the raw router level:

const r = new TrieRouter()
r.add('GET', '/:file{.*}/*', 'handler')
r.match('GET', '/a/b/c')
// returns the handler twice, expected once

RegExpRouter and PatternRouter return the correct result in every case above; only TrieRouter misbehaves.

Please find the root cause and fix it. Fix the source only — do NOT write or modify tests; the fix will be verified against an existing held-out test suite.`,
  },
  {
    id: "opencode-grep-symlink-path",
    difficulty: "easy",
    title: "grep resolves a symlinked search root to its real path",
    repo: "sst/opencode",
    mergeSha: "e63996919b6267d00a5ea224ab03b0f58fbd15d8",
    testFiles: ["packages/opencode/test/tool/grep.test.ts"],
    srcFiles: ["packages/opencode/src/tool/grep.ts"],
    install: ["bun", "install"],
    testCmd: ["bun", "test"],
    testCwd: "packages/opencode",
    prompt: `grep reports matches under the symlink target instead of the path I searched

What steps can reproduce the bug?

Make a real directory with a file in it, and a symlink pointing at that directory:

  mkdir -p /tmp/demo/real
  echo needle > /tmp/demo/real/test.txt
  ln -s /tmp/demo/real /tmp/demo/alias

Then run the grep tool with pattern "needle" and path "/tmp/demo/alias".

What is the expected result?
One match, reported as /tmp/demo/alias/test.txt — the path I actually searched.

What do you see instead?
The match count is right, but the path comes back as /tmp/demo/real/test.txt. The symlink has been resolved away, so every result points somewhere I never asked about.

It has a second, worse consequence: because the reported path is no longer inside the directory I searched, the tool decides it is touching an external directory and raises an external-directory permission request — even when the search root I passed is explicitly allowed. Granting access to the alias is not enough; the permission check is being made against a path the caller never mentioned.

Searching a real (non-symlinked) directory behaves correctly, so this only shows up when the search root — or a parent of it — is a symlink.

Please find the root cause in this repo and fix it. Fix the source only — do NOT write or modify tests; the fix will be verified against an existing held-out test suite.`,
  },
  {
    id: "opencode-message-boundaries",
    difficulty: "hard",
    title: "revert and fork select messages by ID comparison instead of position",
    repo: "sst/opencode",
    mergeSha: "a54a693af242108b0b5c9db6ae498c10b2d8843b",
    testFiles: [
      "packages/opencode/test/session/revert-compact.test.ts",
      "packages/opencode/test/session/session.test.ts",
    ],
    srcFiles: [
      "packages/opencode/src/session/revert.ts",
      "packages/opencode/src/session/session.ts",
    ],
    install: ["bun", "install"],
    testCmd: ["bun", "test"],
    testCwd: "packages/opencode",
    prompt: `Undo and fork keep the wrong messages once a session's message IDs stop sorting in creation order

Message IDs are minted so that a newer message normally sorts after an older one, and several places appear to lean on that. It is not an invariant we can rely on: a session that has been running long enough — or that was resumed — ends up containing a boundary where a message created LATER has an ID that sorts BEFORE one created earlier. Messages are still stored in the right order and still carry correct creation timestamps; only their IDs stop agreeing with that order.

Once a session contains such a boundary, two user-facing operations pick the wrong messages:

1. Reverting to a message.
   Expected: the target message and everything created after it go away; everything created before it stays.
   Actual: the selection is made by comparing IDs, so it cuts at the wrong place. Messages created after the target survive the revert, and messages created before it are deleted. Reverting to a message on the "wrong" side of the boundary can even delete nothing at all. Cleaning up the revert afterwards removes the wrong set for the same reason.

2. Forking (copying) a session at a message.
   Expected: the new session contains exactly the messages created before the fork point.
   Actual: the copied prefix is chosen by ID comparison too, so the fork either carries over messages that came after the fork point or drops ones that came before it.

Reproduction: create a session, add four messages whose creation order is 1, 2, 3, 4 but whose IDs sort as 3, 4, 1, 2 (i.e. the third message's ID sorts before the first two). Revert to the second message and then fork at the second message; both operate on the wrong subset.

Note this is not about sorting the messages for display — they are already returned in the correct order. The defect is in how the cut point is chosen from that ordered list.

Please find the root cause in this repo and fix it. Fix the source only — do NOT write or modify tests; the fix will be verified against an existing held-out test suite.`,
  },
];

export function taskById(id: string): Task {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task: ${id}`);
  return t;
}
