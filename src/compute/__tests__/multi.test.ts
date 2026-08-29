import { describe, it, expect } from "vitest";
import { MultiComputeProvider } from "../multi.js";
import { MockComputeProvider, type ComputeProvider, type GpuOption, type Rental, type RentalRequest } from "../provider.js";

/** Second mock provider so we can test aggregation + routing. */
class MockAltProvider implements ComputeProvider {
  name = "alt";
  private readonly rentals = new Map<string, Rental>();
  async list(): Promise<GpuOption[]> {
    return [
      { id: "alt-cheap", name: "Alt Cheap 8GB",  hourlyUsd: 0.05, vramGb: 8 },
      { id: "alt-mid",   name: "Alt Mid 24GB",   hourlyUsd: 0.60, vramGb: 24 },
    ];
  }
  async rent(req: RentalRequest): Promise<Rental> {
    const opt = (await this.list()).find((o) => o.id === req.gpuTypeId);
    if (!opt) throw new Error(`unknown ${req.gpuTypeId}`);
    const id = `alt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const r: Rental = {
      rentalId: id, provider: this.name, gpuTypeId: opt.id, hourlyUsd: opt.hourlyUsd,
      startedAt: Date.now(), autoStopAt: Date.now() + req.hoursMax * 3600_000,
      status: "running",
    };
    this.rentals.set(id, r);
    return r;
  }
  async status(rentalId: string): Promise<Rental> {
    const r = this.rentals.get(rentalId);
    if (!r) throw new Error(`unknown rental ${rentalId}`);
    return { ...r };
  }
  async stop(rentalId: string): Promise<{ ok: boolean; reason?: string }> {
    const r = this.rentals.get(rentalId);
    if (!r) return { ok: false, reason: "not found" };
    r.status = "stopped";
    return { ok: true };
  }
}

describe("MultiComputeProvider", () => {
  it("aggregates options from all providers, sorted cheapest first, prefixed", async () => {
    const p = new MultiComputeProvider({
      providers: { mock: new MockComputeProvider(), alt: new MockAltProvider() },
    });
    const opts = await p.list();
    // Both providers listed
    const ids = opts.map((o) => o.id);
    expect(ids.some((id) => id.startsWith("mock:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("alt:"))).toBe(true);
    // Sorted ascending
    for (let i = 1; i < opts.length; i++) {
      expect(opts[i]!.hourlyUsd >= opts[i - 1]!.hourlyUsd).toBe(true);
    }
    // Cheapest is alt:alt-cheap ($0.05)
    expect(opts[0]!.id).toBe("alt:alt-cheap");
  });

  it("routes rent() by prefix to the right provider", async () => {
    const mock = new MockComputeProvider();
    const alt = new MockAltProvider();
    const p = new MultiComputeProvider({ providers: { mock, alt } });
    const r = await p.rent({
      gpuTypeId: "alt:alt-mid", hoursMax: 1, strategy: "test", reason: "test",
    } as unknown as RentalRequest);
    expect(r.provider).toBe("multi:alt");
    expect(r.rentalId.startsWith("alt:")).toBe(true);
    expect(r.gpuTypeId).toBe("alt-mid");
  });

  it("rent throws on unknown prefix", async () => {
    const p = new MultiComputeProvider({ providers: { mock: new MockComputeProvider() } });
    await expect(
      p.rent({ gpuTypeId: "unknown:xxx", hoursMax: 1, strategy: "t", reason: "t" } as unknown as RentalRequest),
    ).rejects.toThrow(/unknown provider prefix 'unknown'/);
  });

  it("rent throws when gpuTypeId is missing prefix", async () => {
    const p = new MultiComputeProvider({ providers: { mock: new MockComputeProvider() } });
    await expect(
      p.rent({ gpuTypeId: "no-prefix-here", hoursMax: 1, strategy: "t", reason: "t" } as unknown as RentalRequest),
    ).rejects.toThrow(/must be prefixed/);
  });

  it("status + stop route via rentalId prefix", async () => {
    const alt = new MockAltProvider();
    const p = new MultiComputeProvider({ providers: { alt } });
    const r = await p.rent({
      gpuTypeId: "alt:alt-cheap", hoursMax: 1, strategy: "t", reason: "t",
    } as unknown as RentalRequest);
    const stopped = await p.stop(r.rentalId);
    expect(stopped.ok).toBe(true);
    const s = await p.status(r.rentalId);
    expect(s.status).toBe("stopped");
  });

  it("empty provider set throws in constructor", () => {
    expect(() => new MultiComputeProvider({ providers: {} })).toThrow(/requires ≥1 provider/);
  });
});
