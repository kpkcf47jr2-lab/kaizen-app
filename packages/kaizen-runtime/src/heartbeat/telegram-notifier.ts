// ═══════════════════════════════════════════════════════════════════════
//  TelegramOwnerNotifier — real out-of-band delivery via Telegram Bot API
//
//  Setup:
//    1. Owner talks to @BotFather on Telegram → creates a bot → gets a
//       bot token like "1234567890:AAH..."
//    2. Owner messages the bot once → we look up the chat_id via
//       /getUpdates and store it. (Or owner reads their user ID from
//       @userinfobot and passes it explicitly.)
//    3. env:  TELEGRAM_BOT_TOKEN=... + TELEGRAM_OWNER_CHAT_ID=...
//
//  Same interface as ConsoleOwnerNotifier so callers switch by DI.
//  Silent still goes to console (nobody wants a Telegram ping every 30s
//  for a routine tier check). Banner + urgent go to Telegram.
// ═══════════════════════════════════════════════════════════════════════

import type { IOwnerNotifier, NotifyLevel, OwnerNotification } from "./index.js";

export interface TelegramNotifierConfig {
  botToken: string;
  chatId: string | number;
  /** Optional prefix for every message (e.g. "[Kaizen-Prod]"). */
  prefix?: string;
  /** Which levels go out to Telegram. Silent always logs to console only. */
  levelsToTelegram?: NotifyLevel[];
}

const COOLDOWN_MS: Record<NotifyLevel, number> = {
  silent: 5 * 60_000,
  banner: 60 * 60_000,
  urgent: 6 * 60 * 60_000,
};

export class TelegramOwnerNotifier implements IOwnerNotifier {
  private readonly log: OwnerNotification[] = [];
  private readonly cooldownMap = new Map<string, number>();
  private readonly cfg: Required<TelegramNotifierConfig>;

  constructor(cfg: TelegramNotifierConfig) {
    this.cfg = {
      prefix: cfg.prefix ?? "[Kaizen]",
      levelsToTelegram: cfg.levelsToTelegram ?? ["banner", "urgent"],
      ...cfg,
    };
  }

  async notify(level: NotifyLevel, subject: string, body: string, opts?: { agentId?: string; category?: string }): Promise<void> {
    const agentId = opts?.agentId ?? "unknown";
    const category = opts?.category ?? "general";
    const key = `${agentId}:${level}:${subject}`;
    const now = Date.now();
    const last = this.cooldownMap.get(key) ?? 0;
    if (now - last < COOLDOWN_MS[level]) return;
    this.cooldownMap.set(key, now);

    const evt: OwnerNotification = { ts: now, level, subject, body, agentId, category };
    this.log.push(evt);
    if (this.log.length > 500) this.log.shift();

    // Console line — always, for audit + local visibility.
    // eslint-disable-next-line no-console
    console.log(`[kaizen-notify ${level}] (${category}) ${agentId}: ${subject}\n  ${body}`);

    if (!this.cfg.levelsToTelegram.includes(level)) return;

    const text = `${this.cfg.prefix} ${level.toUpperCase()} · ${category} · ${agentId}\n\n<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(body)}`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.cfg.chatId,
          text: text.slice(0, 4000),        // Telegram cap 4096
          parse_mode: "HTML",
        }),
      });
      if (!res.ok) {
        // Non-fatal: falling back to console is fine — the notification
        // is already logged there.
        console.warn(`[TelegramNotifier] failed HTTP ${res.status} — check TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_CHAT_ID`);
      }
    } catch (e) {
      console.warn(`[TelegramNotifier] fetch failed: ${(e as Error).message}`);
    }
  }

  recent(sinceMs: number): OwnerNotification[] {
    const cutoff = Date.now() - sinceMs;
    return this.log.filter((e) => e.ts >= cutoff);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
