import { readFile, writeFile } from "node:fs/promises";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal JSON-file table. Real disk IO plus a small artificial latency so
 * dev mode behaves like the hosted deployment (network-attached volume).
 */
export class JsonDb<T> {
  constructor(
    private path: string,
    private fallback: T,
    private latencyMs = 4,
  ) {}

  async read(): Promise<T> {
    await delay(this.latencyMs);
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch {
      return structuredClone(this.fallback);
    }
  }

  async write(value: T): Promise<T> {
    await delay(this.latencyMs);
    await writeFile(this.path, JSON.stringify(value, null, 2));
    return value;
  }
}
