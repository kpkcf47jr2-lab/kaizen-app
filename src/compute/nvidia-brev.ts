// ═══════════════════════════════════════════════════════════════════════
//  NvidiaBrevProvider — adapter for NVIDIA Brev.dev GPU rental
//
//  Brev is NVIDIA's on-demand GPU service (they acquired brev.dev in
//  2024). Public REST at https://brev.dev/api. Requires `BREV_API_KEY`.
//
//  Alternative option we deliberately DID NOT add: NVIDIA DGX Cloud —
//  enterprise sales-cycle only, no self-serve API. Skip until owner
//  signs a DGX Cloud contract.
//
//  Adapter is safe-by-default: if BREV_API_KEY is unset, it can still
//  be constructed (throws at first list/rent call) so a MultiProvider
//  can list it without exploding at boot.
// ═══════════════════════════════════════════════════════════════════════

import type { ComputeProvider, GpuOption, Rental, RentalRequest } from "./provider.js";

const BREV_BASE = "https://brev.dev/api";

export interface NvidiaBrevConfig {
  apiKey?: string;
}

export class NvidiaBrevProvider implements ComputeProvider {
  name = "nvidia-brev";
  private readonly apiKey: string;

  constructor(cfg?: NvidiaBrevConfig) {
    const k = cfg?.apiKey ?? process.env.BREV_API_KEY;
    if (!k) throw new Error("NvidiaBrevProvider requires BREV_API_KEY");
    this.apiKey = k;
  }

  async list(): Promise<GpuOption[]> {
    // Brev exposes instances catalog via /instance-types
    const r = await this.rest("GET", "/instance-types");
    const rows = Array.isArray(r) ? r : (r.instance_types ?? r.data ?? []);
    return rows.slice(0, 40).map((g: {
      id?: string; name?: string; type?: string;
      gpu?: { count?: number; type?: string; memory_gb?: number };
      pricing?: { on_demand_usd_per_hour?: number; spot_usd_per_hour?: number };
    }) => ({
      id: g.id ?? g.name ?? "unknown",
      name: `${g.name ?? g.type ?? "GPU"} × ${g.gpu?.count ?? 1}`,
      hourlyUsd: g.pricing?.spot_usd_per_hour ?? g.pricing?.on_demand_usd_per_hour ?? 0,
      vramGb: (g.gpu?.memory_gb ?? 0) * (g.gpu?.count ?? 1),
    }));
  }

  async rent(req: RentalRequest): Promise<Rental> {
    const body = {
      instance_type_id: req.gpuTypeId,
      image: req.imageName ?? "nvcr.io/nvidia/pytorch:24.10-py3",
      env: req.envVars ?? {},
      name: `kaizen-${Date.now()}`,
      max_lifetime_hours: req.hoursMax,
    };
    const created = await this.rest("POST", "/instances", body);
    const id = created.id ?? created.instance_id;
    if (!id) throw new Error("Brev /instances response missing id");
    const now = Date.now();
    return {
      rentalId: String(id),
      provider: this.name,
      gpuTypeId: req.gpuTypeId,
      hourlyUsd: Number(created.hourly_usd ?? 0),
      startedAt: now,
      autoStopAt: now + req.hoursMax * 3600_000,
      status: "starting",
      publicEndpoint: created.public_url ?? created.ssh_endpoint ?? undefined,
    };
  }

  async status(rentalId: string): Promise<Rental> {
    const p = await this.rest("GET", `/instances/${rentalId}`);
    const st = String(p.status ?? "").toLowerCase();
    const status: Rental["status"] =
      st === "running" ? "running"
      : st === "starting" || st === "pending" ? "starting"
      : st === "stopped" || st === "exited" ? "stopped"
      : "failed";
    return {
      rentalId, provider: this.name,
      gpuTypeId: p.instance_type_id ?? "",
      hourlyUsd: Number(p.hourly_usd ?? 0),
      startedAt: Date.parse(p.started_at ?? p.created_at ?? new Date().toISOString()),
      autoStopAt: 0, status,
      publicEndpoint: p.public_url ?? p.ssh_endpoint ?? undefined,
    };
  }

  async stop(rentalId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.rest("DELETE", `/instances/${rentalId}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  private async rest(method: string, pathname: string, body?: unknown): Promise<Record<string, unknown> & { id?: string; instance_id?: string; hourly_usd?: number; public_url?: string; ssh_endpoint?: string; status?: string; instance_type_id?: string; started_at?: string; created_at?: string; instance_types?: unknown[]; data?: unknown[] }> {
    const res = await fetch(`${BREV_BASE}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Brev ${method} ${pathname}: HTTP ${res.status} — ${text.slice(0, 400)}`);
    }
    return res.json();
  }
}
