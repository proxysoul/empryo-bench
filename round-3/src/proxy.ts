/**
 * Metering proxy — sits between every agent and api.anthropic.com and records
 * what ACTUALLY went over the wire (tokens per request, priced from the list
 * table in pricing.ts). This is the ground truth that "agent-reported cost"
 * is compared against.
 *
 * Wiring per agent (done by agents.ts):
 *  - claude code:  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 *  - empryo:       ANTHROPIC_BASE_URL (ai-sdk anthropic provider reads it)
 *  - opencode:     workspace opencode.json → provider.anthropic.options.baseURL
 *  - pi:           ANTHROPIC_BASE_URL (best-effort)
 * If an agent bypasses the proxy the run records realRequests=0 and the
 * report shows real cost as "unmetered" — never a silently wrong number.
 *
 * Control endpoints (local only):
 *  GET  /__bench/ping   → "ok"
 *  GET  /__bench/usage  → current tally (JSON)
 *  POST /__bench/flush  → returns tally, then resets it
 *
 * Standalone: bun src/proxy.ts --port 8402
 */
import { costOf } from "./pricing.ts";
import type { TokenCounts } from "./types.ts";
import { ZERO_TOKENS } from "./types.ts";
import { appendFileSync } from "node:fs";

const UPSTREAM = "https://api.anthropic.com";

export interface MeterUsage {
  requests: number;
  tokens: TokenCounts;
  cost: number;
  byModel: Record<string, TokenCounts & { cost: number; requests: number }>;
}

export interface Meter {
  port: number;
  url: string;
  usage(): MeterUsage;
  flush(): MeterUsage;
  /** Bind an API key to a lane name so concurrent agents can be metered
   *  apart — every request carries the key that paid for it. */
  bind(lane: string, apiKey: string): void;
  /** Take and reset ONE lane's tally. Requests whose key was never bound land
   *  in the shared tally reachable via flush(). */
  flushLane(lane: string): MeterUsage;
  stop(): void;
}

function emptyUsage(): MeterUsage {
  return { requests: 0, tokens: { ...ZERO_TOKENS }, cost: 0, byModel: {} };
}

