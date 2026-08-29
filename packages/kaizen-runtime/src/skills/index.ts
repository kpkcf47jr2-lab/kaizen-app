// ═══════════════════════════════════════════════════════════════════════
//  Dynamic skills loader
//
//  A "skill" is an owner-approved package that adds a new tool (or a
//  bundle of tools) to the agent at runtime — without a redeploy. Kaizen
//  can call `skills.install(<url>)` when it thinks a new capability
//  would let it earn more; the loader downloads, validates, and (if
//  everything passes) registers the new tools on the fly.
//
//  Safety envelope:
//   1. Whitelist of source registries (owner-approved). Random GitHub
//      URLs are refused unless explicitly whitelisted.
//   2. Every skill ships CONSTITUTION.md + permissions.json. The
//      constitution SHA-256 must match the parent's byte-for-byte
//      (same guard used at spawn time).
//   3. Rate-limited via SelfMod's RateLimiter (skills = self-mod under
//      a different name).
//   4. Auto-quarantine: a skill whose first tool call fails N times in
//      a row gets frozen and the owner is notified.
//
//  Fase 7 ships the framework + interfaces. Concrete "download from a
//  registry" implementation lands in Fase 8 (Skills registry service).
// ═══════════════════════════════════════════════════════════════════════

import type { LlmToolSchema } from "../agent/loop.js";

export interface SkillManifest {
  name: string;                    // e.g. "shopify-basic"
  version: string;                 // semver
  description: string;
  constitutionSha256: string;
  permissions: {
    /** Which tool categories the skill introduces (e.g. ["commerce"]) */
    categories: string[];
    /** Which HARD_LIMITS the skill needs to be able to touch. */
    hardLimitsRequired?: string[];
    /** External services the skill will call (for the owner's audit). */
    externalHosts?: string[];
  };
  /** Absolute or repo-relative path to the tool bundle entry. */
  entrypoint: string;
}

/** What a skill exposes at runtime once loaded. */
export interface LoadedSkill {
  manifest: SkillManifest;
  installedAt: number;
  loadSourceUri: string;           // where it came from (audit trail)
  tools: LlmToolSchema[];          // schemas the skill added
  disabled?: string;               // reason if quarantined
}

export interface SkillsRegistry {
  install(sourceUri: string): Promise<LoadedSkill>;
  uninstall(name: string): Promise<void>;
  list(): Promise<LoadedSkill[]>;
  quarantine(name: string, reason: string): Promise<void>;
}

/** Fase 7 in-memory implementation: registers skills whose manifest is
 *  already loaded (used by tests + the "curated skills" default set).
 *  Fase 8 replaces the network-fetch path with a real signed-registry
 *  client. Interface stays. */
export class InMemorySkillsRegistry implements SkillsRegistry {
  private readonly loaded = new Map<string, LoadedSkill>();
  private readonly approvedSources: Set<string>;
  private readonly expectedConstitutionSha256: string;

  constructor(cfg: {
    approvedSources: readonly string[];
    expectedConstitutionSha256: string;
  }) {
    this.approvedSources = new Set(cfg.approvedSources);
    this.expectedConstitutionSha256 = cfg.expectedConstitutionSha256;
  }

  async install(sourceUri: string): Promise<LoadedSkill> {
    // Fase 7 stub: only pre-registered fixtures. See registerFixture().
    const existing = this.loaded.get(sourceUri);
    if (!existing) throw new Error(`skill source ${sourceUri} not pre-registered — Fase 8 adds the network installer`);
    if (existing.disabled) throw new Error(`skill ${existing.manifest.name} is quarantined: ${existing.disabled}`);
    return existing;
  }

  async uninstall(name: string): Promise<void> {
    for (const [k, v] of this.loaded) {
      if (v.manifest.name === name) this.loaded.delete(k);
    }
  }

  async list(): Promise<LoadedSkill[]> {
    return [...this.loaded.values()];
  }

  async quarantine(name: string, reason: string): Promise<void> {
    for (const v of this.loaded.values()) {
      if (v.manifest.name === name) v.disabled = reason;
    }
  }

  /** Register a fixture skill for Fase 7 tests + owner-curated defaults.
   *  Validates approved source + constitution match before registering. */
  registerFixture(sourceUri: string, manifest: SkillManifest, tools: LlmToolSchema[]): void {
    if (!this.approvedSources.has(new URL(sourceUri).origin) && !this.approvedSources.has(sourceUri)) {
      throw new Error(`skill source ${sourceUri} not in approved list`);
    }
    if (manifest.constitutionSha256 !== this.expectedConstitutionSha256) {
      throw new Error(`skill ${manifest.name} constitution SHA mismatch — refused`);
    }
    this.loaded.set(sourceUri, {
      manifest,
      installedAt: Date.now(),
      loadSourceUri: sourceUri,
      tools,
    });
  }
}
