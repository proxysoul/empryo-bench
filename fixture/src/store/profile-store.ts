import type { Profile } from "../types.js";
import type { JsonDb } from "./db.js";

export const DEFAULT_PROFILE: Profile = {
  displayName: "",
  email: "",
  timezone: "UTC",
  digestEnabled: true,
  updatedAt: 0,
};

export class ProfileStore {
  constructor(private db: JsonDb<Profile>) {}

  get(): Promise<Profile> {
    return this.db.read();
  }

  /** Merge a partial update into the stored profile. */
  async update(patch: Partial<Profile>): Promise<Profile> {
    const current = await this.db.read();
    const next: Profile = { ...current, ...patch, updatedAt: Date.now() };
    return this.db.write(next);
  }
}
