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

/** Minimal ERC-20 interface for balance reads + transfers + approvals. */
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

/** UniswapV2-compatible router (BaseSwap, QuickSwap, SushiSwap V2 all fit). */
const UNIV2_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
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

/** Sign + broadcast a native (ETH / POL) transfer. Used for gas seeding
 *  a child agent so it can transact from its own wallet — same policy
 *  gate as ERC-20 transfers via SecureWalletService. Amount in ETH,
 *  gasLimit optional (default 21000 for a plain transfer). */
export async function signAndSendNativeTransfer(params: {
  chain: ChainConfig;
  privateKey: string;
  to: string;
  amountEth: number;
  gasLimit?: bigint;
}): Promise<TransactionResponse> {
  const { chain, privateKey, to, amountEth, gasLimit } = params;
  const provider = getProvider(chain);
  const signer = new Wallet(privateKey, provider);
  const value = parseUnits(amountEth.toString(), 18);
  return signer.sendTransaction({ to, value, gasLimit: gasLimit ?? 21000n });
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

/** Read ERC-20 allowance in raw units. */
export async function erc20Allowance(
  chain: ChainConfig,
  tokenAddress: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const provider = getProvider(chain);
  const c = new Contract(tokenAddress, ERC20_ABI, provider);
  const raw = await c.allowance(owner, spender);
  return raw as bigint;
}

/** Sign + broadcast an ERC-20 approve. amountRaw is in wei/token-base units. */
export async function signAndSendErc20Approve(params: {
  chain: ChainConfig;
  privateKey: string;
  tokenAddress: string;
  spender: string;
  amountRaw: bigint;
}): Promise<TransactionResponse> {
  const { chain, privateKey, tokenAddress, spender, amountRaw } = params;
  const provider = getProvider(chain);
  const signer = new Wallet(privateKey, provider);
  const token = new Contract(tokenAddress, ERC20_ABI, signer);
  return token.approve(spender, amountRaw);
}

/** Sign + broadcast a UniswapV2-style swap (swapExactTokensForTokens).
 *  Values are RAW (wei-scale). Caller is responsible for approval + slippage. */
export async function signAndSendUniv2Swap(params: {
  chain: ChainConfig;
  privateKey: string;
  routerAddress: string;
  amountInRaw: bigint;
  amountOutMinRaw: bigint;
  path: string[];
  to: string;
  deadline: number;           // unix seconds
  gasLimit?: bigint;
}): Promise<TransactionResponse> {
  const {
    chain, privateKey, routerAddress,
    amountInRaw, amountOutMinRaw, path, to, deadline, gasLimit,
  } = params;
  const provider = getProvider(chain);
  const signer = new Wallet(privateKey, provider);
  const router = new Contract(routerAddress, UNIV2_ROUTER_ABI, signer);
  const overrides: { gasLimit?: bigint } = {};
  if (gasLimit) overrides.gasLimit = gasLimit;
  return router.swapExactTokensForTokens(amountInRaw, amountOutMinRaw, path, to, deadline, overrides);
}
