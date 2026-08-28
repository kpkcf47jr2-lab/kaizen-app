// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Autonomous Marketing Engine
//
//  Campaign lifecycle tools that bind KAME creative production, social
//  publish, and revenue tracking under a single campaignLabel. The
//  Decision Loop can:
//
//    marketing.createCampaign  { label, listingId, hypothesis, budgetUsd }
//      → book-of-record for the funnel. Ties spend + revenue to a listing.
//
//    marketing.recordSpend     { label, amountUsd, source, note }
//      → every kame.create*, social.publishAd, ad-buy accrues to the
//        campaign's total spend. Called by the LLM after each ad tool.
//
//    marketing.recordRevenue   { label, amountUsd, note }
//      → attribute an incoming sale/USDC receipt to the campaign.
//
//    marketing.roas            { label? }
//      → returns per-campaign spend, revenue, ROAS, verdict (scale/hold/kill).
//        Feeds the LLM's budget-allocation reasoning.
//
//  All book-of-record; no on-chain action. Real transfers happen via
//  wallet.transfer or kame.* which the LLM calls separately and then
//  recordSpend() to reflect in the campaign totals.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import { MemoryStore } from "../memory/store.js";

interface CampaignData {
  label: string;
  listingId: number | null;
  hypothesis: string;
  budgetUsd: number;
  createdTs: number;
  status: "active" | "paused" | "killed";
}

// ── marketing.createCampaign ─────────────────────────────────────────
export interface CreateCampaignArgs {
  label: string;
  listingId?: number;
  hypothesis: string;
  budgetUsd: number;
}
export interface CreateCampaignResult {
  ok: true;
  label: string;
  budgetUsd: number;
}

export function makeCreateCampaignTool(): RegisteredTool<CreateCampaignArgs, CreateCampaignResult> {
  const exec: ToolFn<CreateCampaignArgs, CreateCampaignResult> = async (args, ctx) => {
    if (!/^[a-z0-9._-]{3,64}$/i.test(args.label)) {
      throw new Error("label must be [a-zA-Z0-9._-]{3,64}");
    }
    if (!(args.budgetUsd > 0)) throw new Error("budgetUsd must be > 0");
    const mem = new MemoryStore(ctx.agentId);
    try {
      const key = `marketing:campaign:${args.label}`;
      if (mem.getFact(key)) throw new Error(`Campaign ${args.label} already exists`);
      const data: CampaignData = {
        label: args.label,
        listingId: args.listingId ?? null,
        hypothesis: args.hypothesis,
        budgetUsd: args.budgetUsd,
        createdTs: Date.now(),
        status: "active",
      };
      mem.setFact(key, JSON.stringify(data));
      mem.recordEvent({
        ts: Date.now(),
        kind: "capital_allocation",
        strategy: args.label,
        amountUsd: args.budgetUsd,
        reason: `Marketing campaign created: ${args.hypothesis}`,
        metadata: JSON.stringify({ listingId: args.listingId, budgetUsd: args.budgetUsd }),
      });
      return { ok: true, label: args.label, budgetUsd: args.budgetUsd };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "marketing.createCampaign",
      description:
        "Create a marketing campaign as book-of-record. Ties subsequent " +
        "kame.* creative spend, social publish, and incoming revenue to " +
        "one label so ROAS is computable. Pick a stable, url-safe label. " +
        "Provide the hypothesis (what you're testing) and the total budget " +
        "you're willing to spend — enforced against Policy Engine daily " +
        "marketing cap on each recordSpend.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["label", "hypothesis", "budgetUsd"],
        properties: {
          label: { type: "string", description: "e.g. 'ai-tutor-v1'. [a-zA-Z0-9._-]{3,64}." },
          listingId: { type: "number", description: "Optional commerce.listing id this campaign promotes." },
          hypothesis: { type: "string", description: "Short falsifiable claim — 'crypto twitter converts on AI-assistant landing at ROAS ≥ 2'." },
          budgetUsd: { type: "number", description: "Total cap in USD. Actual spend gates via Policy Engine per-day marketing cap." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "marketing.createCampaign", level: PermissionLevel.ZERO_COST }),
  };
}

// ── marketing.recordSpend ────────────────────────────────────────────
export interface RecordSpendArgs {
  label: string;
  amountUsd: number;
  source: "kame_image" | "kame_video" | "ad_buy" | "content_creator" | "other";
  note?: string;
}
export interface RecordSpendResult {
  ok: true;
  totalSpendUsd: number;
  remainingBudgetUsd: number;
}

export function makeRecordSpendTool(): RegisteredTool<RecordSpendArgs, RecordSpendResult> {
  const exec: ToolFn<RecordSpendArgs, RecordSpendResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const camp = readCampaign(mem, args.label);
      const totalKey = `marketing:total_spend:${args.label}`;
      const prev = Number(mem.getFact(totalKey) ?? "0");
      const total = prev + args.amountUsd;
      mem.setFact(totalKey, String(total));
      mem.recordEvent({
        ts: Date.now(),
        kind: "campaign_spend",
        strategy: args.label,
        amountUsd: args.amountUsd,
        reason: `${args.source}${args.note ? ": " + args.note : ""}`,
        metadata: JSON.stringify({ source: args.source, totalSpendUsd: total }),
      });
      return {
        ok: true,
        totalSpendUsd: round2(total),
        remainingBudgetUsd: round2(Math.max(0, camp.budgetUsd - total)),
      };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "marketing.recordSpend",
      description:
        "Attribute a marketing expense to a campaign. Called after every " +
        "kame.createImage/Video, ad-buy, or content-creator payment so the " +
        "campaign's spend total stays accurate. Emits a campaign_spend event.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["label", "amountUsd", "source"],
        properties: {
          label: { type: "string", description: "Campaign label from createCampaign." },
          amountUsd: { type: "number", description: "Amount spent in USD." },
          source: {
            type: "string",
            enum: ["kame_image", "kame_video", "ad_buy", "content_creator", "other"],
            description: "Which channel the spend came from.",
          },
          note: { type: "string", description: "Optional free-form context." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "marketing.recordSpend", level: PermissionLevel.ZERO_COST }),
  };
}