export function startMeter(port = 0, logPath?: string): Meter {
  let tally = emptyUsage();
  /** apiKey → lane. Parallel runs share one proxy port; the key is what tells
   *  two simultaneous streams apart, which is exactly why every agent gets
   *  its own. */
  const laneOfKey = new Map<string, string>();
  const laneTally = new Map<string, MeterUsage>();

  function addTo(u: MeterUsage, model: string, t: TokenCounts, cost: number): void {
    u.requests += 1;
    u.tokens.input += t.input;
    u.tokens.output += t.output;
    u.tokens.cacheRead += t.cacheRead;
    u.tokens.cacheWrite += t.cacheWrite;
    u.cost += cost;
    const m = (u.byModel[model] ??= { ...ZERO_TOKENS, cost: 0, requests: 0 });
    m.input += t.input;
    m.output += t.output;
    m.cacheRead += t.cacheRead;
    m.cacheWrite += t.cacheWrite;
    m.cost += cost;
    m.requests += 1;
  }

  function record(model: string, t: TokenCounts, lane?: string): void {
    const cost = costOf(model, t);
    if (lane) {
      let u = laneTally.get(lane);
      if (!u) {
        u = emptyUsage();
        laneTally.set(lane, u);
      }
      addTo(u, model, t, cost);
    } else {
      addTo(tally, model, t, cost);
    }
    // Per-request audit trail: the ONLY way to reconcile a bench against the
    // provider's own billing line by line. Appended, never rewritten.
    if (logPath) {
      try {
        appendFileSync(
          logPath,
          `${JSON.stringify({ at: new Date().toISOString(), lane: lane ?? null, model, ...t, cost })}\n`,
        );
      } catch {
        // logging must never break a run
      }
    }
  }

  function usageFromJson(u: unknown): TokenCounts {
    const j = (u ?? {}) as Record<string, number>;
    return {
      input: j.input_tokens ?? 0,
      output: j.output_tokens ?? 0,
      cacheRead: j.cache_read_input_tokens ?? 0,
      cacheWrite: j.cache_creation_input_tokens ?? 0,
    };
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/__bench")) {
        if (url.pathname === "/__bench/ping") return new Response("ok");
        if (url.pathname === "/__bench/usage") return Response.json(tally);
        if (url.pathname === "/__bench/flush") {
          const out = tally;
          tally = emptyUsage();
          return Response.json(out);
        }
        return new Response("not found", { status: 404 });
      }

      // Which agent is paying? The credential on the request decides — the one
      // thing that stays correct when several agents stream at once.
      const cred =
        req.headers.get("x-api-key") ??
        (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const lane = cred ? laneOfKey.get(cred) : undefined;

      const bodyBuf =
        req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      let reqModel = "";
      if (bodyBuf) {
        try {
          reqModel = String(JSON.parse(new TextDecoder().decode(bodyBuf)).model ?? "");
        } catch {
          // non-JSON body — fine
        }
      }

      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      headers.set("accept-encoding", "identity");
      // ai-sdk's anthropic provider treats ANTHROPIC_BASE_URL as already
      // versioned (it requests `<base>/messages`), while claude code requests
      // `<base>/v1/messages`. Normalize: anything not under /v1 gets it.
      const upstreamPath = url.pathname.startsWith("/v1") ? url.pathname : `/v1${url.pathname}`;
      const resp = await fetch(UPSTREAM + upstreamPath + url.search, {
        method: req.method,
        headers,
        body: bodyBuf,
        redirect: "manual",
      });
      const respHeaders = new Headers(resp.headers);
      respHeaders.delete("content-encoding");
      respHeaders.delete("content-length");
      respHeaders.delete("transfer-encoding");

      const isMessages = req.method === "POST" && upstreamPath.includes("/messages");
      if (!resp.ok || !isMessages) {
        return new Response(resp.body, { status: resp.status, headers: respHeaders });
      }

      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream") && resp.body) {
        // Tee the SSE stream: pass bytes through untouched, parse usage on the side.
        const t: TokenCounts = { ...ZERO_TOKENS };
        let model = reqModel;
        let buffer = "";
        const decoder = new TextDecoder();
        const handleLine = (line: string): void => {
          if (!line.startsWith("data:")) return;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === "message_start" && evt.message?.usage) {
              const u = usageFromJson(evt.message.usage);
              t.input = u.input;
              t.cacheRead = u.cacheRead;
              t.cacheWrite = u.cacheWrite;
              t.output = u.output;
              if (evt.message.model) model = evt.message.model;
            } else if (evt.type === "message_delta" && evt.usage) {
              t.output = evt.usage.output_tokens ?? t.output;
              // A mid-stream delta can also restate input usage (server tool
              // turns do) — take the larger view so nothing is undercounted.
              const u = usageFromJson(evt.usage);
              if (u.input > t.input) t.input = u.input;
              if (u.cacheRead > t.cacheRead) t.cacheRead = u.cacheRead;
              if (u.cacheWrite > t.cacheWrite) t.cacheWrite = u.cacheWrite;
            }
          } catch {
            // partial/non-JSON data line — ignore
          }
        };
        // Record exactly once — on clean stream end OR client cancel, so a
        // killed/aborted agent still gets its partial usage tallied.
        let recorded = false;
        const settle = (): void => {
          if (recorded) return;
          recorded = true;
          record(model || "unknown", t, lane);
        };
        const tee = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            buffer += decoder.decode(chunk, { stream: true });
            let idx = buffer.indexOf("\n");
            while (idx >= 0) {
              handleLine(buffer.slice(0, idx).trim());
              buffer = buffer.slice(idx + 1);
              idx = buffer.indexOf("\n");
            }
          },
          flush() {
            handleLine(buffer.trim());
            settle();
          },
        });
        // A client abort must still tally the partial usage.
        req.signal.addEventListener("abort", settle, { once: true });
        return new Response(resp.body.pipeThrough(tee), {
          status: resp.status,
          headers: respHeaders,
        });
      }

      const text = await resp.text();
      try {
        const j = JSON.parse(text);
        record(String(j.model ?? reqModel ?? "unknown"), usageFromJson(j.usage), lane);
      } catch {
        // non-JSON success body — ignore
      }
      return new Response(text, { status: resp.status, headers: respHeaders });
    },
  });

  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}`,
    usage: () => structuredClone(tally),
    flush: () => {
      const out = tally;
      tally = emptyUsage();
      return out;
    },
    bind: (lane, apiKey) => {
      if (apiKey) laneOfKey.set(apiKey, lane);
    },
    flushLane: (lane) => {
      const out = laneTally.get(lane) ?? emptyUsage();
      laneTally.delete(lane);
      return out;
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const idx = process.argv.indexOf("--port");
  const meter = startMeter(idx >= 0 ? Number(process.argv[idx + 1]) : 8402);
  console.error(`[proxy] metering on ${meter.url} → ${UPSTREAM}`);
  process.on("SIGINT", () => {
    console.error(JSON.stringify(meter.usage(), null, 2));
    meter.stop();
    process.exit(0);
  });
}
