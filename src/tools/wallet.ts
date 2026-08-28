// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — Wallet tools
//
//  Two flavors:
//   - wallet.getBalance: read-only, level 0. Safe for the LLM to call
//     freely. Returns USDC + POL + net worth from the Economic Brain.
//   - wallet.transfer: level 3, always routed through the Secure Wallet
//     Service which re-validates via Policy Engine and signs.
//
//  These are the ONLY code paths the agent uses to touch chain. If a
//  new capability is needed, it goes here — not by giving the LLM a
//  private key.
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import type { SecureWalletService } from "../../backend/wallet/service.js";

// ── wallet.getBalance ────────────────────────────────────────────────
interface GetBalanceArgs { /* no args */ }
export interface GetBalanceResult {
  address: string;
  usdc: number;
  pol: number;
  chain: "Polygon";
}

export function makeGetBalanceTool(
  service: SecureWalletService,
): RegisteredTool<GetBalanceArgs, GetBalanceResult> {
  const exec: ToolFn<GetBalanceArgs, GetBalanceResult> = async (_args, ctx) => {
    const { address, usdc, pol } = await service.readBalances(ctx.agentId);
    return { address, usdc, pol, chain: "Polygon" };
  };

  return {
    def: {
      name: "wallet.getBalance",
      description:
        "Read the agent's on-chain balances (USDC and POL) on Polygon. No side effects.",
      level: PermissionLevel.READ_ONLY,
      parameters: { type: "object", properties: {} },
    },
    exec,
    toIntent: (_a, _ctx) => ({
      tool: "wallet.getBalance",
      level: PermissionLevel.READ_ONLY,
    }),
  };
}

// ── wallet.transfer ──────────────────────────────────────────────────
export interface TransferArgs {
  to: string;
  destinationRole: string;
  amountUsdc: number;
  reason: string;
}
export interface TransferResult {
  txHash: string;
  chain: string;
  amountUsdc: number;
}

export function makeTransferTool(
  service: SecureWalletService,
): RegisteredTool<TransferArgs, TransferResult> {
  const exec: ToolFn<TransferArgs, TransferResult> = async (args, ctx) => {
    const result = await service.transferUsdc({
      agentId: ctx.agentId,
      to: args.to,
      destinationRole: args.destinationRole,
      amountUsdc: args.amountUsdc,
      reason: args.reason,
    });
    if (!result.ok) {
      throw new Error(`Policy rejected: ${result.reason}`);
    }
    return {
      txHash: result.txHash,
      chain: result.chain,
      amountUsdc: result.amountUsdc,
    };
  };

  return {
    def: {
      name: "wallet.transfer",
      description:
        "Transfer USDC on Polygon from the agent's wallet to a whitelisted destination. " +
        "Requires reason (recorded in the Economic Ledger). Rejected if it would breach " +
        "any Policy Engine limit — the agent must not retry blindly.",
      level: PermissionLevel.FINANCIAL,
      parameters: {
        type: "object",
        required: ["to", "destinationRole", "amountUsdc", "reason"],
        properties: {
          to: {
            type: "string",
            description: "Destination EVM address (EIP-55 checksum).",
          },
          destinationRole: {
            type: "string",
            description:
              "One of: kairos-exchange, kairos-treasury, kaizen-parent-treasury, " +
              "known-vendor, agent-owned. Any other value is rejected.",
          },
          amountUsdc: {
            type: "number",
            description: "Amount in USDC (human units, not wei).",
          },
          reason: {
            type: "string",
            description:
              "Short justification recorded in the Economic Ledger. Required so " +
              "every transfer has an auditable purpose.",
          },
        },
      },
    },
    exec,
    toIntent: (a, _ctx) => ({
      tool: "wallet.transfer",
      level: PermissionLevel.FINANCIAL,
      valueUsd: a.amountUsdc,
      destinationRole: a.destinationRole,
      chainId: 137,
    }),
  };
}
