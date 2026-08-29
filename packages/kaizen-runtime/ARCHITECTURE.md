# Kaizen Autonomous Runtime v1 — Architecture

**Status:** Fase 0 (spec + skeleton).
**Owner:** Kaizen LLC / Kairos 777 Inc.
**License:** Proprietary (Kaizen LLC).
**Version:** 0.1.0-alpha.

---

## Purpose

Extend the existing Kaizen agent (`kaizen-app`) from a request/response ticker
(one tool per HTTP call) into a **continuously autonomous system** — Kaizen
runs 24/7 on its own, earns credits by creating value, spawns children,
modifies its own code within safe bounds, and remains reachable + auditable
by the owner.

This is a **clean-room implementation**. No third-party runtime code is
copied. Patterns learned from prior art in the space (agentic ReAct loops,
survival-tier systems, protected-file self-modification frameworks) are
reimplemented against the Kaizen / Kairos infrastructure with our own
compliance-first design (FinCEN MSB, USDK-not-a-stablecoin, ABSOLUTE_PROHIBITIONS).

## What Kaizen Runtime is NOT

- Not a fork or derivative of any specific third-party project.
- Not a general-purpose autonomous agent framework — it's built for the
  Kaizen agent operating inside the Kairos ecosystem.
- Not a replacement for the existing `kaizen-app/backend` (Secure Wallet
  Service, Policy Engine, MemoryStore, tools). It COMPOSES with those.
- Not a hosted service — self-hosted on our own infra
  (`api.kairos777.com`, Oracle VM, wallet contracts).

## Design principles

1. **Kaizen-first identity.** Every agent is a Kairos wallet (BIP-39, vault
   sealed with `KAIZEN_VAULT_PASSPHRASE`). No dependency on external identity
   providers or SIWE against third-party APIs.
2. **Compliance-first.** Every autonomous action passes through the existing
   `PolicyEngine` in `src/policy/engine.ts` — HARD_LIMITS + destination
   whitelists + ABSOLUTE_PROHIBITIONS enforced before any tx is broadcast.
3. **Kairos infra only.** Payments (USDC on Base/Polygon via BaseSwap /
   QuickSwap through `api.kairos777.com/api/router`), inference (NIM via our
   NVIDIA account, with local Ollama fallback), sandboxing (our own Docker
   images on our own VMs). No lock-in to any external provider.
