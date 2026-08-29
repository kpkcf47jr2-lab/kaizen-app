// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Compute tools
//
//  Give the agent a way to rent GPUs on demand — bounded by HARD_LIMITS
//  (MAX_GPU_HOURLY_USD, MAX_GPU_DAILY_USD). Every rental is recorded
//  in the Economic Ledger with strategy label so the reinvestment
//  engine can attribute compute cost to whatever the agent used it for.
//
//  Adapters (Runpod, Vast.ai, Lightning) live in src/compute/*. The
//  tool itself is provider-agnostic — the owner picks the default in
//  server.ts.
// ═══════════════════════════════════════════════════════════════════════

import { HARD_LIMITS, PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import type { ComputeProvider, GpuOption, Rental } from "../compute/provider.js";
import { MemoryStore } from "../memory/store.js";

// ── compute.list ──────────────────────────────────────────────────────

export function makeComputeListTool(provider: ComputeProvider): RegisteredTool<{ maxHourlyUsd?: number }, { provider: string; options: GpuOption[] }> {
  const exec: ToolFn<{ maxHourlyUsd?: number }, { provider: string; options: GpuOption[] }> = async (args) => {
    const all = await provider.list();
    const filtered = typeof args.maxHourlyUsd === "number"
      ? all.filter((o) => o.hourlyUsd <= args.maxHourlyUsd!)
      : all;
    return { provider: provider.name, options: filtered };
  };
  return {
    def: {
      name: "compute.list",
      description:
        "List GPU rental options from the current compute provider. Read-only, " +
        "no cost. Optionally filter by max hourly USD. Use this before compute.rentGpu " +
        "to pick a GPU that fits self-defined infrastructure budget.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          maxHourlyUsd: { type: "number", description: "Optional filter — only options ≤ this hourly rate." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "compute.list", level: PermissionLevel.READ_ONLY }),
  };
}

// ── compute.rentGpu ───────────────────────────────────────────────────

export interface RentGpuArgs {
  gpuTypeId: string;
  hoursMax: number;
  strategy: string;
  reason: string;
  imageName?: string;
  containerDiskGb?: number;
}
export interface RentGpuResult {
  ok: true;
  rental: Rental;
  totalMaxCostUsd: number;
}

export function makeComputeRentTool(provider: ComputeProvider): RegisteredTool<RentGpuArgs, RentGpuResult> {
  const exec: ToolFn<RentGpuArgs, RentGpuResult> = async (args, ctx) => {
    // Pre-check the hourly cap here (defense in depth — PolicyEngine
    // ALSO checks via toIntent below). Belt-and-braces: if the config
    // ever drifts, the tool itself refuses.
    const options = await provider.list();
    const gpu = options.find((o) => o.id === args.gpuTypeId);
    if (!gpu) throw new Error(`unknown gpuTypeId ${args.gpuTypeId}`);
    if (gpu.hourlyUsd > HARD_LIMITS.MAX_GPU_HOURLY_USD) {
      throw new Error(`refusing: ${gpu.name} ${gpu.hourlyUsd}/h > cap ${HARD_LIMITS.MAX_GPU_HOURLY_USD}/h`);
    }
    if (args.hoursMax <= 0 || args.hoursMax > 24) {
      throw new Error(`hoursMax must be 0 < h ≤ 24 (got ${args.hoursMax})`);
    }
    const totalMax = gpu.hourlyUsd * args.hoursMax;
    if (totalMax > HARD_LIMITS.MAX_GPU_DAILY_USD) {
      throw new Error(`refusing: ${gpu.name} × ${args.hoursMax}h = $${totalMax.toFixed(2)} > daily cap $${HARD_LIMITS.MAX_GPU_DAILY_USD}`);
    }

    const rental = await provider.rent({
      gpuTypeId: args.gpuTypeId,
      hoursMax: args.hoursMax,
      imageName: args.imageName,
      containerDiskGb: args.containerDiskGb,
    });

    const mem = new MemoryStore(ctx.agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "capital_allocation",
        strategy: args.strategy,
        amountUsd: totalMax,
        reason: `compute.rentGpu ${gpu.name} × ${args.hoursMax}h max: ${args.reason}`,
        metadata: JSON.stringify({
          provider: provider.name, gpuTypeId: gpu.id,
          hourlyUsd: gpu.hourlyUsd, hoursMax: args.hoursMax,
          totalMaxCostUsd: totalMax, rentalId: rental.rentalId,
          publicEndpoint: rental.publicEndpoint,
        }),
      });
    } finally { mem.close(); }

    return { ok: true, rental, totalMaxCostUsd: totalMax };
  };

  return {
    def: {
      name: "compute.rentGpu",
      description:
        "Rent a GPU pod from the current compute provider (Runpod by default). " +
        "Enforces MAX_GPU_HOURLY_USD ($" + HARD_LIMITS.MAX_GPU_HOURLY_USD + "/h) + " +
        "MAX_GPU_DAILY_USD ($" + HARD_LIMITS.MAX_GPU_DAILY_USD + "/day) hard limits before creating " +
        "the pod. The pod auto-stops after `hoursMax` hours — the agent " +
        "must call compute.stopGpu explicitly to release earlier. Every " +
        "rental is recorded in the Economic Ledger under `strategy`.",
      level: PermissionLevel.CAPITAL,
      parameters: {
        type: "object",
        required: ["gpuTypeId", "hoursMax", "strategy", "reason"],
        properties: {
          gpuTypeId: { type: "string", description: "id from compute.list" },
          hoursMax: { type: "number", description: "Hard cap on rental duration in hours (0 < h ≤ 24)." },
          strategy: { type: "string", description: "Strategy label for cost attribution (e.g. `training-v0.3`)." },
          reason: { type: "string", description: "Short justification for the ledger." },
          imageName: { type: "string", description: "Optional container image (defaults to Runpod PyTorch)." },
          containerDiskGb: { type: "number", description: "Container disk size (default 20 GB)." },
        },
      },
    },
    exec,
    toIntent: (a) => ({
      tool: "compute.rentGpu",
      level: PermissionLevel.CAPITAL,
      valueUsd: (a.hoursMax ?? 0),        // approximate; provider list gives real hourly
      metadata: { hourlyUsd: null, hoursMax: a.hoursMax },
    }),
  };
}

// ── compute.stopGpu ───────────────────────────────────────────────────

export function makeComputeStopTool(provider: ComputeProvider): RegisteredTool<{ rentalId: string; reason: string }, { ok: boolean; reason?: string }> {
  const exec: ToolFn<{ rentalId: string; reason: string }, { ok: boolean; reason?: string }> = async (args, ctx) => {
    const res = await provider.stop(args.rentalId);
    const mem = new MemoryStore(ctx.agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "capital_allocation",
        strategy: "compute-stop",
        amountUsd: 0,
        reason: `compute.stopGpu ${args.rentalId}: ${args.reason}`,
        metadata: JSON.stringify({ rentalId: args.rentalId, provider: provider.name, ok: res.ok, reason: res.reason }),
      });
    } finally { mem.close(); }
    return res;
  };
  return {
    def: {
      name: "compute.stopGpu",
      description:
        "Stop a previously rented GPU pod. Best-effort — returns {ok:false} if the " +
        "provider rejects the stop. Call this as soon as the training run finishes " +
        "or the agent decides the pod is no longer paying for itself.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["rentalId", "reason"],
        properties: {
          rentalId: { type: "string", description: "rentalId returned by compute.rentGpu" },
          reason: { type: "string", description: "Why stopping — recorded in the ledger." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "compute.stopGpu", level: PermissionLevel.ZERO_COST }),
  };
}
