# Kaizen AI

Autonomous Entrepreneur AI. A Kaizen LLC product.

Kaizen is an autonomous economic agent: it discovers opportunities, allocates
capital, executes strategies, measures results, and reinvests — with its own
identity, wallet, memory, and tools.

## Status

Fase 0 — Foundation. Not yet functional. See `docs/roadmap.md`.

## Architecture (high level)

```
Kaizen Brain (Qwen3-8B + LoRA adapters)
    │
    ├── Economic Brain — net_worth, budget, ROI, drawdown
    ├── Opportunity Engine — trading, commerce, content, services
    ├── Decision Engine — OBSERVE → SIMULATE → RISK → EXECUTE → LEARN
    ├── Memory Engine — short/long-term + economic + strategy + market
    │
    ├── Tool System
    │     ├── wallet.*    — via Secure Wallet Service (backend-signed)
    │     ├── exchange.*  — Kairos Exchange API
    │     ├── kame.*      — creative generation
    │     ├── commerce.*  — affiliate + digital + POD
    │     ├── social.*    — Meta/TikTok/YT/X/Google (OAuth)
    │     ├── analytics.* — ROAS, conversions, campaign perf
    │     └── web.*       — search + browse + read
    │
    └── Policy Engine (System Hard Limits ← immutable, Self-defined ← mutable)
```

## Corporate / Legal

- Kaizen AI (this app) is a **Kaizen LLC** product.
- Wallet backend and financial rails are provided by **Kairos 777 Inc**
  (subsidiary, MSB FinCEN #31000334088277) via inter-company service agreement.
- These are two separate legal entities. Do not mix branding.
- The AI never holds private keys directly. All signing happens in the
  Secure Wallet Service backend with hard-cap policy enforcement.

## Repository layout

```
src/
  agent/       — core loop and message routing
  brain/       — Economic Brain, Opportunity Engine, Decision Engine
  tools/       — tool implementations (wallet, exchange, kame, etc.)
  memory/      — memory adapters (short-term, long-term, ledger)
  policy/      — Policy Engine, permission levels, hard limits
  wallet/      — client-side wallet UI (uses packages/wallet-core)
  ui/          — screens, components, design system
  config/      — env, features, constants
packages/
  wallet-core/ — vendored Kairos Wallet vault + signing primitives
datasets/
  raw/         — extracted chats (gitignored)
  curated/     — cleaned training data
  evals/       — held-out eval sets
training/
  scripts/     — SFT / DPO / GRPO training pipelines
  configs/     — hyperparameter configs
  adapters/    — LoRA checkpoints (small, tracked; large go to HF Hub)
docs/          — specs, decisions, roadmap
```

## License

Proprietary. Copyright © Kaizen LLC. All rights reserved.
