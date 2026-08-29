import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSoulStore, SOUL_MAX_BYTES } from "../identity/soul.js";

describe("FileSoulStore", () => {
  let tmp: string;
  let store: FileSoulStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-"));
    store = new FileSoulStore({ dataDir: tmp });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("returns starter template on first read", async () => {
    const soul = await store.read("agt_new");
    expect(soul).toContain("SOUL — agt_new");
    expect(soul).toContain("Who I am");
  });

  it("write + read round-trip", async () => {
    const contents = "# My soul\n\nI am learning.\n";
    const r = await store.write("agt_x", contents, "first draft");
    expect(r.bytesBefore).toBe(0);
    expect(r.bytesAfter).toBe(Buffer.byteLength(contents));
    const back = await store.read("agt_x");
    expect(back).toBe(contents);
  });

  it("refuses writes over SOUL_MAX_BYTES", async () => {
    const bomb = "x".repeat(SOUL_MAX_BYTES + 100);
    await expect(store.write("agt_x", bomb, "too big")).rejects.toThrow(/refused/);
  });

  it("refuses path-traversal agent IDs", async () => {
    await expect(store.read("../evil")).rejects.toThrow(/invalid agentId/);
    await expect(store.write("../evil", "x", "y")).rejects.toThrow(/invalid agentId/);
  });

  it("history() records each write in order", async () => {
    await store.write("agt_x", "v1", "first");
    await store.write("agt_x", "v2 longer", "second");
    const h = await store.history("agt_x");
    expect(h).toHaveLength(2);
    expect(h[0]!.summary).toBe("first");
    expect(h[1]!.summary).toBe("second");
    expect(h[1]!.bytesBefore).toBe(2);
  });
});
