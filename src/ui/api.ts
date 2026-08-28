// Thin fetch client for the local backend. All requests go through the
// Vite dev proxy at /api → http://127.0.0.1:4711.

export type SurvivalStatus =
  | "GROWING" | "PROFITABLE" | "STABLE"
  | "DEFENSIVE" | "CRITICAL" | "HIBERNATING";

export interface AgentRecord {
  agentId: string;
  displayName: string;
  address: string;
  parentAgentId: string | null;
  createdAt: string;
  status: SurvivalStatus;
  peakNetWorthUsd: number;
  autoTick?: {
    enabled: boolean;
    intervalSeconds: number;
    lastTickTs?: number;
  };
}

export interface Balances { address: string; usdc: number; pol: number }

export interface Snapshot {
  agentId: string;
  ts: number;
  netWorthUsd: number;
  cashUsd: number;
  gasReserveUsd: number;
  investedUsd: number;
  outflow24hUsd: number;
  outflow7dUsd: number;
  peakNetWorthUsd: number;
  drawdownPct: number;
  suggestedStatus: SurvivalStatus;
  breakdown: { cash: number; invested: number; gas: number };
}

export interface Budget {
  reserveUsd: number;
  tradingUsd: number;
  marketingUsd: number;
  productAcquisitionUsd: number;
  infrastructureUsd: number;
  experimentationUsd: number;
}

export interface AgentDetail {
  record: AgentRecord;
  balances: Balances;
  snapshot: Snapshot;
  budget: Budget;
}

export interface EconomicEvent {
  id: number;
  ts: number;
  kind: string;
  strategy: string | null;
  amountUsd: number | null;
  txHash: string | null;
  reason: string;
  confidence: number | null;
  outcome: string | null;
  metadata: string | null;
}

export interface ConversationTurn {
  id: number;
  ts: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCall: string | null;
  toolResult: string | null;
}

export interface TickOutcome {
  kind: "waited" | "tool_call" | "tool_rejected" | "tool_failed";
  reason?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
}

export interface TickResult {
  agentId: string;
  ts: number;
  snapshot: Snapshot;
  budget: Budget;
  outcome: TickOutcome;
  llmContent: string | null;
  usage?: { prompt: number; completion: number; total: number };
}

const BASE = "/api";

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  listAgents: () => jget<{ agents: AgentRecord[] }>("/agents"),
  createAgent: (displayName: string, agentId?: string) =>
    jpost<AgentRecord>("/agents", { displayName, agentId }),
  agent: (id: string) => jget<AgentDetail>(`/agents/${id}`),
  events: (id: string, limit = 50) =>
    jget<{ events: EconomicEvent[] }>(`/agents/${id}/events?limit=${limit}`),
  turns: (id: string, limit = 30) =>
    jget<{ turns: ConversationTurn[] }>(`/agents/${id}/turns?limit=${limit}`),
  tick: (id: string, operatorPrompt?: string) =>
    jpost<TickResult>(`/agents/${id}/tick`, { operatorPrompt }),
  schedule: (id: string, enabled: boolean, intervalSeconds: number) =>
    jpost<{ record: AgentRecord }>(`/agents/${id}/schedule`, { enabled, intervalSeconds }),
};
