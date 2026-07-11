import type { WebhookEvent } from "../types.js";
import type { JsonDb } from "./db.js";

export class EventStore {
  constructor(private db: JsonDb<WebhookEvent[]>) {}

  async add(event: WebhookEvent): Promise<void> {
    const all = await this.db.read();
    all.push(event);
    await this.db.write(all);
  }

  list(): Promise<WebhookEvent[]> {
    return this.db.read();
  }

  async prune(keep: number): Promise<number> {
    const all = await this.db.read();
    if (all.length <= keep) return 0;
    const trimmed = all.slice(all.length - keep);
    await this.db.write(trimmed);
    return all.length - trimmed.length;
  }
}
