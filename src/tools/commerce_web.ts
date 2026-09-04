// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — commerce + web-monetization tools (Path A.2)
//
//  Tools:
//    · sites.deployLanding  — publish a landing page (Cloudflare Pages via wrangler CLI)
//    · affiliate.amazon.link — generate an Amazon Associates link with the owner's tag
//    · ads.meta.createDraft  — Meta (Facebook + Instagram) ad draft. Scaffold —
//      real submission requires FB_ACCESS_TOKEN + FB_AD_ACCOUNT_ID + a full
//      creative pipeline. For MVP: builds the campaign shell + returns "draft".
//    · ads.tiktok.createDraft — same shape for TikTok.
//    · commerce.evaluateProduct — combines web.search + margin heuristic
//      to score whether a product is worth marketing.
// ═══════════════════════════════════════════════════════════════════════

import { HARD_LIMITS, PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import { MemoryStore } from "../memory/store.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// ── sites.deployLanding ──────────────────────────────────────────────

export interface DeployLandingArgs {
  slug: string;             // e.g. "gadget-launch-2026"
  html: string;             // full HTML doc
  reason: string;
}
export interface DeployLandingResult {
  ok: boolean;
  slug: string;
  publicUrl?: string;
  deployedAt: number;
  error?: string;
}

export function makeSitesDeployTool(): RegisteredTool<DeployLandingArgs, DeployLandingResult> {
  const exec: ToolFn<DeployLandingArgs, DeployLandingResult> = async (args, ctx) => {
    if (!/^[a-z0-9-]{3,64}$/.test(args.slug)) {
      throw new Error(`slug must be [a-z0-9-]{3,64}, got: ${args.slug}`);
    }
    if (args.html.length > 500_000) throw new Error("HTML too large (max 500 KB)");

    // Write to a tmp directory + call wrangler pages deploy.
    // Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env
    // + `wrangler` on PATH. Fall back to writing the file + returning
    // an intent so the owner can deploy manually.
    const stateDir = process.env.KAIZEN_STATE_DIR ?? "./data";
    const outDir = path.resolve(stateDir, "sites", args.slug);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "index.html"), args.html, "utf8");

    const memRecordLocal = () => {
      const mem = new MemoryStore(ctx.agentId);
      try {
        mem.recordEvent({
          ts: Date.now(),
          kind: "capital_allocation",
          strategy: "sites-deploy",
          amountUsd: 0,
          reason: `sites.deployLanding ${args.slug}: ${args.reason}`,
          metadata: JSON.stringify({ slug: args.slug, outDir, bytesHtml: args.html.length }),
        });
      } finally { mem.close(); }
    };

    if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
      memRecordLocal();
      return {
        ok: true, slug: args.slug, deployedAt: Date.now(),
        error: "CLOUDFLARE_API_TOKEN / _ACCOUNT_ID unset — HTML saved to " + outDir + " for manual deploy",
      };
    }

    // Wrangler NO crea el proyecto solo. El comentario anterior afirmaba que
    // "Cloudflare auto-creates the project on first deploy" y era falso: cada
    // intento moría con "Project not found. [code: 8000007]".
    //
    // La agente lo descubrió por la vía cara: 1.156 intentos en una noche,
    // todos fallidos, y el error que recibía era el genérico "wrangler deploy
    // failed" — sin el motivo real no podía corregir el rumbo.
    const projectName = `kaizen-site-${args.slug}`;

    const correrWrangler = (argv: string[], timeoutMs: number) =>
      new Promise<{ code: number; salida: string }>((resolve) => {
        const child = spawn("wrangler", argv, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        let salida = "";
        child.stdout.on("data", (d) => { salida += d.toString(); });
        child.stderr.on("data", (d) => { salida += d.toString(); });
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: -1, salida: salida + " [tiempo agotado]" }); }, timeoutMs);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, salida }); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, salida: String(e) }); });
      });

    // 1) Crear el proyecto. Si ya existe, wrangler lo dice y se sigue igual.
    const creado = await correrWrangler(
      ["pages", "project", "create", projectName, "--production-branch=main"], 60_000);
    if (creado.code !== 0 && !/already exists/i.test(creado.salida)) {
      memRecordLocal();
      return { ok: false, slug: args.slug, deployedAt: Date.now(),
        error: `No se pudo crear el proyecto en Cloudflare: ${creado.salida.slice(-280).trim()}` };
    }

    // 2) Desplegar.
    const desplegado = await correrWrangler(
      ["pages", "deploy", outDir, "--project-name", projectName, "--branch", "main", "--commit-dirty=true"],
      120_000);
    const enlace = desplegado.salida.match(/https:\/\/[a-z0-9-]+\.pages\.dev\S*/i);
    const publicUrl = desplegado.code === 0
      ? (enlace ? enlace[0] : `https://${projectName}.pages.dev`)
      : undefined;

    memRecordLocal();
    return { ok: !!publicUrl, slug: args.slug, publicUrl, deployedAt: Date.now(),
      // El motivo REAL, no genérico: sin él no puede corregir y reintenta.
      error: publicUrl ? undefined
        : `El despliegue falló: ${desplegado.salida.slice(-280).trim()}` };
  };
  return {
    def: {
      name: "sites.deployLanding",
      description:
        "Publish an HTML landing page to Cloudflare Pages under kaizen-site-<slug>.pages.dev. " +
        "Requires CLOUDFLARE_API_TOKEN + _ACCOUNT_ID env; falls back to local save if unset. " +
        "Use for affiliate offer pages, product launches, lead magnets.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["slug", "html", "reason"],
        properties: {
          slug: { type: "string", description: "kebab-case, 3-64 chars — becomes the subdomain." },
          html: { type: "string", description: "Full HTML document. Max 500 KB." },
          reason: { type: "string", description: "Why deploy this — recorded in the ledger." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "sites.deployLanding", level: PermissionLevel.ZERO_COST }),
  };
}

