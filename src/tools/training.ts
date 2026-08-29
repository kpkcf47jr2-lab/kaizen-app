// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — training tools (Improvement.5)
//
//  Kaizen can trigger its own re-training when it decides it has enough
//  new outcome data. Two tools:
//
//    · training.status      — how many outcome-measured events since
//                             last training round; recommendation ("go" | "wait")
//    · training.trigger     — kicks off SFT + optional DPO on a rented
//                             GPU, returns a rentalId to poll. LLM must
//                             have already picked a provider via
//                             compute.list.
//
//  All caps enforced by MAX_GPU_HOURLY_USD and MAX_GPU_DAILY_USD in
//  policy/limits.ts so a runaway trigger can't drain the budget.
// ═══════════════════════════════════════════════════════════════════════

import { HARD_LIMITS, PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import type { ComputeProvider } from "../compute/provider.js";
import { MemoryStore } from "../memory/store.js";

// ── training.status ──────────────────────────────────────────────────

export interface TrainingStatusArgs {
  /** Only count events since last training round if you know its ts. */
  sinceMs?: number;
}
export interface TrainingStatusResult {
  outcomeMeasuredCount: number;
  winsCount: number;
  lossesCount: number;
  totalRoiUsd: number;
  recommendation: "go" | "wait";
  reason: string;
  /** Suggested dataset sizes for the next round. */
  suggestedSft: number;
  suggestedDpoPairs: number;
}

export function makeTrainingStatusTool(): RegisteredTool<TrainingStatusArgs, TrainingStatusResult> {
  const exec: ToolFn<TrainingStatusArgs, TrainingStatusResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const events = mem.eventsWithOutcome({ sinceMs: args.sinceMs ?? 7 * 86400_000, limit: 5000 });
      let wins = 0, losses = 0, roi = 0;
      for (const e of events) {
        if (e.outcomeSuccess) wins++; else losses++;
        roi += e.outcomeUsd;
      }
      // Rule of thumb: need ≥50 outcome-measured events + ≥10 losses
      // (so DPO has real preference signal) before another round pays
      // for its own compute.
      const enough = events.length >= 50 && losses >= 10;
      return {
        outcomeMeasuredCount: events.length,
        winsCount: wins,
        lossesCount: losses,
        totalRoiUsd: roi,
        recommendation: enough ? "go" : "wait",
        reason: enough
          ? `${events.length} outcome-measured events (${wins}W/${losses}L, cumulative ROI ${roi.toFixed(2)} USD) — signal is real, retraining is likely to pay for itself`
          : `Only ${events.length} events with ${losses} losses — not enough preference signal. Need ≥50 total AND ≥10 losses.`,
        suggestedSft: wins,
        suggestedDpoPairs: Math.min(wins, losses),
      };
    } finally { mem.close(); }
  };
  return {
    def: {
      name: "training.status",
      description:
        "Report how much new outcome-measured data exists since the last " +
        "training round. Returns a recommendation ('go' | 'wait') and " +
        "suggested dataset sizes. Read-only, no cost. Call this before " +
        "training.trigger to justify the compute spend.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          sinceMs: { type: "number", description: "Optional lookback window in ms (default 7 days)." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "training.status", level: PermissionLevel.READ_ONLY }),
  };
}

// ── training.trigger ─────────────────────────────────────────────────

export interface TriggerTrainingArgs {
  /** provider:gpuTypeId from compute.list — e.g. "lightning:L4" */
  gpuTypeId: string;
  /** SFT round + optional DPO. DPO needs ≥10 preference pairs. */
  runDpo?: boolean;
  /** Hours cap for the rented pod — MUST cover full training + save. */
  hoursMax: number;
  /** Version tag for the resulting adapter — e.g. "0.3". Stored in
   *  training/adapters/kaizen-8b-vN.M/ + Improvement.4 versioning. */
  versionTag: string;
  /** Reason for the retrain — recorded in the ledger. */
  reason: string;
}

export interface TriggerTrainingResult {
  ok: true;
  rentalId: string;
  provider: string;
  hourlyUsd: number;
  totalMaxCostUsd: number;
  versionTag: string;
  scriptsToRun: string[];       // ordered list of scripts the pod will exec
  status: "queued";
  note: string;
}

