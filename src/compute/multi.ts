// ═══════════════════════════════════════════════════════════════════════
//  MultiComputeProvider — aggregate multiple GPU rental providers behind
//  one interface. `compute.list` combines all offerings; `compute.rentGpu`
//  routes by prefixed gpuTypeId (e.g. "runpod:NVIDIA_L4" or
//  "lightning:L4"). Each provider prefix maps to a concrete adapter.
//
//  This lets Kaizen shop across providers and pick the cheapest match
//  for its budget, without the caller code branching on provider names.
// ═══════════════════════════════════════════════════════════════════════

import type { ComputeProvider, GpuOption, Rental, RentalRequest } from "./provider.js";

export interface MultiProviderConfig {
  providers: Record<string, ComputeProvider>;
}

export class MultiComputeProvider implements ComputeProvider {
  name = "multi";
  private readonly providers: Record<string, ComputeProvider>;

  constructor(cfg: MultiProviderConfig) {
    this.providers = cfg.providers;
    if (Object.keys(this.providers).length === 0) {
      throw new Error("MultiComputeProvider requires ≥1 provider");
    }
  }

  /** Aggregate options across all providers, prefixed by provider name so
   *  the caller sees WHICH provider is offering each option. Sorted by
   *  hourly price ascending so the cheapest lands first. */
  async list(): Promise<GpuOption[]> {
    const parts = await Promise.allSettled(
      Object.entries(this.providers).map(async ([prefix, p]) => {
        const opts = await p.list();
        return opts.map((o) => ({
          ...o,
          id: `${prefix}:${o.id}`,
          name: `[${prefix}] ${o.name}`,
        }));
      }),
    );
    const flat: GpuOption[] = [];
    for (const r of parts) {
      if (r.status === "fulfilled") flat.push(...r.value);
      // silently ignore providers that failed to list — one down
      // provider must not black-hole the whole catalog.
    }
    return flat.sort((a, b) => a.hourlyUsd - b.hourlyUsd);
  }

  async rent(req: RentalRequest): Promise<Rental> {
    const [prefix, ...rest] = req.gpuTypeId.split(":");
    if (rest.length === 0) {
      throw new Error(`gpuTypeId must be prefixed (e.g. 'runpod:L4', 'lightning:L4'). got: ${req.gpuTypeId}`);
    }
    const provider = this.providers[prefix!];
    if (!provider) throw new Error(`unknown provider prefix '${prefix}'. known: ${Object.keys(this.providers).join(",")}`);
    const nativeId = rest.join(":");
    const rental = await provider.rent({ ...req, gpuTypeId: nativeId });
    // Re-tag rental IDs with provider prefix so status/stop route back
    // to the same provider.
    return { ...rental, rentalId: `${prefix}:${rental.rentalId}`, provider: `multi:${prefix}` };
  }

  async status(rentalId: string): Promise<Rental> {
    const { provider, nativeId } = this.split(rentalId);
    const r = await provider.status(nativeId);
    return { ...r, rentalId, provider: `multi:${rentalId.split(":")[0]}` };
  }

  async stop(rentalId: string): Promise<{ ok: boolean; reason?: string }> {
    const { provider } = this.split(rentalId);
    return provider.stop(rentalId.split(":").slice(1).join(":"));
  }

  private split(rentalId: string): { provider: ComputeProvider; nativeId: string } {
    const [prefix, ...rest] = rentalId.split(":");
    const provider = this.providers[prefix!];
    if (!provider) throw new Error(`unknown provider prefix in rentalId '${rentalId}'`);
    return { provider, nativeId: rest.join(":") };
  }
}