// ── marketing.recordRevenue ──────────────────────────────────────────
export interface RecordRevenueArgs {
  label: string;
  amountUsd: number;
  note?: string;
}
export interface RecordRevenueResult {
  ok: true;
  totalRevenueUsd: number;
}

export function makeRecordRevenueTool(): RegisteredTool<RecordRevenueArgs, RecordRevenueResult> {
  const exec: ToolFn<RecordRevenueArgs, RecordRevenueResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      readCampaign(mem, args.label); // throws if missing
      const totalKey = `marketing:total_revenue:${args.label}`;
      const prev = Number(mem.getFact(totalKey) ?? "0");
      const total = prev + args.amountUsd;
      mem.setFact(totalKey, String(total));
      mem.recordEvent({
        ts: Date.now(),
        kind: "campaign_revenue",
        strategy: args.label,
        amountUsd: args.amountUsd,
        reason: args.note ?? "revenue attributed",
        metadata: JSON.stringify({ totalRevenueUsd: total }),
      });
      return { ok: true, totalRevenueUsd: round2(total) };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "marketing.recordRevenue",
      description:
        "Attribute an incoming sale/revenue to a campaign. Called when an " +
        "affiliate conversion, ad-attributed sale, or wallet deposit maps " +
        "to a campaign. Emits campaign_revenue event.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["label", "amountUsd"],
        properties: {
          label: { type: "string", description: "Campaign label." },
          amountUsd: { type: "number", description: "Revenue in USD." },
          note: { type: "string", description: "Optional context (e.g. 'ad-network conversion #42')." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "marketing.recordRevenue", level: PermissionLevel.ZERO_COST }),
  };
}

// ── marketing.roas ───────────────────────────────────────────────────
export interface RoasArgs { label?: string }
export interface RoasReportItem {
  label: string;
  hypothesis: string;
  budgetUsd: number;
  spendUsd: number;
  revenueUsd: number;
  roas: number;                  // revenue / spend
  verdict: "SCALE" | "HOLD" | "KILL" | "PENDING";
  rationale: string;
}
export interface RoasResult { campaigns: RoasReportItem[] }

const MIN_SCALE_ROAS = 1.5;   // mirrors HARD_LIMITS.MIN_SCALING_ROAS
const KILL_ROAS = 0.5;

export function makeRoasTool(): RegisteredTool<RoasArgs, RoasResult> {
  const exec: ToolFn<RoasArgs, RoasResult> = async (args, ctx) => {
    const mem = new MemoryStore(ctx.agentId);
    try {
      const all = mem.allFacts()
        .filter((f) => f.key.startsWith("marketing:campaign:"))
        .map((f) => JSON.parse(f.value) as CampaignData);
      const filtered = args.label ? all.filter((c) => c.label === args.label) : all;
      const campaigns = filtered.map((c) => {
        const spend = Number(mem.getFact(`marketing:total_spend:${c.label}`) ?? "0");
        const revenue = Number(mem.getFact(`marketing:total_revenue:${c.label}`) ?? "0");
        const roas = spend > 0 ? revenue / spend : 0;
        let verdict: RoasReportItem["verdict"];
        let rationale: string;
        if (spend < 5) {
          verdict = "PENDING";
          rationale = `Only $${spend.toFixed(2)} spent — statistically noisy, need more data.`;
        } else if (roas >= MIN_SCALE_ROAS) {
          verdict = "SCALE";
          rationale = `ROAS ${roas.toFixed(2)}×; each $1 in returns $${roas.toFixed(2)}. Increase budget within Policy caps.`;
        } else if (roas < KILL_ROAS) {
          verdict = "KILL";
          rationale = `ROAS ${roas.toFixed(2)}× — losing money. Stop spend, redirect budget.`;
        } else {
          verdict = "HOLD";
          rationale = `ROAS ${roas.toFixed(2)}× — break-even zone. Iterate creative before scaling.`;
        }
        return {
          label: c.label,
          hypothesis: c.hypothesis,
          budgetUsd: c.budgetUsd,
          spendUsd: round2(spend),
          revenueUsd: round2(revenue),
          roas: round2(roas),
          verdict,
          rationale,
        };
      });
      return { campaigns };
    } finally { mem.close(); }
  };

  return {
    def: {
      name: "marketing.roas",
      description:
        "Compute per-campaign spend, revenue, ROAS, and a SCALE/HOLD/KILL " +
        "verdict. Reads from the ledger — zero cost. Use before deciding " +
        "how to allocate the marketing budget bucket from reinvest.plan.",
      level: PermissionLevel.READ_ONLY,
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Optional: filter to a single campaign." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "marketing.roas", level: PermissionLevel.READ_ONLY }),
  };
}

// ── helpers ──────────────────────────────────────────────────────────

function readCampaign(mem: MemoryStore, label: string): CampaignData {
  const raw = mem.getFact(`marketing:campaign:${label}`);
  if (!raw) throw new Error(`Campaign ${label} not found`);
  return JSON.parse(raw) as CampaignData;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
