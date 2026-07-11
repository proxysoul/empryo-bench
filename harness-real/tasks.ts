/**
 * Round-3 task manifest — real bugs from real OSS repos.
 *
 * Selection rules (all five verified):
 *  - fix PR merged AFTER 2026-01 (past both models' training cutoffs — the
 *    patch cannot be memorized)
 *  - the issue/report text contains NO file/line hints (agents must localize)
 *  - the fix PR ships its own regression tests → those become the hidden
 *    acceptance checks, dropped in AFTER the agent runs
 */

export interface RealTask {
  id: string;
  repo: string; // owner/name
  /** Merge commit of the fix PR. Agent runs at mergeSha^ (parent = pre-fix). */
  mergeSha: string;
  /** Test files from the fix PR (hidden acceptance — applied post-run). */
  testFiles: string[];
  /** Source files the real fix touched (recorded for the report; never shown). */
  srcFiles: string[];
  /** Install command (repo conventions). */
  install: string[];
  /** Command that runs ONLY the hidden test files (paths appended, made
   *  relative to testCwd when set). */
  testCmd: string[];
  /** Subdirectory to run testCmd from (monorepo packages). */
  testCwd?: string;
  /** The report given to the agent, verbatim from the issue/PR. */
  prompt: string;
}

export const REAL_TASKS: RealTask[] = [
  {
    id: "hono-rpc-headers",
    repo: "honojs/hono",
    mergeSha: "f9992096de71151b8271f1cd7f45986bdd5f2b7f",
    testFiles: ["src/client/client.test.ts"],
    srcFiles: ["src/client/client.ts"],
    install: ["bun", "install"],
    testCmd: ["bunx", "vitest", "run"],
    prompt: `RPC headers not merging when function

What version of Hono are you using?
4.12.21

What runtime/platform is your app running on?
Node 24.15.0

What steps can reproduce the bug?

Create a RPC client, passing in headers using a function:

const client = hc<AppType>('/api', {
  headers: async () => {
    return {
      Authorization: await getToken(),
    }
  },
})

Call a api using the client, passing in additional headers:

await client.search.$get(
  {},
  {
    headers: {
      'X-User-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  },
)

What is the expected result?
Both the Authorization header (from the client factory function) and the X-User-Timezone header (from the request) are sent.

What do you see instead?
Only one of them is applied — the per-request headers are not merged with the function-provided headers.

Please fix this bug in the repo.`,
  },
  {
    id: "hono-trie-wildcard",
    repo: "honojs/hono",
    mergeSha: "0fc7ffc94988d0dce19477d3e1cce29f3c2da1cb",
    testFiles: [
      "src/router/common.case.test.ts",
      "src/router/linear-router/router.test.ts",
      "src/router/trie-router/node.test.ts",
    ],
    srcFiles: ["src/router/trie-router/node.ts"],
    install: ["bun", "install"],
    testCmd: ["bunx", "vitest", "run"],
    prompt: `TrieRouter: /* wildcard does not match empty remainder after a regexp-constrained param

In TrieRouter, a /* wildcard registered after a regexp-constrained param — e.g. /:id{[0-9]+}/* — does not match the empty remainder (bare path /12), even though the plain-param form /:id/* does. Non-empty remainders (/12/y) match; only the empty-remainder case is broken.

Steps to reproduce:

import { TrieRouter } from 'hono/router/trie-router';
const router = new TrieRouter();
router.add('GET', '/:x{[0-9]+}/*', 'W');
router.match('GET', '/12');   // expected: matches 'W', observed: no match
router.match('GET', '/12/y'); // matches 'W' as expected

The LinearRouter handles the bare-path case correctly; TrieRouter does not.

Please find the root cause and fix it.`,
  },
  {
    id: "zod-preprocess-catch",
    repo: "colinhacks/zod",
    mergeSha: "1cab69383fcdeae2a366d5e2a2fc4d8fc765d168",
    testFiles: ["packages/zod/src/v4/classic/tests/catch.test.ts"],
    srcFiles: ["packages/zod/src/v4/core/schemas.ts"],
    install: ["pnpm", "install", "--ignore-scripts"],
    testCmd: ["npx", "vitest", "run", "--project", "zod"],
    prompt: `Upgrading from 4.3.6 to 4.4.x causes issues with preprocess + catch

I am using zod to parse payload we received from URLSearchParams, which requires transforming comma-separated string values into an array of string (which can potentially be empty/undefined). In v4.3.6 and below, the following schema works:

z.object({
  area: z.preprocess(v => v ? v.toString().split(',') : [], z.array(z.string())).catch([])
})

And the payload is as follow:

{}

In 4.3.6 parsing this payload succeeds (area falls back via catch). After upgrading to 4.4.x, the same schema and payload now throws / fails to parse when the key is absent.

This is a regression in the current code of this repo. Please find the root cause and fix it.`,
  },
  {
    id: "ky-hooks-request",
    repo: "sindresorhus/ky",
    mergeSha: "aec65dbdb196860260851bb33c0988aa75e9b2a8",
    testFiles: ["test/hooks.ts"],
    srcFiles: ["source/core/Ky.ts", "source/types/hooks.ts"],
    install: ["npm", "install", "--ignore-scripts"],
    testCmd: ["npx", "ava"],
    prompt: `beforeRequest hooks are skipped when a Request is returned

When a beforeRequest hook returns a new Request object, the remaining beforeRequest hooks are skipped entirely — ky proceeds straight to the fetch with that Request. Returning a Request from one hook shouldn't silently disable the other registered hooks; they should keep running (receiving the new Request) before the request is sent.

Repro sketch:

ky.get(url, {
  hooks: {
    beforeRequest: [
      (request) => new Request(request, {headers: {...}}), // returns a Request
      (request) => { /* this hook never runs */ },
    ],
  },
});

Please find the root cause in this repo and fix it so later hooks still run.`,
  },
  {
    id: "ky-extend-retry",
    repo: "sindresorhus/ky",
    mergeSha: "06375efbacfc1bdc96f7a4de7560684b765e1274",
    testFiles: ["test/retry.ts"],
    srcFiles: ["source/utils/merge.ts"],
    install: ["npm", "install", "--ignore-scripts"],
    testCmd: ["npx", "ava"],
    prompt: `extend() drops numeric retry limit when merging with an object

retry accepts a number as shorthand for {limit: number} (per the docs: "If retry is a number, it will be used as limit and other defaults will remain in place.").

However, when extending a client, a numeric retry on one side and an object retry on the other do not merge correctly — the numeric limit gets lost:

const base = ky.create({retry: 3});
const extended = base.extend({retry: {methods: ['get']}});
// expected: {limit: 3, methods: ['get']}
// actual: the limit from the base client is gone

Please find the root cause in this repo and fix it.`,
  },
];
