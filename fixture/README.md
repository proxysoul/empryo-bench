# hookboard

Self-hosted webhook inbox: receive, inspect, retry and export webhook deliveries.

- `src/server/routes.ts` — HTTP-ish route table
- `src/store/` — JSON-file persistence (profiles, events)
- `src/delivery/` — signing + retry/backoff for outbound forwarding
- `src/export/` — CSV / JSON export for the support team
- `src/events/` — list filtering + sorting for the dashboard

Run the tests with `bun test tests`.
