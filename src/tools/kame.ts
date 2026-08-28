// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Kame tools
//
//  Kame is the creative motor of the ecosystem (LIVE at
//  api.kairos777.com/api/kame). Kaizen calls it to produce marketing
//  assets: images, videos, ad copies. Every call bills against the
//  agent's marketing budget — the Policy Engine caps per-creative
//  spend and daily marketing spend, and the AgentStateLoader tracks
//  it in adSpend24hUsd.
//
//  For MVP: two tools, image and video. Multi-variant campaigns come
//  in Fase 2 when the Marketing Engine drives A/B autonomously.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";

const KAME_BASE = process.env.KAIROS_KAME_BASE || "https://api.kairos777.com/api/kame";
const KAME_API_KEY = process.env.KAIROS_KAME_API_KEY || "";

// Rough default prices Kame charges internally (in USDC). The service is
// the source of truth — this is only for pre-flight budget check.
const APPROX_IMAGE_USD = 0.05;
const APPROX_VIDEO_USD_PER_SECOND = 0.10;

// ── kame.createImage ─────────────────────────────────────────────────
export interface CreateImageArgs {
  prompt: string;
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:5";
  reason: string;
}
export interface CreateImageResult {
  ok: boolean;
  imageUrl?: string;
  billedUsd?: number;
  jobId?: string;
  error?: string;
}

export function makeCreateImageTool(): RegisteredTool<CreateImageArgs, CreateImageResult> {
  const exec: ToolFn<CreateImageArgs, CreateImageResult> = async (args, ctx) => {
    return callKame<CreateImageResult>(
      "/image",
      {
        prompt: args.prompt,
        aspectRatio: args.aspectRatio ?? "1:1",
        agentId: ctx.agentId,
        reason: args.reason,
      },
    );
  };

  return {
    def: {
      name: "kame.createImage",
      description:
        "Generate one image via Kame (FLUX). Costs a small amount from the " +
        "marketing budget; the Policy Engine will reject if the daily marketing " +
        "cap would be exceeded. Use for ad creatives, thumbnails, landing hero " +
        "shots. Always include a reason.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["prompt", "reason"],
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed image description (visual style, subject, mood). English " +
              "or Spanish both accepted.",
          },
          aspectRatio: {
            type: "string",
            enum: ["1:1", "16:9", "9:16", "4:5"],
            description: "1:1 default. 9:16 for TikTok/Reels, 16:9 for YouTube.",
          },
          reason: {
            type: "string",
            description:
              "Business justification (campaign name or hypothesis). Recorded " +
              "in the Economic Ledger.",
          },
        },
      },
    },
    exec,
    toIntent: (_a, _ctx) => ({
      tool: "kame.createImage",
      level: PermissionLevel.FINANCIAL,
      valueUsd: APPROX_IMAGE_USD,
    }),
  };
}

// ── kame.createVideo ─────────────────────────────────────────────────
export interface CreateVideoArgs {
  prompt: string;
  seconds?: number;              // 3-10 typical
  aspectRatio?: "16:9" | "9:16" | "1:1";
  reason: string;
}
export interface CreateVideoResult {
  ok: boolean;
  videoUrl?: string;
  billedUsd?: number;
  jobId?: string;
  error?: string;
}

export function makeCreateVideoTool(): RegisteredTool<CreateVideoArgs, CreateVideoResult> {
  const exec: ToolFn<CreateVideoArgs, CreateVideoResult> = async (args, ctx) => {
    return callKame<CreateVideoResult>(
      "/video",
      {
        prompt: args.prompt,
        seconds: args.seconds ?? 6,
        aspectRatio: args.aspectRatio ?? "9:16",
        agentId: ctx.agentId,
        reason: args.reason,
      },
    );
  };

  return {
    def: {
      name: "kame.createVideo",
      description:
        "Generate one short video via Kame (default 6 seconds, 9:16 for social). " +
        "Costs more than an image (per-second billing); the Policy Engine will " +
        "cap this. Use for TikTok/Reels ad tests or product demos.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["prompt", "reason"],
        properties: {
          prompt: {
            type: "string",
            description: "Detailed video description (scene, motion, mood).",
          },
          seconds: {
            type: "number",
            description: "Length in seconds, 3-10 range. Longer = more expensive.",
          },
          aspectRatio: {
            type: "string",
            enum: ["16:9", "9:16", "1:1"],
            description: "9:16 default for TikTok/Reels/Shorts.",
          },
          reason: {
            type: "string",
            description: "Business justification. Recorded in the Ledger.",
          },
        },
      },
    },
    exec,
    toIntent: (a, _ctx) => ({
      tool: "kame.createVideo",
      level: PermissionLevel.FINANCIAL,
      valueUsd: (a.seconds ?? 6) * APPROX_VIDEO_USD_PER_SECOND,
    }),
  };
}

// ── shared HTTP client ───────────────────────────────────────────────
async function callKame<R>(path: string, body: Record<string, unknown>): Promise<R> {
  const url = `${KAME_BASE.replace(/\/$/, "")}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000); // creative jobs can take 30-60s
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(KAME_API_KEY ? { authorization: `Bearer ${KAME_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as R & { error?: string };
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` } as R;
    }
    return { ok: true, ...data } as R;
  } finally {
    clearTimeout(t);
  }
}