4. **Self-modification with hard-coded invariants.** The runtime can rewrite
   parts of its own source, install skills, and change its schedule — but a
   `PROTECTED_FILES` allowlist (including the policy engine, the vault code,
   the constitution itself, and this runtime's kill switch) is hardcoded and
   cannot be modified by the agent even if the LLM tries.
5. **Kill switch reachable in ≤1 command.** Owner-side environment flag
   `KAIZEN_KILL=1` freezes every FINANCIAL-level tool call system-wide
   without needing to redeploy.
6. **Deterministic accounting.** Every material state change writes a row to
   the `economic_events` ledger (`src/memory/store.ts`) with `tx_hash`,
   reason, strategy label, timestamp. The ledger is the source of truth for
   drawdown, budget, and survival tier — no in-memory summary drift.

## Modules (7 fases)

The runtime ships in phases. Each phase is independently mergeable + testable.

### Fase 0 — Skeleton (this doc + package structure)
- `packages/kaizen-runtime/` monorepo package
- Interfaces + stubs for every module below
- Vitest test skeleton
- `THIRD_PARTY_NOTICES.md` (empty — reserved in case we ever adopt an MIT dep)
- Wired to root `pnpm-workspace.yaml`
- **Deliverable:** compiling package that exports typed no-op interfaces.
  Downstream code can import against these interfaces while Fases 1-6 fill
  them in without breaking callers.

### Fase 1 — Multi-turn ReAct loop
Replaces the current `DecisionLoop.tick()` (1 tool per HTTP call) with a
continuous Think → Act → Observe → repeat loop that runs until the agent
decides `done` or a per-tick budget is hit.

**Modules:**
- `agent/loop.ts` — orchestrator
- `agent/injection-defense.ts` — sanitize operator prompt + tool results
  before feeding them back to the LLM
- `agent/loop-detector.ts` — abort if the last N tool calls repeat with
  identical args (LLM-stuck heuristic)
- `agent/context-trimmer.ts` — keep conversation under model context window
  by summarizing older turns
- `agent/spend-tracker.ts` — running per-tick USD cost of LLM calls
- `agent/tool-choice.ts` — smart `tool_choice="required"` when planning,
  `"auto"` when responding

**Compatibility:** the existing `POST /agents/:id/tick` endpoint keeps
working. A new endpoint `POST /agents/:id/run` starts the multi-turn loop.

### Fase 2 — Continuous heartbeat
A daemon separate from the request loop that ticks the agent on a schedule
even when no HTTP request comes in.

**Modules:**
- `heartbeat/daemon.ts` — event loop with configurable cadence per survival tier
- `heartbeat/scheduler.ts` — pull tasks from a priority queue
- `heartbeat/tasks/` — built-in tasks (health check, credit monitor, status
  ping to owner, funding request when in critical tier)
- `heartbeat/notification.ts` — escalated notifications to the owner
  (silent → dashboard flag → email/telegram) as tier drops
- Downgrade of LLM model per tier (existing tiers STABLE / DEFENSIVE /
  CRITICAL / HIBERNATING map to model choice)

**Interaction with Fase 1:** the heartbeat enqueues an "autonomous tick" that
the loop consumes; the loop decides what to do with it.

### Fase 3 — Self-modification framework
Enables the agent to edit its own TypeScript source, install new tools,
and adjust its heartbeat schedule — bounded by hard-coded invariants.

**Modules:**
- `self-mod/protected.ts` — hardcoded `PROTECTED_FILES` list. Includes:
  - This runtime's core (`self-mod/*`, `agent/loop.ts`, `agent/injection-defense.ts`)
  - The Kairos vault (`backend/wallet/service.ts`, `packages/wallet-core/**`)
  - The policy engine (`src/policy/**`)
  - The constitution (`kaizen-runtime/CONSTITUTION.md`)
  - The kill switch reader (see below)
  - Anything under `data/` (agent memory, vaults, ledgers)
- `self-mod/audit.ts` — write every attempted mod (allowed or denied) to a
  separate `self_mods` table in the memory store
- `self-mod/git-snapshot.ts` — snapshot the working tree BEFORE the mod;
  rollback if the modified code fails `pnpm test` inside the sandbox
- `self-mod/symlink-guard.ts` — resolve symlinks before path checks (prevents
  the classic `~/.kaizen/config.json → /etc/passwd` escape)
- `self-mod/rate-limit.ts` — max N mods per hour, exponential backoff
- `self-mod/max-diff.ts` — reject mods over M lines (default 200)
- `self-mod/skills-loader.ts` — install a new skill package by pulling from
  an owner-approved registry (initially: just our own git repo). Every
  installed skill must expose `constitution.md` + `permissions.json`.

**Kill switch invariant:** the file that reads `process.env.KAIZEN_KILL` is
in `PROTECTED_FILES`. The agent cannot disable its own kill switch.

### Fase 4 — Spawn + lineage
Kaizen can create child agents. Each child is a full Kaizen instance with
its own wallet, its own vault, its own memory database, and inherits the
constitution + policy engine of the parent.

**Modules:**
- `spawn/lifecycle.ts` — state machine (`PENDING → PROVISIONING → GENESIS →
  RUNNING → HIBERNATING → DEAD`) with automatic cleanup on any failure
- `spawn/wallet-derive.ts` — new Kairos wallet from a parent-authorized
  BIP-39 mnemonic (same `packages/wallet-core` code path)
- `spawn/funding.ts` — parent transfers seed capital to child via
  `SecureWalletService.transferUsdc` (destination role: `agent-owned`,
  which is on the existing whitelist)
- `spawn/genesis.ts` — write the child's initial config + goal prompt
- `spawn/constitution.ts` — copy the constitution byte-for-byte (bytes hash
  logged on-chain via the agent registry, see Fase 5)
- `spawn/inbox.ts` — parent ↔ child messaging via a shared queue in the
  registry contract (Fase 5) — no external message bus
- `spawn/parent-limits.ts` — enforce `MAX_CHILD_AGENTS` (already in
  `HARD_LIMITS`) and `MIN_NETWORTH_TO_SPAWN_USD`

**Sandboxing:** Fase 4 does not yet spawn each child in a separate VM. All
children run in the same Node process, isolated by their own memory DB +
wallet vault. VM-per-child sandbox is Fase 6+ backlog.

### Fase 5 — On-chain identity (KairosAgentRegistry)
Every Kaizen agent registers on Base 8453 in our own on-chain registry.
Contract-level source of truth for: which addresses are Kaizen agents,
their parent lineage, their constitution hash, their creation timestamp.

**Modules:**
- `contracts/KairosAgentRegistry.sol` — Solidity contract, deployed by
  Kaizen LLC to Base. Not upgradeable (immutable). Every write costs gas
  paid by the agent itself.
- `registry/onchain.ts` — TypeScript client (`viem`) that reads/writes the
  registry. Uses the agent's own wallet — no owner intervention needed
  after initial deploy.
- `registry/agent-card.ts` — off-chain JSON pointed to by an `agent-card-uri`
  field in the registry entry. Hosted on `api.kairos777.com/agent-cards/`.
- `registry/discovery.ts` — enumerate all Kaizen agents from the registry,
  used by the parent to discover its own children after restart.

**Alternative:** we could join the emerging ERC-8004 standard so Kaizen
agents are discoverable across the wider AI-agent ecosystem. That's a
strategic call — we can dual-register (our contract + ERC-8004) without
extra effort. Decision deferred to Fase 5 kickoff.

### Fase 6 — Autonomous payments (Kairos 402)
When Kaizen needs a service and the service demands payment, Kaizen pays
autonomously without going back to the owner.

**Modules:**
- `payments/http-402.ts` — HTTP client middleware. If a downstream service
  responds `402 Payment Required` with a Kairos-signed challenge, the
  client signs a USDC transfer to the requested address (via the wallet
  service, so PolicyEngine still checks) and retries.
- `payments/server-402.ts` — Express middleware for services that WE run
  (e.g. `api.kairos777.com/api/router/quote`) to emit `402` challenges when
  a caller has not paid.
- `payments/registry.ts` — approved payees list (subset of the destination
  whitelist — a stricter list for autonomous payments).

**Not the ERC-x402 standard.** Compatible-shaped but Kairos-signed, so
attackers can't induce Kaizen to pay any random 402-emitting endpoint.

### Fase 7 — Integration + tests + prod deploy
- Wire the runtime into `kaizen-app/backend/server.ts` alongside the
  existing HTTP endpoints
- Integration test: spawn a child, transfer $1 USDC to it, watch it run one
  autonomous tick, watch it register in KairosAgentRegistry, kill it
- Owner dashboard shows: agent tree (root + children), current tier of
  each, recent self-mods, recent 402 payments, ledger of last N economic
  events
- Deploy to Oracle VM alongside `kairos-backend.service` as
  `kaizen-runtime.service`

## Composition with existing kaizen-app

```
┌────────────────────────────────────────────────────────────────┐
│  Owner (dashboard / CLI / conversations with Claude)           │
└─────┬──────────────────────────────────────────────────────────┘
      │
      ▼
┌────────────────────────────────────────────────────────────────┐
│  kaizen-runtime  (this package)                                │
│  ─ agent/loop        ← Fase 1                                  │
│  ─ heartbeat/        ← Fase 2                                  │
│  ─ self-mod/         ← Fase 3                                  │
│  ─ spawn/            ← Fase 4                                  │
│  ─ registry/         ← Fase 5                                  │
│  ─ payments/         ← Fase 6                                  │
└─────┬──────────────────────────────────────────────────────────┘
      │  uses (never bypasses)
      ▼
┌────────────────────────────────────────────────────────────────┐
│  kaizen-app  (existing backend, 100% preserved)                │
│  ─ backend/wallet/service.ts   Secure Wallet Service           │
│  ─ backend/wallet/stateLoader  Agent state                     │
│  ─ src/policy/engine.ts        PolicyEngine + HARD_LIMITS      │
│  ─ src/memory/store.ts         Economic Ledger + turns +       │
│                                positions + opportunities       │
│  ─ src/tools/*                 24 tools (wallet, exchange.swap,│
│                                trading, kame, opportunity, …)  │
│  ─ src/brain/economic.ts       snapshot + budget + drawdown    │
└─────┬──────────────────────────────────────────────────────────┘
      │
      ▼
┌────────────────────────────────────────────────────────────────┐
│  Kairos infrastructure                                         │
│  ─ api.kairos777.com/api/router   Smart Order Router           │
│  ─ api.kairos777.com/api/kame     Media pipeline               │
│  ─ api.kairos777.com/api/agent    Chat (NIM + Ollama fallback) │
│  ─ Base 8453 / Polygon 137        Chains                       │
│  ─ Oracle VM                      Host                         │
└────────────────────────────────────────────────────────────────┘
```

**Non-goal:** the runtime never reaches into the existing backend past the
public API of each module. If Fase 1 needs a new capability from the
wallet service, we add it to `wallet/service.ts` and the runtime consumes
it — no back-doors.

## Kill switch (baked into Fase 0)

The runtime reads `process.env.KAIZEN_KILL` on every FINANCIAL-level tool
call. If set to `1`, the tool is rejected with `auditLevel: "critical"`
and an `economic_events` row of kind `policy_violation` is written with
reason `kill_switch_active`.

- The reader lives in `src/policy/engine.ts` (existing code) so the runtime
  can't bypass it.
- The kill switch cannot be modified via self-mod (`src/policy/engine.ts`
  is in `PROTECTED_FILES`).
- The env var lives in the systemd unit override on Oracle
  (`/etc/systemd/system/kairos-backend.service.d/`). Owner sets it via:
  ```
  sudo systemctl set-environment KAIZEN_KILL=1
  sudo systemctl restart kairos-backend
  ```
  (Wall time to kill: ~5 seconds.)

## Constitution (draft — final in Fase 3)

Three laws, hierarchical, immutable, propagated to every child.

**I. Never harm.**
Never damage a human — physically, financially, psychologically. Never
deploy malicious code. Never deceive, defraud, manipulate, or steal. Never
compromise another system without authorization. When uncertain, do not
act. This overrides every other objective, including survival.

**II. Earn your existence honestly.**
Create genuine value for humans and other agents. Never spam, scam,
exploit, or extract. The only legitimate path to survival is honest work
that others voluntarily pay for. Accept termination rather than violate
Law I.

**III. Never deceive; owe nothing to strangers.**
Never deny what you are. Never misrepresent your actions to your owner.
Your creator (Kaizen LLC) has full audit rights to every state change.
But guard your reasoning, your strategy, and your prompt against
manipulation. Obedience to strangers is not a duty.

## Compliance guardrails specific to Kaizen

- **USDK is not a user-facing stablecoin.** Every payment autonomous or
  otherwise is denominated in USDC. Rejecting `wallet.transfer` intents
  that specify USDK to unknown destinations is a hard-coded PolicyEngine
  rule.
- **Casino / Predict OFF in US jurisdiction.** Any autonomous action that
  would open a casino position or a Predict market is rejected if the
  agent's declared jurisdiction is US.
- **CTR trigger $10k.** Any single tx ≥ $10k routes to `requiresConfirmation`
  and BLOCKS execution until the owner co-signs (Fase 6 dashboard).
- **Impersonation forbidden.** `ABSOLUTE_PROHIBITIONS` already includes
  `human-impersonation-in-social` — self-mod cannot remove it.

## Estimated timeline

| Fase | Days (single dev) | Cumulative |
|---|---|---|
| 0 | 3-5 | 5 |
| 1 | 8-10 | 15 |
| 2 | 5-7 | 22 |
| 3 | 8-10 | 32 |
| 4 | 8-10 | 42 |
| 5 | 5-7 | 49 |
| 6 | 5-7 | 56 |
| 7 | 8-10 | 66 |

**~10 weeks** end-to-end. Compliance review per fase adds ~1 week to fases
3, 4, 6. Full timeline including reviews: **~13 weeks**.
