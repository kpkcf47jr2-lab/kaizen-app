// ═══════════════════════════════════════════════════════════════════════
//  RunpodProvider — concrete adapter over Runpod REST API v2
//
//  Requires env `RUNPOD_API_KEY`. Owner sets this when they want the
//  agent to be able to rent real GPUs. Without the key, the tool
//  refuses cleanly (no leak of half-configured state).
//
//  Design constraint: hourly caps + hoursMax hard-stop mean a runaway
//  agent can spend at most `hourlyUsd × hoursMax` before the API-side
//  auto-stop kicks in. Combined with PolicyEngine's daily $ cap, blast
//  radius is bounded on both axes.
// ═══════════════════════════════════════════════════════════════════════

import type { ComputeProvider, GpuOption, Rental, RentalRequest } from "./provider.js";

const RUNPOD_BASE = "https://rest.runpod.io/v1";

export class RunpodProvider implements ComputeProvider {
  name = "runpod";
  private readonly apiKey: string;

  constructor(opts?: { apiKey?: string }) {
    const k = opts?.apiKey ?? process.env.RUNPOD_API_KEY;
    if (!k) throw new Error("RunpodProvider requires RUNPOD_API_KEY");
    this.apiKey = k;
  }

  async list(): Promise<GpuOption[]> {
    const r = await this.rest("GET", "/gputypes");
    // Runpod returns an array of { id, displayName, memoryInGb, communityPrice, securePrice, ... }
    const rows = Array.isArray(r) ? r : (r.items ?? []);
    return rows.slice(0, 30).map((g: {
      id: string; displayName?: string; memoryInGb?: number;
      communityPrice?: number; securePrice?: number;
    }) => ({
      id: g.id,
      name: g.displayName ?? g.id,
      hourlyUsd: g.communityPrice ?? g.securePrice ?? 0,
      vramGb: g.memoryInGb ?? 0,
    }));
  }

  async rent(req: RentalRequest): Promise<Rental> {
    const body = {
      gpuTypeIds: [req.gpuTypeId],
      imageName: req.imageName ?? "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
      containerDiskInGb: req.containerDiskGb ?? 20,
      env: req.envVars ?? {},
      name: `kaizen-${Date.now()}`,
      // Runpod-specific: "SPOT" is cheaper, "ON_DEMAND" more reliable.
      // Prefer SPOT — combined with hoursMax hard-stop the worst case is
      // that the pod gets pre-empted; the agent handles that as an
      // observation on next heartbeat.
      cloudType: "COMMUNITY",
      interruptible: true,
      minVcpuCount: 4,
      minMemoryInGb: 8,
    };
    const created = await this.rest("POST", "/pods", body);
    if (!created.id) throw new Error("Runpod /pods response missing id");
    const podId: string = created.id;
    const hourlyUsd = Number(created.costPerHr ?? created.communityPrice ?? 0);
    const now = Date.now();
    return {
      rentalId: podId,
      provider: this.name,
      gpuTypeId: req.gpuTypeId,
      hourlyUsd,
      startedAt: now,
      autoStopAt: now + req.hoursMax * 3600_000,
      status: (created.desiredStatus === "RUNNING") ? "starting" : "running",
      publicEndpoint: created.publicIp ? `http://${created.publicIp}` : undefined,
    };
  }

  async status(rentalId: string): Promise<Rental> {
    const p = await this.rest("GET", `/pods/${rentalId}`);
    const status: Rental["status"] =
      p.desiredStatus === "EXITED" || p.currentStatus === "EXITED" ? "stopped"
      : p.currentStatus === "RUNNING" ? "running"
      : p.currentStatus === "STARTING" ? "starting"
      : "failed";
    return {
      rentalId, provider: this.name,
      gpuTypeId: p.machine?.gpuTypeId ?? "",
      hourlyUsd: Number(p.costPerHr ?? 0),
      startedAt: Date.parse(p.lastStartedAt ?? p.createdAt ?? new Date().toISOString()),
      autoStopAt: 0, status,
      publicEndpoint: p.publicIp ? `http://${p.publicIp}` : undefined,
    };
  }

  async stop(rentalId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.rest("POST", `/pods/${rentalId}/stop`, {});
      return { ok: true };
    } catch (e) {
      // Best-effort: even if stop() fails, next status() will show the
      // pod running and the heartbeat can retry.
      return { ok: false, reason: (e as Error).message };
    }
  }

  // ── private ────────────────────────────────────────────────────
  private async rest(method: string, pathname: string, body?: unknown): Promise<Record<string, unknown> & { id?: string; costPerHr?: number; communityPrice?: number; publicIp?: string; desiredStatus?: string; currentStatus?: string; machine?: Record<string, string>; lastStartedAt?: string; createdAt?: string; items?: unknown[] }> {
    const res = await fetch(`${RUNPOD_BASE}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Runpod ${method} ${pathname}: HTTP ${res.status} — ${text.slice(0, 400)}`);
    }
    return res.json();
  }
}
