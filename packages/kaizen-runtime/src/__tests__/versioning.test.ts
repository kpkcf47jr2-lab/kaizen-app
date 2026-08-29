import { describe, it, expect, beforeEach } from "vitest";
import { ModelRegistry } from "../improvement/versioning.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kaizen-registry-"));
  return d;
}

describe("ModelRegistry", () => {
  let stateDir: string;
  beforeEach(() => { stateDir = freshDir(); });

  it("starts empty and persists to disk", () => {
    const r = new ModelRegistry(stateDir);
    expect(r.snapshot().versions).toEqual([]);
    expect(r.snapshot().activeTag).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "models", "registry.json"))).toBe(true);
  });

  it("registers a candidate + is idempotent", () => {
    const r = new ModelRegistry(stateDir);
    r.registerCandidate({ tag: "0.1", adapterPath: "a", baseModel: "b", trainedAt: 1, evalLoss: 0.9 });
    r.registerCandidate({ tag: "0.1", adapterPath: "a-v2", baseModel: "b", trainedAt: 2, evalLoss: 0.8 });
    const snap = r.snapshot();
    expect(snap.versions).toHaveLength(1);
    expect(snap.versions[0]!.adapterPath).toBe("a-v2");
    expect(snap.versions[0]!.evalLoss).toBe(0.8);
    expect(snap.versions[0]!.status).toBe("candidate");
  });

  it("rejects bad version tags", () => {
    const r = new ModelRegistry(stateDir);
    expect(() => r.registerCandidate({ tag: "beta", adapterPath: "a", baseModel: "b", trainedAt: 1 })).toThrow(/bad version tag/);
    expect(() => r.registerCandidate({ tag: "0", adapterPath: "a", baseModel: "b", trainedAt: 1 })).toThrow();
  });

  it("refuses to shadow-promote a version with no endpoint", () => {
    const r = new ModelRegistry(stateDir);
    r.registerCandidate({ tag: "0.1", adapterPath: "a", baseModel: "b", trainedAt: 1 });
    expect(() => r.promoteToShadow("0.1")).toThrow(/no servingEndpointUrl/);
  });

  it("promotes to shadow, then to active, retiring the old active", () => {
    const r = new ModelRegistry(stateDir);
    r.registerCandidate({ tag: "0.1", adapterPath: "a1", baseModel: "b", trainedAt: 1 });
    r.setEndpoint("0.1", "http://v01");
    r.promoteToActive("0.1");
    expect(r.getActive()!.tag).toBe("0.1");
    expect(r.getShadow()).toBeNull();

    r.registerCandidate({ tag: "0.2", adapterPath: "a2", baseModel: "b", trainedAt: 2 });
    r.setEndpoint("0.2", "http://v02");
    r.promoteToShadow("0.2");
    expect(r.getShadow()!.tag).toBe("0.2");
    expect(r.getActive()!.tag).toBe("0.1");   // active is unchanged

    r.promoteToActive("0.2");
    expect(r.getActive()!.tag).toBe("0.2");
    expect(r.getShadow()).toBeNull();
    const snap = r.snapshot();
    const v01 = snap.versions.find((v) => v.tag === "0.1")!;
    expect(v01.status).toBe("retired");
    expect(v01.retiredAt).toBeGreaterThan(0);
  });

  it("rollback promotes the most-recently-retired version", () => {
    const r = new ModelRegistry(stateDir);
    r.registerCandidate({ tag: "0.1", adapterPath: "a1", baseModel: "b", trainedAt: 1 });
    r.setEndpoint("0.1", "http://v01");
    r.promoteToActive("0.1");
    r.registerCandidate({ tag: "0.2", adapterPath: "a2", baseModel: "b", trainedAt: 2 });
    r.setEndpoint("0.2", "http://v02");
    r.promoteToActive("0.2");   // 0.1 → retired
    const rolled = r.rollback();
    expect(rolled.tag).toBe("0.1");
    expect(r.getActive()!.tag).toBe("0.1");
    expect(r.snapshot().versions.find((v) => v.tag === "0.2")!.status).toBe("retired");
  });

  it("persists across instances", () => {
    const r = new ModelRegistry(stateDir);
    r.registerCandidate({ tag: "0.3", adapterPath: "a3", baseModel: "b", trainedAt: 3, evalLoss: 0.5 });
    r.setEndpoint("0.3", "http://v03");
    r.promoteToActive("0.3");

    const r2 = new ModelRegistry(stateDir);
    expect(r2.getActive()!.tag).toBe("0.3");
    expect(r2.snapshot().versions[0]!.evalLoss).toBe(0.5);
  });
});
