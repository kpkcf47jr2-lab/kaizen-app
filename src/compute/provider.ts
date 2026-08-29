// ═══════════════════════════════════════════════════════════════════════
//  ComputeProvider — pluggable GPU rental adapter
//
//  Interfaces first so a fake in tests can drive the same code path the
//  live Runpod adapter runs in prod. Every implementation MUST enforce:
//    · rate limits by returning an error before making the API call
//    · cost estimation before creating the pod (so Policy Engine sees $)
//    · stop() cleans up unconditionally (never leak a running pod)
// ═══════════════════════════════════════════════════════════════════════

export interface GpuOption {
  id: string;                    // provider-native ID
  name: string;                  // human label (e.g. "RTX 4090 24GB")
  hourlyUsd: number;             // list price at query time
  vramGb: number;
}

export interface RentalRequest {
  gpuTypeId: string;
  hoursMax: number;              // hard-cap for auto-stop
  imageName?: string;            // e.g. "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel"
  envVars?: Record<string, string>;
  containerDiskGb?: number;
}

export interface Rental {
  rentalId: string;
  provider: string;
  gpuTypeId: string;
  hourlyUsd: number;
  startedAt: number;
  autoStopAt: number;
  status: "starting" | "running" | "stopped" | "failed";
  publicEndpoint?: string;
  reason?: string;
}

export interface ComputeProvider {
  name: string;
  list(): Promise<GpuOption[]>;
  rent(req: RentalRequest): Promise<Rental>;
  status(rentalId: string): Promise<Rental>;
  stop(rentalId: string): Promise<{ ok: boolean; reason?: string }>;
}

// ── Mock provider for tests + local dev ─────────────────────────────

export class MockComputeProvider implements ComputeProvider {
  name = "mock";
  private readonly rentals = new Map<string, Rental>();
  async list(): Promise<GpuOption[]> {
    return [
      { id: "mock-t4",  name: "Mock T4  16GB", hourlyUsd: 0.20, vramGb: 16 },
      { id: "mock-l4",  name: "Mock L4  24GB", hourlyUsd: 0.48, vramGb: 24 },
      { id: "mock-a100", name: "Mock A100 40GB", hourlyUsd: 2.10, vramGb: 40 },
    ];
  }
  async rent(req: RentalRequest): Promise<Rental> {
    const list = await this.list();
    const opt = list.find((o) => o.id === req.gpuTypeId);
    if (!opt) throw new Error(`unknown gpuTypeId ${req.gpuTypeId}`);
    const id = `mock_rental_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const rental: Rental = {
      rentalId: id, provider: this.name, gpuTypeId: opt.id, hourlyUsd: opt.hourlyUsd,
      startedAt: now, autoStopAt: now + req.hoursMax * 3600_000,
      status: "running", publicEndpoint: `mock://localhost/${id}`,
    };
    this.rentals.set(id, rental);
    return rental;
  }
  async status(rentalId: string): Promise<Rental> {
    const r = this.rentals.get(rentalId);
    if (!r) throw new Error(`unknown rental ${rentalId}`);
    return { ...r };
  }
  async stop(rentalId: string): Promise<{ ok: boolean; reason?: string }> {
    const r = this.rentals.get(rentalId);
    if (!r) return { ok: false, reason: "unknown rental" };
    r.status = "stopped";
    return { ok: true };
  }
}
