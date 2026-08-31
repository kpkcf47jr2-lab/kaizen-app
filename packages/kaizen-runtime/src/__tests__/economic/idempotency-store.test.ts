import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdempotencyStore, makeIdempotencyKey, canonicalizeArgs, newOperationId } from "../../economic/idempotency-store.js";

function freshStore(): { store: IdempotencyStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kz-idem-"));
  return { store: new IdempotencyStore({ stateDir: dir }), dir };
}

describe("canonicalizeArgs", () => {
  it("produces same string regardless of key order", () => {
    expect(canonicalizeArgs({ a: 1, b: 2 })).toBe(canonicalizeArgs({ b: 2, a: 1 }));
  });
  it("handles nested objects", () => {
    expect(canonicalizeArgs({ x: { c: 3, b: 2, a: 1 } })).toBe(canonicalizeArgs({ x: { a: 1, b: 2, c: 3 } }));
  });
  it("ignores listed keys", () => {
    expect(canonicalizeArgs({ a: 1, timestamp: 999 }, ["timestamp"]))
      .toBe(canonicalizeArgs({ a: 1, timestamp: 1234 }, ["timestamp"]));
  });
  it("preserves array order", () => {
    expect(canonicalizeArgs([1, 2, 3])).not.toBe(canonicalizeArgs([3, 2, 1]));
  });
});

describe("makeIdempotencyKey", () => {
  it("is deterministic within the same bucket", () => {
    const t = 1_000_000_000_000;
    const k1 = makeIdempotencyKey({ tool: "compute.rent", args: { gpu: "L4", hours: 1 }, actor: "kaizen", now_ms: t });
    const k2 = makeIdempotencyKey({ tool: "compute.rent", args: { hours: 1, gpu: "L4" }, actor: "kaizen", now_ms: t + 5 });
    expect(k1).toBe(k2);
  });
  it("differs across time buckets", () => {
    const t = 1_000_000_000_000;
    const k1 = makeIdempotencyKey({ tool: "compute.rent", args: { x: 1 }, actor: "k", now_ms: t, bucket_seconds: 60 });
    const k2 = makeIdempotencyKey({ tool: "compute.rent", args: { x: 1 }, actor: "k", now_ms: t + 61_000, bucket_seconds: 60 });
    expect(k1).not.toBe(k2);
  });
  it("differs across tools even with same args", () => {
    expect(
      makeIdempotencyKey({ tool: "compute.rent", args: { x: 1 }, actor: "k", now_ms: 1 }),
    ).not.toBe(
      makeIdempotencyKey({ tool: "compute.stop", args: { x: 1 }, actor: "k", now_ms: 1 }),
    );
  });
});

describe("IdempotencyStore", () => {
  let store: IdempotencyStore;
  beforeEach(() => { store = freshStore().store; });

  it("first begin() returns fresh=true", () => {
    const r = store.begin({ tool: "compute.rent", key: "k1", actor: "kaizen" });
    expect(r.fresh).toBe(true);
    expect(r.state).toBe("pending");
    expect(r.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("second begin() with same tool+key returns fresh=false + points at existing op", () => {
    const r1 = store.begin({ tool: "compute.rent", key: "k2", actor: "kaizen" });
    const r2 = store.begin({ tool: "compute.rent", key: "k2", actor: "kaizen" });
    expect(r2.fresh).toBe(false);
    expect(r2.operation_id).toBe(r1.operation_id);
  });

  it("different tools with same key don't collide", () => {
    const a = store.begin({ tool: "compute.rent", key: "same", actor: "kaizen" });
    const b = store.begin({ tool: "compute.stop", key: "same", actor: "kaizen" });
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(true);
    expect(a.operation_id).not.toBe(b.operation_id);
  });

  it("commit() moves pending → committed; subsequent begin with same key still refuses (committed also blocks)", () => {
    const r1 = store.begin({ tool: "compute.rent", key: "k3", actor: "kaizen" });
    store.commit(r1.operation_id, "hash-abc");
    const row = store.get(r1.operation_id)!;
    expect(row.state).toBe("committed");
    expect(row.result_hash).toBe("hash-abc");
    const r2 = store.begin({ tool: "compute.rent", key: "k3", actor: "kaizen" });
    expect(r2.fresh).toBe(false);
    expect(r2.state).toBe("committed");
  });

  it("rollback() frees the key so a retry works", () => {
    const r1 = store.begin({ tool: "compute.rent", key: "k4", actor: "kaizen" });
    store.rollback(r1.operation_id, "provider timeout");
    const r2 = store.begin({ tool: "compute.rent", key: "k4", actor: "kaizen" });
    expect(r2.fresh).toBe(true);           // retry allowed after rollback
    expect(r2.operation_id).not.toBe(r1.operation_id);
  });

  it("fail() marks failed but blocks retry until manual expire (design choice: preserve billing evidence)", () => {
    const r1 = store.begin({ tool: "compute.rent", key: "k5", actor: "kaizen" });
    store.fail(r1.operation_id, "payment failed after provider succeeded");
    const row = store.get(r1.operation_id)!;
    expect(row.state).toBe("failed");
    // failed does NOT block the unique index (per WHERE clause) — same key can be tried again.
    // This is intentional: `fail` is "we don't know outcome; do not retry silently". A retry
    // must be a NEW deliberate call, which will get a new operation_id.
    const r2 = store.begin({ tool: "compute.rent", key: "k5", actor: "kaizen" });
    expect(r2.fresh).toBe(true);
  });

  it("commit on non-pending row throws", () => {
    const r1 = store.begin({ tool: "compute.rent", key: "k6", actor: "kaizen" });
    store.commit(r1.operation_id);
    expect(() => store.commit(r1.operation_id)).toThrow(/not in pending/);
  });

  it("rollback on non-pending throws", () => {
    const r1 = store.begin({ tool: "compute.rent", key: "k7", actor: "kaizen" });
    store.commit(r1.operation_id);
    expect(() => store.rollback(r1.operation_id, "too late")).toThrow(/not in pending/);
  });

  it("stalePending returns pending ops older than N ms", async () => {
    const r1 = store.begin({ tool: "compute.rent", key: "k8", actor: "kaizen" });
    // Simulate age by directly mutating updated_at (not committed).
    (store as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("UPDATE operations SET updated_at = ? WHERE operation_id = ?")
      .run(Date.now() - 10_000, r1.operation_id);
    const stale = store.stalePending(5_000);
    expect(stale.map((s) => s.operation_id)).toContain(r1.operation_id);
    const notStale = store.stalePending(60_000);
    expect(notStale.map((s) => s.operation_id)).not.toContain(r1.operation_id);
  });

  it("simulated concurrent begin() with same key: only one wins", () => {
    // better-sqlite3 is synchronous per-connection; race by looping.
    const key = makeIdempotencyKey({ tool: "compute.rent", args: { gpu: "L4" }, actor: "kaizen", now_ms: 1 });
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const r = store.begin({ tool: "compute.rent", key, actor: "kaizen" });
      results.push(r.fresh);
    }
    // Exactly one fresh=true; nine fresh=false.
    expect(results.filter((x) => x).length).toBe(1);
    expect(results.filter((x) => !x).length).toBe(9);
  });
});
