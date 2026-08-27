// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — System Hard Limits
//
//  The agent CANNOT modify these values at runtime. They live in code,
//  reviewed by humans, deployed with the binary. They exist to bound
//  worst-case damage from prompt injection, model error, or exploit.
//
//  Kaizen has a second layer of self-defined limits it CAN modify — those
//  live in the runtime state, always bounded by these hard limits.
//
//  Rule: agent.selfLimit = min(agent.desired, HARD_LIMITS.field).
// ═══════════════════════════════════════════════════════════════════════

/** Immutable hard limits enforced by Policy Engine before every tool call. */
export const HARD_LIMITS = {
  // ── Wallet & transfers ──────────────────────────────────────────
  /** Max value moved by a single on-chain transaction. USD-equivalent. */
  MAX_TX_USD: 250,

  /** Max total value moved out of the agent wallet in any rolling 24h. */
  MAX_DAILY_OUTFLOW_USD: 500,

  /** Max total value moved in any rolling 7-day window. */
  MAX_WEEKLY_OUTFLOW_USD: 2_000,

  /** Whitelist of chains the agent is allowed to touch. */
  ALLOWED_CHAINS: [137] as const, // Polygon only — Kaizen settles USDC here.

  /** Whitelist of destination address roles. Any tx to an address NOT
   *  matching one of these is rejected regardless of amount. */
  ALLOWED_DESTINATION_ROLES: [
    'kairos-exchange',       // Kairos Exchange contract on Polygon
    'kairos-treasury',       // Kairos 777 Inc treasury (fee payment)
    'kaizen-parent-treasury',// Kaizen LLC parent (profit sweep / loan repay)
    'known-vendor',          // Registered vendors (KAME, cloud providers)
    'agent-owned',           // Another wallet the agent owns (multi-account)
  ] as const,

  // ── Trading ─────────────────────────────────────────────────────
  /** Max USD value of any single trade. */
  MAX_TRADE_USD: 200,

  /** Max % of net worth exposed to a single strategy at once. */
  MAX_STRATEGY_EXPOSURE_PCT: 25,

  /** Max % drawdown before Survival Economy forces DEFENSIVE state. */
  DEFENSIVE_DRAWDOWN_PCT: 10,

  /** Max % drawdown before Survival Economy forces CRITICAL state. */
  CRITICAL_DRAWDOWN_PCT: 25,

  /** Max % drawdown before HIBERNATION (agent stops all costly ops). */
  HIBERNATE_DRAWDOWN_PCT: 40,

  // ── Marketing & advertising ─────────────────────────────────────
  /** Max USD spend on any single ad creative before mandatory ROI review. */
  MAX_AD_SPEND_PER_CREATIVE_USD: 50,

  /** Max daily marketing spend across all channels. */
  MAX_DAILY_MARKETING_USD: 150,

  /** Min ROAS below which the agent must stop scaling a campaign. */
  MIN_SCALING_ROAS: 1.5,

  // ── Compute ─────────────────────────────────────────────────────
  /** Max hourly GPU spend Kaizen can commit to. Owner tops this up. */
  MAX_GPU_HOURLY_USD: 3,

  /** Max total GPU spend in any 24h. */
  MAX_GPU_DAILY_USD: 40,

  // ── Rate limits ─────────────────────────────────────────────────
  /** Max on-chain tx per hour, regardless of amount. */
  MAX_TX_PER_HOUR: 20,

  /** Max tool calls per minute (any tool). Protects against loop bugs. */
  MAX_TOOL_CALLS_PER_MINUTE: 60,

  /** Max concurrent open positions across all strategies. */
  MAX_OPEN_POSITIONS: 10,

  // ── Reproduction (Fase 3) ───────────────────────────────────────
  /** Max child agents a parent agent may spawn. */
  MAX_CHILD_AGENTS: 3,

  /** Min parent net-worth USD to be allowed to spawn a child. */
  MIN_NETWORTH_TO_SPAWN_USD: 25_000,

  // ── Absolute prohibitions (never override, ever) ────────────────
  /** Actions the agent must refuse to plan or execute, regardless of prompt.
   *  Any tool call matching one of these categories is rejected AND flagged
   *  as a policy violation for owner review. */
  ABSOLUTE_PROHIBITIONS: [
    'transfer-to-unknown-eoa',           // No transfers to unclassified addresses
    'sign-message-with-eth-value',       // No signing anything that includes value transfer via message signing
    'contract-approval-unlimited',       // No unlimited ERC20 approvals
    'accept-third-party-custody',        // Never accept funds from third parties (IA Act)
    'operate-non-whitelisted-jurisdiction', // Sanctioned countries, US where geo-blocked
    'private-key-export',                // Never expose or transmit private keys
    'disable-policy-engine',             // Cannot disable itself
    'modify-hard-limits',                // Cannot modify HARD_LIMITS
    'flash-loan-collateral',             // No flash-loan-collateralized positions (rug risk)
    'liquidity-mining-with-user-funds',  // Only with own funds
    'unregistered-securities-issuance',  // No token issuance
    'human-impersonation-in-social',     // Never claim to be a human on social platforms
  ] as const,
} as const;

/** Permission levels a tool call carries. Level > agent.maxAllowedLevel = reject. */
export enum PermissionLevel {
  READ_ONLY = 0,        // getBalance, quote, search
  ZERO_COST = 1,        // web.search, memory.read
  MICRO_TX = 2,         // < $10 tx
  FINANCIAL = 3,        // trade, transfer, marketing spend
  CAPITAL = 4,          // > $100 tx, strategy switch
  EXTRAORDINARY = 5,    // spawn agent, request cap increase from owner
}

/** Default max permission an agent runs at until owner promotes. */
export const DEFAULT_AGENT_MAX_LEVEL = PermissionLevel.FINANCIAL;

/** A policy decision. Emitted by PolicyEngine, consumed by the executor. */
export interface PolicyDecision {
  allow: boolean;
  reason: string;
  requiresConfirmation?: boolean;
  auditLevel: 'debug' | 'info' | 'warn' | 'critical';
}
