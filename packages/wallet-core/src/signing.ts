// ═══════════════════════════════════════════════════════════════════════
//  @kaizen/wallet-core — Signing
//
//  Thin wrapper over ethers so the Secure Wallet Service is the ONLY
//  place that touches a private key. Callers pass an intent (address +
//  chain + prepared tx OR ERC-20 transfer args) and get a signed tx
//  ready to broadcast.
//
//  This module has no policy logic. Policy enforcement happens BEFORE
//  the caller reaches this function — see backend/wallet/service.
// ═══════════════════════════════════════════════════════════════════════

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  parseUnits,
  type TransactionResponse,
} from "ethers";

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  name: string;
}

/** Minimal ERC-20 interface for balance reads + transfers. */
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

export function getProvider(chain: ChainConfig): JsonRpcProvider {
  return new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
}

/** Read on-chain ERC-20 balance in human units (float). Read-only. */
export async function erc20Balance(
  chain: ChainConfig,
  tokenAddress: string,
  owner: string,
): Promise<{ raw: bigint; formatted: number; decimals: number; symbol: string }> {
  const provider = getProvider(chain);
  const c = new Contract(tokenAddress, ERC20_ABI, provider);
  const [raw, decimals, symbol] = await Promise.all([
    c.balanceOf(owner),
    c.decimals(),
    c.symbol().catch(() => "?"),
  ]);
  const rawBig = raw as bigint;
  const dec = Number(decimals);
  const formatted = Number(rawBig) / 10 ** dec;
  return { raw: rawBig, formatted, decimals: dec, symbol };
}

/** Read native balance in human units (float). */
export async function nativeBalance(chain: ChainConfig, owner: string): Promise<number> {
  const provider = getProvider(chain);
  const raw = await provider.getBalance(owner);
  return Number(raw) / 1e18;
}

/**
 * Sign + broadcast an ERC-20 transfer. This is the sensitive path; the
 * caller must have already passed Policy Engine evaluation. `privateKey`
 * is expected to arrive from the vault open() call and be zeroed by the
 * caller immediately after this returns.
 */
export async function signAndSendErc20Transfer(params: {
  chain: ChainConfig;
  privateKey: string;
  tokenAddress: string;
  tokenDecimals: number;
  to: string;
  amount: number;             // human units
  gasLimit?: bigint;
}): Promise<TransactionResponse> {
  const { chain, privateKey, tokenAddress, tokenDecimals, to, amount, gasLimit } = params;
  const provider = getProvider(chain);
  const signer = new Wallet(privateKey, provider);
  const token = new Contract(tokenAddress, ERC20_ABI, signer);
  const value = parseUnits(amount.toString(), tokenDecimals);
  const overrides: { gasLimit?: bigint } = {};
  if (gasLimit) overrides.gasLimit = gasLimit;
  return token.transfer(to, value, overrides);
}
