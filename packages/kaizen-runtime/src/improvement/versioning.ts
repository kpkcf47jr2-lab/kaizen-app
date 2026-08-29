// ═══════════════════════════════════════════════════════════════════════
//  Improvement.4 — Model Versioning
//
//  A retrained adapter is a *candidate* until it has proven itself. This
//  registry tracks the lineage — every candidate, which one is currently
//  serving production traffic, and which (if any) is being shadow-tested
//  against production.
//
//  Filesystem-backed (JSON at <stateDir>/models/registry.json) so it
//  survives restarts + is legible to the owner. Not per-agent — the
//  registry is a process-wide singleton.
//
//  Status lifecycle:
//     trained  →  candidate  →  shadow  →  active  →  retired
//
//  Only one version can be `active` and one can be `shadow` at a time.
//  Promoting a `shadow` to `active` demotes the previous `active` to
//  `retired` (kept on disk for rollback, never deleted).
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

export type VersionStatus = "candidate" | "shadow" | "active" | "retired";

export interface ModelVersion {
  tag: string;                    // "0.2", "0.3.1"
  adapterPath: string;            // "training/adapters/kaizen-8b-v0.2"
  baseModel: string;              // "Qwen/Qwen3-8B"
  servingEndpointUrl?: string;    // vLLM URL once served; null while offline
  status: VersionStatus;
  trainedAt: number;
  evalLoss?: number;
  evalTokenAcc?: number;
  notes?: string;
  promotedAt?: number;            // last time it became `active` or `shadow`
  retiredAt?: number;
}

export interface RegistrySnapshot {
  versions: ModelVersion[];
  activeTag: string | null;
  shadowTag: string | null;
  updatedAt: number;
}

export class ModelRegistry {
  private readonly file: string;
  private snap: RegistrySnapshot;

  constructor(stateDir: string) {
    const dir = path.join(stateDir, "models");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "registry.json");
    if (fs.existsSync(this.file)) {
      try { this.snap = JSON.parse(fs.readFileSync(this.file, "utf8")); }
      catch { this.snap = ModelRegistry.emptySnapshot(); }
    } else {
      this.snap = ModelRegistry.emptySnapshot();
      this.persist();
    }
  }

  static emptySnapshot(): RegistrySnapshot {
    return { versions: [], activeTag: null, shadowTag: null, updatedAt: Date.now() };
  }

  private persist(): void {
    this.snap.updatedAt = Date.now();
    fs.writeFileSync(this.file, JSON.stringify(this.snap, null, 2) + "\n", "utf8");
  }

  private find(tag: string): ModelVersion | undefined {
    return this.snap.versions.find((v) => v.tag === tag);
  }

  snapshot(): RegistrySnapshot {
    // Deep clone so callers can't mutate our state.
    return JSON.parse(JSON.stringify(this.snap));
  }

  /** Register a freshly trained adapter as a candidate. Idempotent per tag. */
  registerCandidate(v: Omit<ModelVersion, "status"> & { status?: never }): ModelVersion {
    if (!/^\d+\.\d+(\.\d+)?$/.test(v.tag)) throw new Error(`bad version tag: ${v.tag}`);
    const existing = this.find(v.tag);
    if (existing) {
      // Update the mutable fields but preserve current status/promotion history.
      Object.assign(existing, {
        adapterPath: v.adapterPath, baseModel: v.baseModel,
        servingEndpointUrl: v.servingEndpointUrl, trainedAt: v.trainedAt,
        evalLoss: v.evalLoss, evalTokenAcc: v.evalTokenAcc, notes: v.notes,
      });
      this.persist();
      return existing;
    }
    const created: ModelVersion = { ...v, status: "candidate" };
    this.snap.versions.push(created);
    this.persist();
    return created;
  }

  /** Set an endpoint URL for a version — call once vLLM (or NIM) is serving it. */
  setEndpoint(tag: string, endpointUrl: string): ModelVersion {
    const v = this.find(tag);
    if (!v) throw new Error(`unknown tag: ${tag}`);
    v.servingEndpointUrl = endpointUrl;
    this.persist();
    return v;
  }

  /** Promote a candidate to `shadow`. Displaces any current shadow to `candidate`. */
  promoteToShadow(tag: string): ModelVersion {
    const v = this.find(tag);
    if (!v) throw new Error(`unknown tag: ${tag}`);
    if (v.status === "active") throw new Error(`${tag} is already active — cannot demote to shadow directly`);
    if (!v.servingEndpointUrl) throw new Error(`${tag} has no servingEndpointUrl — set one before shadow-promoting`);
    if (this.snap.shadowTag && this.snap.shadowTag !== tag) {
      const prev = this.find(this.snap.shadowTag);
      if (prev && prev.status === "shadow") prev.status = "candidate";
    }
    v.status = "shadow";
    v.promotedAt = Date.now();
    this.snap.shadowTag = tag;
    this.persist();
    return v;
  }

  /** Promote a shadow (or a candidate) directly to `active`. Old active → `retired`. */
  promoteToActive(tag: string): ModelVersion {
    const v = this.find(tag);
    if (!v) throw new Error(`unknown tag: ${tag}`);
    if (!v.servingEndpointUrl) throw new Error(`${tag} has no servingEndpointUrl`);
    // Retire the previous active
    if (this.snap.activeTag && this.snap.activeTag !== tag) {
      const prev = this.find(this.snap.activeTag);
      if (prev) { prev.status = "retired"; prev.retiredAt = Date.now(); }
    }
    v.status = "active";
    v.promotedAt = Date.now();
    v.retiredAt = undefined;
    this.snap.activeTag = tag;
    // If it was our shadow, clear the shadow slot.
    if (this.snap.shadowTag === tag) this.snap.shadowTag = null;
    this.persist();
    return v;
  }

  /** Remove shadow status from a version (back to `candidate`). */
  clearShadow(): void {
    if (!this.snap.shadowTag) return;
    const v = this.find(this.snap.shadowTag);
    if (v && v.status === "shadow") v.status = "candidate";
    this.snap.shadowTag = null;
    this.persist();
  }

  /** Emergency rollback: promote the most-recently-retired version back to active. */
  rollback(): ModelVersion {
    const retired = this.snap.versions
      .filter((v) => v.status === "retired" && v.retiredAt)
      .sort((a, b) => (b.retiredAt || 0) - (a.retiredAt || 0));
    if (!retired.length) throw new Error("no retired versions to roll back to");
    return this.promoteToActive(retired[0]!.tag);
  }

  getActive(): ModelVersion | null {
    return this.snap.activeTag ? this.find(this.snap.activeTag) ?? null : null;
  }
  getShadow(): ModelVersion | null {
    return this.snap.shadowTag ? this.find(this.snap.shadowTag) ?? null : null;
  }
}
