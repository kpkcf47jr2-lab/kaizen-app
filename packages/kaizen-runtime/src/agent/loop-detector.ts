// ═══════════════════════════════════════════════════════════════════════
//  LoopDetector — abort when the LLM gets stuck repeating itself
//
//  Two heuristics, evaluated on every completed tool call:
//    1. Same (tool, argsHash) N times in a row.
//    2. Same argsHash appearing K times within the last W tool calls,
//       even if interleaved with other tools.
//
//  Both are cheap constant-time. Neither uses the LLM.
// ═══════════════════════════════════════════════════════════════════════

import type { ILoopDetector } from "./index.js";

interface Observation {
  toolName: string;
  argsHash: string;
  ts: number;
}

export interface LoopDetectorConfig {
  /** Consecutive identical calls that trigger an abort. Default 3. */
  consecutiveThreshold: number;
  /** Window size for the K-of-W heuristic. Default 8. */
  windowSize: number;
  /** How many identical calls within that window trigger an abort. Default 4. */
  windowThreshold: number;
}

const DEFAULTS: LoopDetectorConfig = {
  consecutiveThreshold: 3,
  windowSize: 8,
  windowThreshold: 4,
};

export class LoopDetector implements ILoopDetector {
  private readonly window: Observation[] = [];
  private readonly cfg: LoopDetectorConfig;
  /** Reason string for the most recent abort. Consumed by the loop. */
  public lastAbortReason: string | null = null;

  constructor(cfg?: Partial<LoopDetectorConfig>) {
    this.cfg = { ...DEFAULTS, ...(cfg ?? {}) };
  }

  observe(toolName: string, argsHash: string): boolean {
    this.window.push({ toolName, argsHash, ts: Date.now() });
    if (this.window.length > this.cfg.windowSize) {
      this.window.shift();
    }

    // Heuristic 1: consecutive identical calls
    const last = this.window[this.window.length - 1]!;
    let consecutive = 1;
    for (let i = this.window.length - 2; i >= 0; i--) {
      const prev = this.window[i]!;
      if (prev.toolName === last.toolName && prev.argsHash === last.argsHash) {
        consecutive++;
      } else {
        break;
      }
    }
    if (consecutive >= this.cfg.consecutiveThreshold) {
      this.lastAbortReason =
        `loop_detected: ${last.toolName} called ${consecutive} times in a row with identical args`;
      return true;
    }

    // Heuristic 2: K identical (tool, args) within window
    const key = last.toolName + "\x00" + last.argsHash;
    let matches = 0;
    for (const obs of this.window) {
      if (obs.toolName + "\x00" + obs.argsHash === key) matches++;
    }
    if (matches >= this.cfg.windowThreshold) {
      this.lastAbortReason =
        `loop_detected: ${last.toolName}(argsHash=${last.argsHash.slice(0, 8)}) called ${matches} times in the last ${this.window.length} steps`;
      return true;
    }

    return false;
  }

  reset(): void {
    this.window.length = 0;
    this.lastAbortReason = null;
  }
}

/** Cheap hash for tool args — good enough for equality detection, not
 *  a security primitive. Uses FNV-1a 32-bit which is 5x faster than
 *  crypto.subtle for tiny inputs and doesn't require async. */
export function hashArgs(args: unknown): string {
  const str = JSON.stringify(args ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
