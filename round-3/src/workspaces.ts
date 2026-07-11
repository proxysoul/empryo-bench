/**
 * Per-agent Anthropic workspaces — the strongest cache-isolation boundary the
 * provider offers.
 *
 * Anthropic's prompt cache is isolated per ORGANIZATION and, on the Claude API,
 * per WORKSPACE within it. Two agents on keys belonging to different workspaces
 * therefore cannot read each other's cached prefixes — the shared-system-prompt
 * contamination the `--cooldown` waiting game only *mitigates* becomes
 * structurally impossible, and each workspace's usage page is an independent
 * per-agent cost source.
 *
 * What this script can and cannot do (Admin API, `sk-ant-admin…`):
 *  - CREATE workspaces:      POST /v1/organizations/workspaces          ✓
 *  - LIST workspaces:        GET  /v1/organizations/workspaces          ✓
 *  - ARCHIVE workspaces:     POST /v1/organizations/workspaces/{id}/archive ✓
 *  - CREATE api keys:        NOT EXPOSED — the Admin API only lists and
 *    updates keys. Every key has to be minted by a human in the Console,
 *    inside the target workspace. This script prints the exact console link
 *    and the env var each key belongs in.
 *
 * Usage:
 *   ANTHROPIC_ADMIN_KEY=sk-ant-admin... bun src/workspaces.ts [--prefix bench-soul] [--list] [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS } from "./agents.ts";
import type { AgentId } from "./types.ts";

const API = "https://api.anthropic.com/v1/organizations/workspaces";

interface Workspace {
  id: string;
  name: string;
  archived_at: string | null;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function keyEnvName(agent: AgentId): string {
  return `BENCH_KEY_${agent.toUpperCase().replace(/-/g, "_")}`;
}

async function api<T>(
  path: string,
  auth: Auth,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const resp = await fetch(path, {
    method: init?.method ?? "GET",
    headers: {
      ...auth.header,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!resp.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

async function main(): Promise<void> {
  const auth = resolveAuth();
  if (!auth) {
    console.error(
      "No admin credential found.\n" +
        "  ANTHROPIC_ADMIN_KEY=sk-ant-admin…  (Console → Settings → Organization → Admin keys)\n" +
        "  …or log in with the Anthropic CLI so ~/.config/anthropic/credentials exists.\n" +
        "The admin key is org-wide: use it only here, never hand it to an agent.",
    );
    process.exit(1);
  }
  console.error(`[workspaces] auth: ${auth.source}`);
  const prefix = arg("prefix") ?? "bench-soul";
  const existing = await api<{ data: Workspace[] }>(`${API}?limit=100`, auth);
  const live = existing.data.filter((w) => !w.archived_at);

  if (has("list")) {
    for (const w of live) console.error(`  ${w.id}  ${w.name}`);
    return;
  }

  const rows: { agent: AgentId; workspace: Workspace; created: boolean }[] = [];
  for (const agent of AGENT_IDS) {
    const name = `${prefix}-${agent}`;
    const found = live.find((w) => w.name === name);
    if (found) {
      rows.push({ agent, workspace: found, created: false });
      continue;
    }
    if (has("dry-run")) {
      console.error(`[workspaces] would create ${name}`);
      continue;
    }
    const created = await api<Workspace>(API, auth, { method: "POST", body: { name } });
    rows.push({ agent, workspace: created, created: true });
  }
  if (has("dry-run")) return;

  console.error(`\n[workspaces] ${rows.filter((r) => r.created).length} created, ${rows.filter((r) => !r.created).length} reused\n`);
  console.error("Mint ONE key per workspace in the Console (the Admin API cannot create keys),");
  console.error("then export it under the matching variable:\n");
  for (const { agent, workspace } of rows) {
    console.error(`  ${workspace.name}`);
    console.error(`    console: https://console.anthropic.com/settings/workspaces/${workspace.id}/keys`);
    console.error(`    export ${keyEnvName(agent)}=sk-ant-...\n`);
  }
  console.error(
    "Why per-workspace: Anthropic isolates the prompt cache per workspace, so no\n" +
      "agent can read another's cached prefix — and each workspace's usage page\n" +
      "bills that agent alone.",
  );
}

await main();
interface Auth {
  header: Record<string, string>;
  source: string;
}

/**
 * Admin credentials, in order of preference:
 *  1. ANTHROPIC_ADMIN_KEY — the documented Admin API credential (`x-api-key`).
 *  2. The Anthropic CLI's OAuth login (`~/.config/anthropic/credentials/`),
 *     sent as a bearer. Whether an org-management call is accepted depends on
 *     the token's scope and the org's plan — the API is the arbiter, so we try
 *     it and report exactly what comes back rather than guessing.
 */
function resolveAuth(): Auth | null {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (adminKey) return { header: { "x-api-key": adminKey }, source: "ANTHROPIC_ADMIN_KEY" };

  const credPath = join(homedir(), ".config", "anthropic", "credentials", "default.json");
  if (!existsSync(credPath)) return null;
  try {
    const cred = JSON.parse(readFileSync(credPath, "utf8")) as {
      access_token?: string;
      expires_at?: number;
      scope?: string;
      organization_name?: string;
    };
    if (!cred.access_token) return null;
    if (cred.expires_at && cred.expires_at * 1000 < Date.now()) {
      console.error("[workspaces] CLI OAuth token has expired — re-run the CLI login");
      return null;
    }
    return {
      header: { authorization: `Bearer ${cred.access_token}` },
      source: `anthropic CLI login (${cred.organization_name ?? "?"}, scope: ${cred.scope ?? "?"})`,
    };
  } catch {
    return null;
  }
}
