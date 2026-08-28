// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — end-to-end MVP demo (Fase 1)
//
//  Runs one full agent tick without any LLM:
//    1. Ensure a demo agent exists (creates + seals vault if not).
//    2. Read on-chain balances via Secure Wallet Service.
//    3. Snapshot Economic Brain (net_worth, drawdown, suggested status).
//    4. Propose a budget for that status.
//    5. Print a dashboard-shaped report.
//
//  Usage:
//    KAIZEN_VAULT_PASSPHRASE=someLongPassphraseHere \
//      npx tsx backend/scripts/demo.ts
//
//  Writes state under $KAIZEN_STATE_DIR (default: ./data). Idempotent —
//  subsequent runs reuse the same agent + wallet.
// ═══════════════════════════════════════════════════════════════════════

import { createAgent } from "../../src/agent/identity.js";
import { FileAgentRegistry } from "../../src/agent/registry.js";
import { snapshot, proposeBudget } from "../../src/brain/economic.js";
import { FileVaultStore } from "../wallet/vaultStore.js";
import { SecureWalletService } from "../wallet/service.js";
import { ComposedStateLoader } from "../wallet/stateLoader.js";

const DEMO_AGENT_ID = "agt_demo";
const DEMO_NAME = "Kaizen Demo #1";
const POL_USD_RATE = 0.5; // hardcoded for MVP

async function main(): Promise<number> {
  const passphrase = process.env.KAIZEN_VAULT_PASSPHRASE;
  if (!passphrase || passphrase.length < 16) {
    console.error("✗ Set KAIZEN_VAULT_PASSPHRASE (≥16 chars) before running.");
    return 2;
  }

  const reg = new FileAgentRegistry();
  const vault = new FileVaultStore();

  // 1. Ensure demo agent exists
  let record = await reg.get(DEMO_AGENT_ID);
  if (!record) {
    console.log(`→ creating agent ${DEMO_AGENT_ID}…`);
    const created = await createAgent(
      { displayName: DEMO_NAME, agentId: DEMO_AGENT_ID },
      vault,
      reg,
      passphrase,
    );
    console.log(`  ✅ address: ${created.address}`);
    record = await reg.get(DEMO_AGENT_ID);
  } else {
    console.log(`→ reusing agent ${DEMO_AGENT_ID}  address=${record.address}`);
  }
  if (!record) throw new Error("registry.get returned null after upsert");

  // 2. Read on-chain balances
  const stateLoader = new ComposedStateLoader(reg, POL_USD_RATE);
  const svc = new SecureWalletService(vault, stateLoader);
  console.log("→ reading on-chain balances (Polygon)…");
  const { address, usdc, pol } = await svc.readBalances(DEMO_AGENT_ID);

  // 3. Snapshot
  const snap = snapshot(
    DEMO_AGENT_ID,
    { usdc, pol, polUsdRate: POL_USD_RATE },
    [],
    { outflow24hUsd: 0, outflow7dUsd: 0 },
    record.peakNetWorthUsd,
  );
  await reg.updatePeak(DEMO_AGENT_ID, snap.peakNetWorthUsd);
  await reg.updateStatus(DEMO_AGENT_ID, snap.suggestedStatus);

  // 4. Budget proposal
  const budget = proposeBudget(snap.netWorthUsd, snap.suggestedStatus);

  // 5. Dashboard-shaped output
  console.log("");
  console.log("┌─────────────────────────────────────────────────");
  console.log(`│  ${DEMO_NAME}  (${DEMO_AGENT_ID})`);
  console.log(`│  address:  ${address}`);
  console.log(`│  status:   ${snap.suggestedStatus}`);
  console.log("├─────────────────────────────────────────────────");
  console.log(`│  Net worth:     $${snap.netWorthUsd.toFixed(2)}`);
  console.log(`│  Cash (USDC):   $${snap.cashUsd.toFixed(2)}`);
  console.log(`│  Gas (POL):     $${snap.gasReserveUsd.toFixed(2)}  (${pol.toFixed(4)} POL)`);
  console.log(`│  Invested:      $${snap.investedUsd.toFixed(2)}`);
  console.log(`│  Peak:          $${snap.peakNetWorthUsd.toFixed(2)}`);
  console.log(`│  Drawdown:      ${snap.drawdownPct.toFixed(1)}%`);
  console.log("├── proposed budget for this tick ─────────────────");
  console.log(`│  Reserve:            $${budget.reserveUsd}`);
  console.log(`│  Trading:            $${budget.tradingUsd}`);
  console.log(`│  Marketing:          $${budget.marketingUsd}`);
  console.log(`│  Product acquisition: $${budget.productAcquisitionUsd}`);
  console.log(`│  Infrastructure:     $${budget.infrastructureUsd}`);
  console.log(`│  Experimentation:    $${budget.experimentationUsd}`);
  console.log("└─────────────────────────────────────────────────");
  console.log("");
  console.log("Next: fund this address with USDC + POL on Polygon, rerun this");
  console.log("script, and the numbers should update.");
  return 0;
}

main().then((n) => process.exit(n)).catch((e) => {
  console.error(e);
  process.exit(1);
});
