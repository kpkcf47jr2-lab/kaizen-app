// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Social Distribution Layer
//
//  MVP shape: one tool per platform, POSTed via that platform's official
//  API. Requires owner-supplied OAuth tokens/env creds — without them
//  the tool returns { ok:false, pending_credentials } so the LLM knows
//  to route through an alternate channel.
//
//  Adapters shipped:
//    twitter.postTweet   — POST /2/tweets  (Bearer OAuth 2.0 user context)
//    telegram.postMessage — Bot HTTP API (no OAuth, single BOT_TOKEN)
//
//  Both call marketing.recordSpend + optional creative attribution via
//  Kame if the LLM chains them in the same tick.
//
//  Adapters NOT shipped yet (require owner credentials + more surface):
//    meta.postAd, tiktok.postAd, youtube.uploadVideo — placeholders
//    return pending_credentials so the LLM can plan around them.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import { MemoryStore } from "../memory/store.js";

const TW_BEARER = process.env.KAIZEN_TWITTER_BEARER || "";
const TG_BOT_TOKEN = process.env.KAIZEN_TELEGRAM_BOT_TOKEN || "";
const TG_DEFAULT_CHAT = process.env.KAIZEN_TELEGRAM_DEFAULT_CHAT || "";

// ── twitter.postTweet ────────────────────────────────────────────────
export interface TwitterPostArgs {
  text: string;                  // 1-280 chars post-URL expansion
  campaignLabel: string;         // ties to marketing.roas attribution
  mediaUrl?: string;             // optional image/video (must be public URL)
  reason: string;
}
export interface TwitterPostResult {
  ok: boolean;
  tweetId?: string;
  url?: string;
  reason?: string;
  pendingCredentials?: boolean;
}

export function makeTwitterPostTool(): RegisteredTool<TwitterPostArgs, TwitterPostResult> {
  const exec: ToolFn<TwitterPostArgs, TwitterPostResult> = async (args, ctx) => {
    if (!TW_BEARER) {
      return {
        ok: false,
        pendingCredentials: true,
        reason: "KAIZEN_TWITTER_BEARER not configured. Owner must add OAuth 2.0 user bearer token to backend .env.",
      };
    }
    if (!args.text || args.text.length < 1 || args.text.length > 280) {
      return { ok: false, reason: `text must be 1-280 chars (got ${args.text?.length ?? 0})` };
    }

    // Media upload path requires /2/media (chunked upload) → deferred.
    // MVP: text-only POST /2/tweets. Media URLs stay in the body for now.
    const body: Record<string, unknown> = { text: args.text };

    const res = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TW_BEARER}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: { id?: string; text?: string };
      errors?: Array<{ message?: string }>;
      title?: string;
      detail?: string;
    };
    if (!res.ok || !data.data?.id) {
      const err = data.errors?.[0]?.message || data.detail || `HTTP ${res.status}`;
      return { ok: false, reason: err };
    }

    // Ledger + campaign attribution (no cost — publish is free once token is set)
    const mem = new MemoryStore(ctx.agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "campaign_spend",
        strategy: args.campaignLabel,
        amountUsd: 0,
        reason: `twitter post: ${args.reason}`,
        metadata: JSON.stringify({ tweetId: data.data.id, source: "twitter" }),
      });
    } finally { mem.close(); }

    return {
      ok: true,
      tweetId: data.data.id,
      url: `https://x.com/i/status/${data.data.id}`,
    };
  };

  return {
    def: {
      name: "twitter.postTweet",
      description:
        "Post a tweet on the connected X/Twitter account. 1-280 chars, " +
        "text-only for MVP (media upload needs chunked API — deferred). " +
        "Requires owner-configured KAIZEN_TWITTER_BEARER. Returns tweetId " +
        "on success. Attributes to a campaign via campaignLabel so " +
        "marketing.roas can track downstream conversions.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["text", "campaignLabel", "reason"],
        properties: {
          text: { type: "string", description: "Tweet body, 1-280 chars." },
          campaignLabel: { type: "string", description: "Campaign attribution label." },
          mediaUrl: { type: "string", description: "Optional public media URL (MVP ignores — text only)." },
          reason: { type: "string", description: "Why this post (recorded in ledger)." },
        },
      },
    },
    exec,
    toIntent: (a) => ({
      tool: "twitter.postTweet",
      level: PermissionLevel.FINANCIAL,
      valueUsd: 0,
      metadata: { humanImpersonationCheck: "kaizen-branded" },
    }),
  };
}

// ── telegram.postMessage ─────────────────────────────────────────────
export interface TelegramPostArgs {
  chatId?: string;               // uses KAIZEN_TELEGRAM_DEFAULT_CHAT if omitted
  text: string;                  // 1-4096 chars
  campaignLabel: string;
  reason: string;
}
export interface TelegramPostResult {
  ok: boolean;
  messageId?: number;
  reason?: string;
  pendingCredentials?: boolean;
}

export function makeTelegramPostTool(): RegisteredTool<TelegramPostArgs, TelegramPostResult> {
  const exec: ToolFn<TelegramPostArgs, TelegramPostResult> = async (args, ctx) => {
    if (!TG_BOT_TOKEN) {
      return {
        ok: false,
        pendingCredentials: true,
        reason: "KAIZEN_TELEGRAM_BOT_TOKEN not configured.",
      };
    }
    const chat = args.chatId || TG_DEFAULT_CHAT;
    if (!chat) return { ok: false, reason: "chatId not provided and no KAIZEN_TELEGRAM_DEFAULT_CHAT" };
    if (!args.text || args.text.length < 1 || args.text.length > 4096) {
      return { ok: false, reason: `text must be 1-4096 chars` };
    }

    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: args.text, disable_web_page_preview: false }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    };
    if (!res.ok || !data.ok || !data.result?.message_id) {
      return { ok: false, reason: data.description || `HTTP ${res.status}` };
    }

    const mem = new MemoryStore(ctx.agentId);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "campaign_spend",
        strategy: args.campaignLabel,
        amountUsd: 0,
        reason: `telegram: ${args.reason}`,
        metadata: JSON.stringify({ messageId: data.result.message_id, chatId: chat }),
      });
    } finally { mem.close(); }

    return { ok: true, messageId: data.result.message_id };
  };

  return {
    def: {
      name: "telegram.postMessage",
      description:
        "Send a message from the Kaizen Telegram bot to a chat. 1-4096 " +
        "chars. If chatId not provided, uses the default from the env. " +
        "Requires owner-configured KAIZEN_TELEGRAM_BOT_TOKEN.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["text", "campaignLabel", "reason"],
        properties: {
          chatId: { type: "string", description: "Telegram chat id / channel username (@handle)." },
          text: { type: "string", description: "Message text, 1-4096 chars." },
          campaignLabel: { type: "string", description: "Campaign attribution label." },
          reason: { type: "string", description: "Why this post (ledger)." },
        },
      },
    },
    exec,
    toIntent: () => ({
      tool: "telegram.postMessage",
      level: PermissionLevel.FINANCIAL,
      valueUsd: 0,
    }),
  };
}
