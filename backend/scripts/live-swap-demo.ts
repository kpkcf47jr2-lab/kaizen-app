// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — live swap demo
//
//  Owner-authorized 2026-08-28: swap 1.50 USDC → WETH on Base 8453.
//  Runs the FULL chain: quote → Policy Engine → SecureWalletService →
//  vault open → sign → broadcast → receipt → ledger.
// ═══════════════════════════════════════════════════════════════════════

import { FileAgentRegistry } from "../../src/agent/registry.js";
import { MemoryStore } from "../../src/memory/store.js";
import { ComposedStateLoader } from "../wallet/stateLoader.js";
import { SecureWalletService } from "../wallet/service.js";
import { FileVaultStore } from "../wallet/vaultStore.js";

const AGENT_ID = "agt_demo";
const AMOUNT_USDC = 1.50;
const CHAIN_ID = 8453;                                              // Base
const WETH_BASE = "0x4200000000000000000000000000000000000006";     // WETH on Base

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Kaizen live-swap demo — $1.50 USDC → WETH on Base 8453");
  console.log("═══════════════════════════════════════════════════════════\n");

  const registry = new FileAgentRegistry();
  const vault = new FileVaultStore();
  const stateLoader = new ComposedStateLoader(registry, {
    137: Number(process.env.KAIZEN_POL_USD_RATE || 0.5),
    8453: Number(process.env.KAIZEN_ETH_USD_RATE || 3200),
  });
  const wallet = new SecureWalletService(vault, stateLoader);

  console.log("→ reading pre-swap balance…");
  const before = await wallet.readBalances(AGENT_ID);
  const beforeBaseUsdc = before.byChain[8453]?.usdc ?? 0;
  const beforeBaseNative = before.byChain[8453]?.native ?? 0;
  console.log(`  address       : ${before.address}`);
  console.log(`  Base USDC     : ${beforeBaseUsdc}`);
  console.log(`  Base ETH gas  : ${beforeBaseNative.toFixed(8)} ETH`);
  console.log("");

  console.log("→ delegating to SecureWalletService.swapExactUsdcFor()…");
  const t0 = Date.now();
  const res = await wallet.swapExactUsdcFor({
    agentId: AGENT_ID,
    chainId: CHAIN_ID,
    buyToken: WETH_BASE,
    buyTokenDecimals: 18,
    amountUsdc: AMOUNT_USDC,
    strategy: "eth-toehold-base",
    reason: "First live swap on Base — establishing exchange.swap tool works end-to-end.",
    slippageBps: 50,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    console.error(`\n✗ swap rejected: ${res.reason}`);
    console.error(`  auditLevel: ${res.auditLevel}`);
    // Log the policy violation for the ledger
    const mem = new MemoryStore(AGENT_ID);
    try {
      mem.recordEvent({
        ts: Date.now(),
        kind: "policy_violation",
        reason: `live-swap-demo rejected: ${res.reason}`,
        metadata: JSON.stringify({ amountUsdc: AMOUNT_USDC, chainId: CHAIN_ID, buyToken: WETH_BASE }),
      });
    } finally { mem.close(); }
    process.exit(2);
  }

  console.log(`\n✓ swap succeeded in ${dt}s\n`);
  console.log(`  chain           : ${res.chain}`);
  console.log(`  bestDex         : ${res.bestDex}`);
  console.log(`  routerAddress   : ${res.routerAddress}`);
  console.log(`  strategy        : ${res.strategy}`);
  console.log(`  amountUsdcIn    : ${res.amountUsdcIn}`);
  console.log(`  buyAmountRaw    : ${res.buyAmountRaw} (${Number(res.buyAmountRaw) / 1e18} WETH)`);
  console.log(`  minBuyAmountRaw : ${res.minBuyAmountRaw}`);
  console.log(`  approveTxHash   : ${res.approveTxHash ?? "(not needed — allowance already sufficient)"}`);
  console.log(`  swapTxHash      : ${res.swapTxHash}`);
  console.log(`  quoteFeeUsd     : ${res.quoteFeeUsd}`);
  console.log(`  gasSpentEth     : ${res.gasSpentEth}`);
  console.log("");
  console.log(`  BaseScan swap   : https://basescan.org/tx/${res.swapTxHash}`);
  if (res.approveTxHash) {
    console.log(`  BaseScan approve: https://basescan.org/tx/${res.approveTxHash}`);
  }

  // Record trade_swap event in the ledger (mirrors what the tool wrapper does)
  console.log("\n→ writing trade_swap event to Economic Ledger…");
  const mem = new MemoryStore(AGENT_ID);
  try {
    mem.recordEvent({
      ts: Date.now(),
      kind: "trade_swap",
      strategy: res.strategy,
      amountUsd: res.amountUsdcIn,
      txHash: res.swapTxHash,
      reason: "First live swap on Base — establishing exchange.swap tool works end-to-end.",
      metadata: JSON.stringify({
        chainId: CHAIN_ID,
        buyToken: WETH_BASE,
        buyAmountRaw: res.buyAmountRaw,
        minBuyAmountRaw: res.minBuyAmountRaw,
        bestDex: res.bestDex,
        routerAddress: res.routerAddress,
        approveTxHash: res.approveTxHash,
        quoteFeeUsd: res.quoteFeeUsd,
        gasSpentEth: res.gasSpentEth,
      }),
    });
  } finally { mem.close(); }

  console.log("\n→ reading post-swap balance…");
  await new Promise((r) => setTimeout(r, 3000));                    // let node index
  const after = await wallet.readBalances(AGENT_ID);
  const afterBaseUsdc = after.byChain[8453]?.usdc ?? 0;
  const afterBaseNative = after.byChain[8453]?.native ?? 0;
  const usdcDelta = afterBaseUsdc - beforeBaseUsdc;
  const gasDeltaEth = beforeBaseNative - afterBaseNative;

  console.log(`  Base USDC after : ${afterBaseUsdc}  (Δ ${usdcDelta.toFixed(6)})`);
  console.log(`  Base ETH after  : ${afterBaseNative.toFixed(8)}  (Δ ${(-gasDeltaEth).toFixed(8)} gas)`);
  // Note: WETH balance itself isn't in byChain — the agent now holds it in
  // token form. To surface it we'd have to add WETH to the token registry.

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  DONE — end-to-end swap confirmed on-chain.");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("live-swap-demo FAILED:", e);
  process.exit(1);
});
