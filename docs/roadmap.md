# Kaizen — Roadmap

## Fase 0 — Foundation (in progress, 2-4 sem)

- [x] Repo skeleton (`kaizen-app`)
- [x] Policy Engine — hard limits + engine + tests
- [x] Dataset curation pipeline (`training/scripts/curate_dataset.py`)
- [x] SFT training script (`training/scripts/sft_qlora.py`)
- [x] Baseline eval harness (`training/scripts/eval_baseline.py`)
- [ ] Lightning AI account (owner action)
- [ ] Copy raw JSONL from Oracle → `datasets/raw/` (owner action, one command)
- [ ] Run curation → verify ≥3000 usable rows
- [ ] Baseline eval Qwen3-8B on Lightning AI
- [ ] Legal review — MSB/IA Act inter-company (owner action)
- [ ] Draft inter-company service agreement Kaizen LLC ↔ Kairos 777 Inc

## Fase 1 — MVP1 (6-8 sem after Fase 0)

- [ ] Kaizen-8B-v0.1 SFT (5k rows, QLoRA)
- [ ] Vendored `packages/wallet-core` from kairos-wallet vault module
- [ ] Agent identity + auto-generated wallet
- [ ] Economic Brain — net_worth, budget, ROI, drawdown, risk metrics
- [ ] Tool System v1 — `wallet.*`, `exchange.*`, `kame.*` (minimum viable)
- [ ] Secure Wallet Service backend — policy-enforced signing
- [ ] Permission System (levels 0-3)
- [ ] Trading Engine — single strategy (momentum)
- [ ] Commerce Engine — affiliate only
- [ ] Memory Engine — short/long-term
- [ ] Dashboard v1
- [ ] **Milestone: run the 26-step end-to-end loop on Polygon testnet**

## Fase 2 — MVP2 (8-12 sem after MVP1)

- [ ] DPO training pass on preference-labeled outputs
- [ ] Multi-strategy trading (momentum + mean-reversion + arbitrage)
- [ ] KAME full autonomous marketing loop
- [ ] Social Distribution Layer (Meta + X OAuth adapters)
- [ ] Autonomous A/B testing
- [ ] Reinvestment Engine
- [ ] Survival Economy state machine (GROWING → ... → HIBERNATING)
- [ ] Compliance module (CTR/SAR draft auto-generation)
- [ ] **Milestone: mainnet, seed capital $500-1000 USDC, real income**

## Fase 3 — Advanced (3-6 meses after MVP2)

- [ ] GRPO training — verifiable rewards (pytest for code, exec for SQL, etc.)
- [ ] Agent Spawn (parent → child agents)
- [ ] Multi-agent orchestration
- [ ] Cross-chain expansion
- [ ] Agent Marketplace

## Non-goals (never)

- Distilling from Claude, GPT-4, Gemini, or any closed model.
- Third-party fund custody until Kairos 777 Inc Investment Adviser license is
  approved AND Kaizen LLC has its own MSB (or ICA covers it).
- Human impersonation on social platforms.
- Unlimited token approvals.
- Any chain outside `HARD_LIMITS.ALLOWED_CHAINS`.
