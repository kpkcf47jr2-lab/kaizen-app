// ═══════════════════════════════════════════════════════════════════════
//  Deploy KairosAgentRegistry to an EVM chain.
//
//  Usage:
//    export DEPLOYER_PRIVATE_KEY=0x...
//    npx tsx scripts/deploy-registry.ts <chainId>
//
//  chainId 8453 → Base mainnet
//  chainId 84532 → Base Sepolia
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { REGISTRY_ABI } from "../src/registry/onchain.js";

const RPCS: Record<number, string> = {
  8453:  process.env.BASE_RPC_URL   || "https://mainnet.base.org",
  84532: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

async function main() {
  const chainId = Number(process.argv[2] || 8453);
  const rpc = RPCS[chainId];
  if (!rpc) throw new Error(`Unsupported chainId ${chainId}`);
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY env var required");

  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const deployer = new Wallet(pk, provider);
  const bal = await provider.getBalance(deployer.address);
  console.log(`Deployer  : ${deployer.address}`);
  console.log(`Balance   : ${formatEther(bal)} ETH`);
  console.log(`Chain     : ${chainId} (${chainId === 8453 ? "Base mainnet" : chainId === 84532 ? "Base Sepolia" : "unknown"})`);

  // Load compiled artifact
  const here = path.dirname(fileURLToPath(import.meta.url));
  const artifactPath = path.resolve(here, "..", "contracts", "out", "combined.json");
  const combined = JSON.parse(readFileSync(artifactPath, "utf8"));
  const key = Object.keys(combined.contracts).find((k) => k.includes("KairosAgentRegistry"));
  if (!key) throw new Error(`KairosAgentRegistry not found in ${artifactPath}`);
  const bytecode = "0x" + combined.contracts[key].bin;

  console.log(`Bytecode  : ${(bytecode.length - 2) / 2} bytes`);
  const factory = new ContractFactory(REGISTRY_ABI, bytecode, deployer);

  console.log("→ estimating gas…");
  const deployTx = await factory.getDeployTransaction();
  const gas = await provider.estimateGas({ ...deployTx, from: deployer.address });
  const gasPrice = (await provider.getFeeData()).maxFeePerGas ?? 1_000_000n;
  const gasCostWei = gas * gasPrice;
  console.log(`Gas est.  : ${gas.toString()} × ${gasPrice.toString()} = ${formatEther(gasCostWei)} ETH`);
  if (bal < gasCostWei) throw new Error("Insufficient balance for deploy");

  console.log("→ deploying…");
  const t0 = Date.now();
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction()!.wait();
  const address = await contract.getAddress();
  console.log(`\n✓ deployed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  address     : ${address}`);
  console.log(`  tx hash     : ${receipt!.hash}`);
  console.log(`  block       : ${receipt!.blockNumber}`);
  console.log(`  gas used    : ${receipt!.gasUsed.toString()}`);
  console.log(`  explorer    : ${chainId === 8453 ? "https://basescan.org/address/" : "https://sepolia.basescan.org/address/"}${address}`);

  // Sanity read
  const c = new (await import("ethers")).Contract(address, REGISTRY_ABI, provider);
  const total = await c.totalRegistered();
  console.log(`\n  post-deploy read totalRegistered = ${total.toString()} (expected 0)`);

  console.log(`\nNext step: paste into KAIROS_AGENT_REGISTRY_ADDRESSES[${chainId}] in src/registry/onchain.ts`);
}

main().catch((e) => {
  console.error("deploy failed:", e);
  process.exit(1);
});
