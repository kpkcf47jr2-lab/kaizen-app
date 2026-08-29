// ═══════════════════════════════════════════════════════════════════════
//  LightningComputeProvider — adapter over Lightning AI Studios via
//  their Python SDK invoked as a child process.
//
//  Rationale for spawning python (vs an HTTP REST): Lightning does NOT
//  publish a stable public REST for compute rental; the SDK is the only
//  supported surface. Spawning python -c "..." is the pragmatic bridge
//  from a TS backend.
//
//  Required env:
//    LIGHTNING_USER_ID  — from settings/api-tokens on lightning.ai
//    LIGHTNING_API_KEY  — same page, distinct from Runpod
//    LIGHTNING_ORG      — 'kairos-777-inc' for us
//
//  Prices are hard-coded because Lightning's SDK doesn't expose them
//  in a machine-readable list; owner-updated occasionally.
// ═══════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import type { ComputeProvider, GpuOption, Rental, RentalRequest } from "./provider.js";

// Snapshot of Lightning's public pricing as of 2026-08. Update per
// billing page (https://lightning.ai/pricing). The MACHINE names here
// must match Machine enum values in lightning_sdk (case-sensitive).
const LIGHTNING_OPTIONS: GpuOption[] = [
  { id: "CPU",       name: "CPU 4-core 16GB (Free tier)", hourlyUsd: 0.00, vramGb: 0 },
  { id: "T4",        name: "T4 16GB",                     hourlyUsd: 0.42, vramGb: 16 },
  { id: "L4",        name: "L4 24GB",                     hourlyUsd: 0.48, vramGb: 24 },
  { id: "L40S",      name: "L40S 48GB",                   hourlyUsd: 3.18, vramGb: 48 },
  { id: "A100",      name: "A100 40GB",                   hourlyUsd: 2.19, vramGb: 40 },
  { id: "A100_X_4",  name: "A100 40GB x4",                hourlyUsd: 8.76, vramGb: 160 },
  { id: "H100",      name: "H100 80GB",                   hourlyUsd: 4.50, vramGb: 80 },
];

const PY_HELPER = `
import json, sys, os
from lightning_sdk import Studio, Machine
from lightning_sdk.organization import Organization
from lightning_sdk.teamspace import Teamspace

cmd = sys.argv[1]
studio_name = sys.argv[2]
machine_name = sys.argv[3] if len(sys.argv) > 3 else None

org = Organization(name=os.environ.get("LIGHTNING_ORG", "kairos-777-inc"))
ts = Teamspace(name=os.environ.get("LIGHTNING_TEAMSPACE", "default-project"), org=org)

try:
    s = Studio(name=studio_name, teamspace=ts, org=org)
except Exception:
    if cmd == "create":
        s = Studio(name=studio_name, teamspace=ts, org=org, create_ok=True)
    else:
        print(json.dumps({"ok": False, "error": f"studio {studio_name} not found"})); sys.exit(0)

if cmd == "start":
    machine = getattr(Machine, machine_name)
    s.start(machine=machine)
    print(json.dumps({"ok": True, "status": str(s.status), "machine": str(s.machine)}))
elif cmd == "status":
    print(json.dumps({"ok": True, "status": str(s.status), "machine": str(s.machine)}))
elif cmd == "stop":
    s.stop()
    print(json.dumps({"ok": True, "status": str(s.status)}))
elif cmd == "create":
    print(json.dumps({"ok": True, "created": True, "name": s.name}))
else:
    print(json.dumps({"ok": False, "error": f"unknown cmd {cmd}"})); sys.exit(1)
`;

export interface LightningProviderConfig {
  /** Owner-provided base name for Kaizen rentals — the provider suffixes
   *  a uniqueish tag per rental to avoid collision. */
  studioPrefix?: string;
  /** Absolute path to a python interpreter with lightning_sdk installed.
   *  Default reads env `LIGHTNING_PYTHON` else falls back to `python3`. */
  pythonPath?: string;
}

export class LightningComputeProvider implements ComputeProvider {
  name = "lightning";
  private readonly cfg: Required<LightningProviderConfig>;

  constructor(cfg?: LightningProviderConfig) {
    if (!process.env.LIGHTNING_API_KEY) {
      throw new Error("LightningComputeProvider requires LIGHTNING_API_KEY env var");
    }
    this.cfg = {
      studioPrefix: cfg?.studioPrefix ?? "kaizen-rental",
      pythonPath: cfg?.pythonPath ?? process.env.LIGHTNING_PYTHON ?? "python3",
    };
  }

  async list(): Promise<GpuOption[]> {
    // Static list (see comment at top of file).
    return LIGHTNING_OPTIONS;
  }

  async rent(req: RentalRequest): Promise<Rental> {
    const opt = LIGHTNING_OPTIONS.find((o) => o.id === req.gpuTypeId);
    if (!opt) throw new Error(`unknown Lightning machine id: ${req.gpuTypeId}`);
    const studioName = `${this.cfg.studioPrefix}-${Date.now().toString(36)}`;
    // 1) create studio, 2) start with machine
    await this.pyCall("create", studioName);
    const start = await this.pyCall("start", studioName, req.gpuTypeId);
    if (!start.ok) throw new Error(`Lightning start failed: ${start.error}`);
    const now = Date.now();
    return {
      rentalId: studioName,
      provider: this.name,
      gpuTypeId: opt.id,
      hourlyUsd: opt.hourlyUsd,
      startedAt: now,
      autoStopAt: now + req.hoursMax * 3600_000,
      status: "running",
      publicEndpoint: `https://lightning.ai/${process.env.LIGHTNING_ORG ?? "kairos-777-inc"}/studios/${studioName}`,
    };
  }

  async status(rentalId: string): Promise<Rental> {
    const s = await this.pyCall("status", rentalId);
    if (!s.ok) throw new Error(`Lightning status failed: ${s.error}`);
    const opt = LIGHTNING_OPTIONS.find((o) => o.id === (s.machine as string)) ?? LIGHTNING_OPTIONS[0]!;
    const status: Rental["status"] =
      s.status === "Running" ? "running"
      : s.status === "Stopped" ? "stopped"
      : s.status === "Pending" || s.status === "Starting" ? "starting"
      : "failed";
    return {
      rentalId, provider: this.name, gpuTypeId: opt.id, hourlyUsd: opt.hourlyUsd,
      startedAt: 0, autoStopAt: 0, status,
      publicEndpoint: `https://lightning.ai/${process.env.LIGHTNING_ORG ?? "kairos-777-inc"}/studios/${rentalId}`,
    };
  }

  async stop(rentalId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const s = await this.pyCall("stop", rentalId);
      return { ok: !!s.ok, reason: s.error };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  // ── private ────────────────────────────────────────────────────────
  private pyCall(cmd: string, studio: string, machine?: string): Promise<{
    ok: boolean; status?: string; machine?: string; error?: string; created?: boolean; name?: string;
  }> {
    const args = [
      "-c", PY_HELPER,
      cmd, studio,
      ...(machine ? [machine] : []),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.pythonPath, args, {
        env: process.env, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`lightning py timeout after 120s`));
      }, 120_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`lightning py exit ${code}: ${stderr.trim() || stdout.trim()}`));
        try { resolve(JSON.parse(stdout.trim().split("\n").pop() || "{}")); }
        catch (e) { reject(new Error(`bad JSON from lightning py: ${(e as Error).message} — stdout: ${stdout.slice(0, 400)}`)); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }
}