export function makeTrainingTriggerTool(compute: ComputeProvider): RegisteredTool<TriggerTrainingArgs, TriggerTrainingResult> {
  const exec: ToolFn<TriggerTrainingArgs, TriggerTrainingResult> = async (args, ctx) => {
    // Sanity checks belt-and-braces (PolicyEngine also enforces).
    if (args.hoursMax <= 0 || args.hoursMax > 12) {
      throw new Error(`hoursMax must be 0 < h ≤ 12 (got ${args.hoursMax})`);
    }
    if (!/^\d+\.\d+(\.\d+)?$/.test(args.versionTag)) {
      throw new Error(`versionTag must be semver-ish (e.g. '0.3' or '0.3.1'), got: ${args.versionTag}`);
    }

    // Look up provider option
    const opts = await compute.list();
    const gpu = opts.find((o) => o.id === args.gpuTypeId);
    if (!gpu) throw new Error(`unknown gpuTypeId ${args.gpuTypeId}`);
    if (gpu.hourlyUsd > HARD_LIMITS.MAX_GPU_HOURLY_USD) {
      throw new Error(`refusing: ${gpu.name} $${gpu.hourlyUsd}/h > cap $${HARD_LIMITS.MAX_GPU_HOURLY_USD}/h`);
    }
    const totalMax = gpu.hourlyUsd * args.hoursMax;
    if (totalMax > HARD_LIMITS.MAX_GPU_DAILY_USD) {
      throw new Error(`refusing: $${totalMax.toFixed(2)} > daily cap $${HARD_LIMITS.MAX_GPU_DAILY_USD}`);
    }

    // Rent the pod
    const rental = await compute.rent({
      gpuTypeId: args.gpuTypeId,
      hoursMax: args.hoursMax,
      // Standard HF + trl image so the training scripts drop in with
      // zero setup on the rented pod.
      imageName: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
      containerDiskGb: 40,
    });

    // Emit the ordered script sequence the pod SHOULD run. The
    // actual bootstrap-and-exec on the rented pod is Fase-8+ backlog
    // (needs a ssh/scp bridge to the rented pod); for now the tool
    // returns the intent + rental info so the LLM can decide to
    // wait / stop / poll status via compute.status.
    const scripts = [
      "pip install -U transformers accelerate peft trl bitsandbytes datasets",
      "git clone <kaizen-repo> && cd kaizen-app",
      `python training/scripts/sft_qlora.py --data-dir datasets/curated --out-dir training/adapters/kaizen-8b-v${args.versionTag} --base-model Qwen/Qwen3-8B --epochs 3`,
      ...(args.runDpo ? [
        `python training/scripts/dpo_train.py --data-file datasets/curated/dpo-latest.jsonl --base-model Qwen/Qwen3-8B --sft-adapter training/adapters/kaizen-8b-v${args.versionTag} --out-dir training/adapters/kaizen-8b-v${args.versionTag}-dpo --epochs 1 --beta 0.1`,
      ] : []),
    ];

    const mem = new MemoryStore(ctx.agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "capital_allocation",
        strategy: `training-v${args.versionTag}`,
        amountUsd: totalMax,
        reason: `training.trigger v${args.versionTag}: ${args.reason}`,
        metadata: JSON.stringify({
          rentalId: rental.rentalId, provider: rental.provider,
          gpuTypeId: gpu.id, hourlyUsd: gpu.hourlyUsd, hoursMax: args.hoursMax,
          totalMaxCostUsd: totalMax, versionTag: args.versionTag,
          runDpo: !!args.runDpo,
        }),
      });
    } finally { mem.close(); }

    return {
      ok: true, rentalId: rental.rentalId, provider: rental.provider,
      hourlyUsd: gpu.hourlyUsd, totalMaxCostUsd: totalMax,
      versionTag: args.versionTag, scriptsToRun: scripts, status: "queued",
      note: "Pod rented. Bootstrap + exec of the scripts is Fase-8+ backlog. " +
            "Poll rental status with compute.status; stop with compute.stopGpu when idle.",
    };
  };

  return {
    def: {
      name: "training.trigger",
      description:
        "Rent a GPU + queue a training round (SFT + optional DPO) to " +
        "produce a new Kaizen model version. Call training.status first " +
        "to justify the spend. Bounded by MAX_GPU_HOURLY_USD ($" + HARD_LIMITS.MAX_GPU_HOURLY_USD +
        "/h) + MAX_GPU_DAILY_USD ($" + HARD_LIMITS.MAX_GPU_DAILY_USD + "/day).",
      level: PermissionLevel.CAPITAL,
      parameters: {
        type: "object",
        required: ["gpuTypeId", "hoursMax", "versionTag", "reason"],
        properties: {
          gpuTypeId:  { type: "string", description: "prefixed id from compute.list (e.g. 'lightning:L4')." },
          runDpo:     { type: "boolean", description: "Run DPO after SFT. Requires ≥10 preference pairs — check training.status first." },
          hoursMax:   { type: "number", description: "Hard cap on rental duration (0 < h ≤ 12)." },
          versionTag: { type: "string", description: "Semver-ish tag for the new adapter (e.g. '0.3', '0.3.1')." },
          reason:     { type: "string", description: "Why retrain — recorded in the ledger." },
        },
      },
    },
    exec,
    toIntent: (a) => ({
      tool: "training.trigger",
      level: PermissionLevel.CAPITAL,
      valueUsd: 0,      // real value known only after compute.list; policy applies at rent()
      metadata: { versionTag: a.versionTag, hoursMax: a.hoursMax },
    }),
  };
}
