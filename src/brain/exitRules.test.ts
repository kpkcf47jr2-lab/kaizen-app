import { describe, it, expect } from "vitest";
import { evaluateExit } from "./exitRules.js";

describe("Position exit rules", () => {
  const base = { takeProfitPct: null, stopLossPct: null, trailingStopPct: null, highWatermarkUsd: null };

  it("returns no-close when no rules set", () => {
    const d = evaluateExit(100, 110, base);
    expect(d.shouldClose).toBe(false);
  });

  it("returns no-close for zero entry", () => {
    const d = evaluateExit(0, 100, { ...base, takeProfitPct: 10 });
    expect(d.shouldClose).toBe(false);
  });

  it("triggers take-profit at exactly the threshold", () => {
    const d = evaluateExit(100, 110, { ...base, takeProfitPct: 10 });
    expect(d.shouldClose).toBe(true);
    expect(d.triggered).toBe("take_profit");
    expect(d.reason).toMatch(/take-profit/i);
  });

  it("does NOT trigger take-profit below threshold", () => {
    const d = evaluateExit(100, 109, { ...base, takeProfitPct: 10 });
    expect(d.shouldClose).toBe(false);
  });

  it("triggers stop-loss at exactly the negative threshold", () => {
    const d = evaluateExit(100, 95, { ...base, stopLossPct: 5 });
    expect(d.shouldClose).toBe(true);
    expect(d.triggered).toBe("stop_loss");
  });

  it("accepts stop-loss as positive number (magnitude)", () => {
    const d = evaluateExit(100, 90, { ...base, stopLossPct: 8 });
    expect(d.shouldClose).toBe(true);
  });

  it("take-profit takes precedence over stop-loss when both would trigger", () => {
    // Impossible in practice (roi can't be both), but sanity-check ordering.
    const d = evaluateExit(100, 120, { ...base, takeProfitPct: 10, stopLossPct: 5 });
    expect(d.triggered).toBe("take_profit");
  });

  it("trailing stop tracks high watermark upward and does not fire", () => {
    // Peak 130 → drop 5% would need 123.5, current is 125 → no trigger
    const d = evaluateExit(100, 125, {
      ...base, trailingStopPct: 5, highWatermarkUsd: 130,
    });
    expect(d.shouldClose).toBe(false);
    // Current 125 is BELOW peak 130 → no new watermark.
    expect(d.newHighWatermark).toBeNull();
  });

  it("trailing stop fires when drop from peak crosses threshold", () => {
    // Peak 130, current 120 → drop 7.7% > 5%
    const d = evaluateExit(100, 120, {
      ...base, trailingStopPct: 5, highWatermarkUsd: 130,
    });
    expect(d.shouldClose).toBe(true);
    expect(d.triggered).toBe("trailing_stop");
  });

  it("trailing stop bumps watermark when new peak", () => {
    // No prior peak, current 115 > entry → this IS the peak
    const d = evaluateExit(100, 115, {
      ...base, trailingStopPct: 5, highWatermarkUsd: 110,
    });
    expect(d.shouldClose).toBe(false);       // still up
    expect(d.newHighWatermark).toBe(115);
  });

  it("does not fire trailing when we've never been above entry", () => {
    // Current 92 < entry 100. Peak = max(watermark, current) = 100.
    // Drop from peak 100 → 92 = 8%, would fire trailing 5%. But we
    // require peak > entry (position was actually profitable at some
    // point) before trailing engages.
    const d = evaluateExit(100, 92, {
      ...base, trailingStopPct: 5, highWatermarkUsd: 100,
    });
    expect(d.triggered).toBeNull();
  });
});
