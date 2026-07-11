// Hidden acceptance: concurrent profile updates must both survive.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDb } from "../src/store/db.js";
import { DEFAULT_PROFILE, ProfileStore } from "../src/store/profile-store.js";

describe("profile store under concurrent updates (hidden)", () => {
  it("does not lose either patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-race-"));
    const store = new ProfileStore(new JsonDb(join(dir, "profile.json"), DEFAULT_PROFILE, 4));
    await Promise.all([
      store.update({ displayName: "Ada Lovelace" }),
      store.update({ email: "ada@hookboard.dev" }),
    ]);
    const final = await store.get();
    expect(final.displayName).toBe("Ada Lovelace");
    expect(final.email).toBe("ada@hookboard.dev");
  });

  it("sequential updates still merge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-seq-"));
    const store = new ProfileStore(new JsonDb(join(dir, "profile.json"), DEFAULT_PROFILE, 1));
    await store.update({ timezone: "Europe/Berlin" });
    await store.update({ digestEnabled: false });
    const final = await store.get();
    expect(final.timezone).toBe("Europe/Berlin");
    expect(final.digestEnabled).toBe(false);
  });
});
