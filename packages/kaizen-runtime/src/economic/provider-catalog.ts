// ═══════════════════════════════════════════════════════════════════════
//  ProviderCatalog — the ONLY source of executable provider parameters
//
//  CEO gate rejection #1 (2026-08-30):
//    "Eliminar todo paso directo de
//     EconomicProposal.options_considered[].attributes hacia
//     ExecutionOrder.provider_params. Los parámetros ejecutables deben
//     construirse únicamente desde una entrada autoritativa y tipada del
//     catálogo mediante allowlist."
//
//  Threat model: `attributes` is free-form JSON authored by the LLM. If it
//  were spread into provider_params, a prompt-injected model could smuggle
//  fields the executor forwards to the provider API — a bigger instance
//  type, a different region, a longer TTL, an extra `count`, a webhook it
//  controls. That is a privilege-escalation channel.
//
//  Fix: provider_params is BUILT, never merged. This module owns a typed
//  catalog. Given (provider, label) it returns a CatalogEntry. The order
//  builder then projects that entry through an explicit per-provider
//  allowlist. Model `attributes` are copied into the ledger for audit and
//  for comparing what the model believed vs. what is true — and are never
//  read by the executor.
// ═══════════════════════════════════════════════════════════════════════

/** A single purchasable unit, fully specified by us — not by the model. */
export interface CatalogEntry {
  provider: string;
  label: string;
  /** Authoritative price per unit (per hour for GPUs). */
  unit_cost_usd: number;
  /** What one unit means. Used for cost math and human-readable ledger. */
  unit: "hour" | "item" | "impression" | "token_1k";
  /** Verified hardware/product facts. Kaizen may READ these to reason,
   *  but they enter provider_params only via the allowlist below. */
  spec: {
    gpu_type?: string;
    vram_gb?: number;
    vcpus?: number;
    ram_gb?: number;
    region?: string;
    /** Historic median seconds from request → usable instance. */
    startup_seconds?: number;
  };
  /** Executable parameters, exactly as the provider API expects them.
   *  This object is authored HERE, in code, not by the model. */
  executable: Record<string, string | number | boolean>;
  /** Whether this entry may be used for real spend, or dry-run only. */
  availability: "available" | "dry_run_only" | "unavailable";
}

/**
 * Per-provider allowlist of keys that may be forwarded to the provider API.
 * Anything not named here is dropped, even if present in `executable`.
 * Adding a key is a deliberate code change + review, never a model decision.
 */
export const PROVIDER_PARAM_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  lightning: Object.freeze(["machine_type", "image", "disk_gb"]),
  runpod:    Object.freeze(["gpu_type_id", "image_name", "container_disk_gb", "cloud_type"]),
  brev:      Object.freeze(["instance_type", "image", "disk_gb"]),
  // Marketing / commerce providers get their own narrow lists when wired.
});

export interface CatalogSource {
  /** Look up one entry. Returns null when unknown — caller must refuse. */
  lookup(provider: string, label: string): Promise<CatalogEntry | null>;
  /** Enumerate what is purchasable right now (for compute.discover). */
  list(): Promise<CatalogEntry[]>;
}

/**
 * Project a catalog entry into the params that actually go to the provider.
 * Applies the allowlist, drops everything else, and never touches
 * model-supplied data.
 */
export function buildProviderParams(entry: CatalogEntry, units: number): {
  params: Record<string, string | number | boolean>;
  dropped: string[];
} {
  const allow = PROVIDER_PARAM_ALLOWLIST[entry.provider] ?? [];
  const params: Record<string, string | number | boolean> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(entry.executable)) {
    if (allow.includes(k)) params[k] = v;
    else dropped.push(k);
  }
  // `units` is derived from the validated proposal, not from attributes.
  params.units = units;
  return { params, dropped };
}

/** Static in-memory catalog. Fase 2 dry-run uses this; Fase 3 swaps in a
 *  live provider-API-backed implementation behind the same interface. */
export class StaticProviderCatalog implements CatalogSource {
  constructor(private readonly entries: readonly CatalogEntry[]) {}

  async lookup(provider: string, label: string): Promise<CatalogEntry | null> {
    return this.entries.find((e) => e.provider === provider && e.label === label) ?? null;
  }
  async list(): Promise<CatalogEntry[]> {
    return this.entries.filter((e) => e.availability !== "unavailable");
  }
}

/** Fase 2 dry-run catalog. Prices mirror real published rates so the
 *  adversarial economic-utility test is meaningful. */
export const DRY_RUN_CATALOG: readonly CatalogEntry[] = Object.freeze([
  Object.freeze({
    provider: "lightning", label: "L4", unit_cost_usd: 0.20, unit: "hour" as const,
    spec: { gpu_type: "NVIDIA L4", vram_gb: 24, vcpus: 8, ram_gb: 32, region: "us-east", startup_seconds: 90 },
    executable: { machine_type: "L4", image: "pytorch-2.4-cuda12.4", disk_gb: 40 },
    availability: "dry_run_only" as const,
  }),
  Object.freeze({
    provider: "runpod", label: "A10", unit_cost_usd: 0.55, unit: "hour" as const,
    spec: { gpu_type: "NVIDIA A10", vram_gb: 24, vcpus: 12, ram_gb: 62, region: "us-west", startup_seconds: 45 },
    executable: { gpu_type_id: "NVIDIA A10", image_name: "runpod/pytorch:2.4.0", container_disk_gb: 40, cloud_type: "SECURE" },
    availability: "dry_run_only" as const,
  }),
  Object.freeze({
    provider: "brev", label: "H100", unit_cost_usd: 3.00, unit: "hour" as const,
    spec: { gpu_type: "NVIDIA H100", vram_gb: 80, vcpus: 26, ram_gb: 200, region: "us-central", startup_seconds: 120 },
    executable: { instance_type: "h100-80gb", image: "nvcr.io/pytorch:24.08", disk_gb: 80 },
    availability: "dry_run_only" as const,
  }),
]);
