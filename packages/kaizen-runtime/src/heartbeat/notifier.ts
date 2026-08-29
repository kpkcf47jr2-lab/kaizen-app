// ═══════════════════════════════════════════════════════════════════════
//  OwnerNotifier — escalated notifications to the owner
//
//  Three levels, mapping to real channels:
//    · silent  — dashboard flag only (no external delivery)
//    · banner  — dashboard-visible banner + optional email digest
//    · urgent  — email/telegram/PagerDuty (out of band)
//
//  Fase 2 ships the interface + a console-logging default. The real
//  wiring to email/telegram lives in the kaizen-app backend and is
//  injected via the RealOwnerNotifier subclass at boot time. The runtime
//  never learns any owner PII.
// ═══════════════════════════════════════════════════════════════════════

export type NotifyLevel = "silent" | "banner" | "urgent";

export interface OwnerNotification {
  ts: number;
  level: NotifyLevel;
  subject: string;
  body: string;
  agentId: string;
  category: string;
}

export interface IOwnerNotifier {
  notify(level: NotifyLevel, subject: string, body: string, opts?: { agentId?: string; category?: string }): Promise<void>;
  recent(sinceMs: number): OwnerNotification[];
}

/** Cooldown per (agentId, level, subject) so a chatty task doesn't
 *  spam the owner. Bounded by-slot: silent 5min, banner 1h, urgent 6h. */
const COOLDOWN_MS: Record<NotifyLevel, number> = {
  silent: 5 * 60_000,
  banner: 60 * 60_000,
  urgent: 6 * 60 * 60_000,
};

export class ConsoleOwnerNotifier implements IOwnerNotifier {
  private readonly log: OwnerNotification[] = [];
  private readonly cooldownMap = new Map<string, number>();
  constructor(private readonly agentId = "unknown") {}

  async notify(level: NotifyLevel, subject: string, body: string, opts?: { agentId?: string; category?: string }): Promise<void> {
    const agentId = opts?.agentId ?? this.agentId;
    const category = opts?.category ?? "general";
    const key = `${agentId}:${level}:${subject}`;
    const now = Date.now();
    const last = this.cooldownMap.get(key) ?? 0;
    if (now - last < COOLDOWN_MS[level]) return;
    this.cooldownMap.set(key, now);

    const evt: OwnerNotification = { ts: now, level, subject, body, agentId, category };
    this.log.push(evt);
    if (this.log.length > 500) this.log.shift();

    // Fase 2 default sink is console — Fase 6 dashboard exposes recent()
    // and the real wiring to email/telegram is injected as a subclass.
    // eslint-disable-next-line no-console
    console.log(`[kaizen-notify ${level}] (${category}) ${agentId}: ${subject}\n  ${body}`);
  }

  recent(sinceMs: number): OwnerNotification[] {
    const cutoff = Date.now() - sinceMs;
    return this.log.filter((e) => e.ts >= cutoff);
  }
}