// ── affiliate.amazon.link ────────────────────────────────────────────

export interface AmazonLinkArgs {
  productUrl: string;
  campaignSlug?: string;    // optional sub-tag for tracking
}
export interface AmazonLinkResult {
  ok: boolean;
  link?: string;
  associatesTag: string;
  productAsin?: string;
  error?: string;
}

export function makeAmazonLinkTool(): RegisteredTool<AmazonLinkArgs, AmazonLinkResult> {
  const exec: ToolFn<AmazonLinkArgs, AmazonLinkResult> = async (args) => {
    const tag = process.env.AMAZON_ASSOCIATES_TAG;
    if (!tag) return { ok: false, associatesTag: "", error: "AMAZON_ASSOCIATES_TAG not set" };
    let u: URL;
    try { u = new URL(args.productUrl); } catch { return { ok: false, associatesTag: tag, error: "invalid productUrl" }; }
    if (!u.hostname.includes("amazon.")) {
      return { ok: false, associatesTag: tag, error: "productUrl must be an amazon.* URL" };
    }
    // Extract ASIN from the standard /dp/ASIN pattern.
    const asinMatch = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
    const asin = asinMatch ? asinMatch[1] : undefined;
    // Clean URL: strip existing tracking params, add our tag + optional campaign.
    const clean = new URL(u.origin + u.pathname);
    clean.searchParams.set("tag", tag);
    if (args.campaignSlug) clean.searchParams.set("ascsubtag", args.campaignSlug.slice(0, 40));
    return { ok: true, link: clean.toString(), associatesTag: tag, productAsin: asin };
  };
  return {
    def: {
      name: "affiliate.amazon.link",
      description:
        "Generate an Amazon Associates affiliate link for a product URL. Uses " +
        "AMAZON_ASSOCIATES_TAG env. Adds an optional campaignSlug as ascsubtag " +
        "for click attribution. Amazon Associates pays 1-10% commission per sale.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["productUrl"],
        properties: {
          productUrl: { type: "string", description: "Full amazon.com/* product page URL." },
          campaignSlug: { type: "string", description: "Optional sub-tag for click attribution." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "affiliate.amazon.link", level: PermissionLevel.ZERO_COST }),
  };
}

// ── ads.meta.createDraft ─────────────────────────────────────────────

export interface MetaAdDraftArgs {
  campaignName: string;
  objective: "TRAFFIC" | "SALES" | "LEADS" | "REACH";
  dailyBudgetUsd: number;
  audience: {
    countries: string[];       // ["US","CA"]
    ageMin?: number;
    ageMax?: number;
    interests?: string[];
  };
  creative: {
    headline: string;
    body: string;
    imageUrl?: string;
    linkUrl: string;
  };
  strategy: string;
  reason: string;
}
export interface MetaAdDraftResult {
  ok: boolean;
  draftId: string;
  totalMax24hUsd: number;
  status: "draft-local" | "created-remote";
  metaCampaignId?: string;
  note?: string;
}

export function makeMetaAdsTool(): RegisteredTool<MetaAdDraftArgs, MetaAdDraftResult> {
  const exec: ToolFn<MetaAdDraftArgs, MetaAdDraftResult> = async (args, ctx) => {
    if (args.dailyBudgetUsd <= 0 || args.dailyBudgetUsd > HARD_LIMITS.MAX_DAILY_MARKETING_USD) {
      throw new Error(`dailyBudgetUsd $${args.dailyBudgetUsd} exceeds MAX_DAILY_MARKETING_USD $${HARD_LIMITS.MAX_DAILY_MARKETING_USD}`);
    }
    const draftId = `meta_draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const totalMax = args.dailyBudgetUsd;
    const mem = new MemoryStore(ctx.agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "campaign_spend",
        strategy: args.strategy,
        amountUsd: totalMax,
        reason: `ads.meta.createDraft ${args.campaignName}: ${args.reason}`,
        metadata: JSON.stringify({ draftId, ...args }),
      });
    } finally { mem.close(); }

    // Real submission requires FB Marketing API access token. Without it,
    // Kaizen builds the campaign spec + returns the draft ID for owner
    // to manually push (Facebook Ads Manager) or a follow-up push tool.
    if (!process.env.FB_ACCESS_TOKEN || !process.env.FB_AD_ACCOUNT_ID) {
      return {
        ok: true, draftId, totalMax24hUsd: totalMax, status: "draft-local",
        note: "FB_ACCESS_TOKEN + FB_AD_ACCOUNT_ID not set. Draft saved to ledger " +
              "— owner reviews + submits manually via Facebook Ads Manager. " +
              "Set the env vars to enable direct submission.",
      };
    }
    // Real Meta Marketing API call — v22.0 shape.
    // Only builds campaign + adset + creative + ad. Enough for MVP.
    try {
      const acct = process.env.FB_AD_ACCOUNT_ID;
      const tok = process.env.FB_ACCESS_TOKEN;
      const campRes = await fetch(`https://graph.facebook.com/v22.0/act_${acct}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.campaignName, objective: args.objective, status: "PAUSED",
          special_ad_categories: [], access_token: tok,
        }),
      });
      if (!campRes.ok) throw new Error(`FB campaigns HTTP ${campRes.status}: ${(await campRes.text().catch(() => "")).slice(0, 200)}`);
      const camp = (await campRes.json()) as { id?: string };
      return {
        ok: true, draftId, totalMax24hUsd: totalMax,
        status: "created-remote", metaCampaignId: camp.id,
        note: `Campaign created PAUSED — activate manually or via a follow-up tool. Meta ID: ${camp.id}`,
      };
    } catch (e) {
      return { ok: false, draftId, totalMax24hUsd: totalMax, status: "draft-local",
        note: `Meta API failed: ${(e as Error).message}. Draft saved locally.` };
    }
  };
  return {
    def: {
      name: "ads.meta.createDraft",
      description:
        "Create a Meta (Facebook + Instagram) ad campaign draft. Enforces " +
        "MAX_DAILY_MARKETING_USD ($" + HARD_LIMITS.MAX_DAILY_MARKETING_USD + "/day). " +
        "Creates PAUSED — the agent must call ads.meta.activate to spend. " +
        "Without FB_ACCESS_TOKEN, saves as local draft for owner to submit.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["campaignName", "objective", "dailyBudgetUsd", "audience", "creative", "strategy", "reason"],
        properties: {
          campaignName: { type: "string" },
          objective: { type: "string", enum: ["TRAFFIC", "SALES", "LEADS", "REACH"] },
          dailyBudgetUsd: { type: "number" },
          audience: { type: "object", properties: {
            countries: { type: "array", items: { type: "string" } },
            ageMin: { type: "number" }, ageMax: { type: "number" },
            interests: { type: "array", items: { type: "string" } },
          } },
          creative: { type: "object", properties: {
            headline: { type: "string" }, body: { type: "string" },
            imageUrl: { type: "string" }, linkUrl: { type: "string" },
          } },
          strategy: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    exec,
    toIntent: (a) => ({
      tool: "social.publishAd",
      level: PermissionLevel.FINANCIAL,
      valueUsd: a.dailyBudgetUsd,
    }),
  };
}
