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
import { revisarDestino } from "../policy/destinos.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import type { SecureWalletService } from "../../backend/wallet/service.js";

// ── wallet.getBalance ────────────────────────────────────────────────
interface GetBalanceArgs { /* no args */ }
export interface GetBalanceResult {
  address: string;
  /** Totals summed across all whitelisted chains. */
  usdc: number;
  /** Sum of native across chains (POL + ETH etc). */
  native: number;
  /** Per-chain split so the agent can pick which chain to transact on. */
  byChain: Record<number, { usdc: number; native: number; nativeSymbol: string }>;
}

export function makeGetBalanceTool(
  service: SecureWalletService,
): RegisteredTool<GetBalanceArgs, GetBalanceResult> {
  const exec: ToolFn<GetBalanceArgs, GetBalanceResult> = async (_args, ctx) => {
    const { address, usdc, native, byChain } = await service.readBalances(ctx.agentId);
    return { address, usdc, native, byChain };
  };

  return {
    def: {
      name: "wallet.getBalance",
      description:
        "Read the agent's on-chain balances across all whitelisted chains " +
        "(Polygon 137 + Base 8453). Returns totals plus per-chain split " +
        "under `byChain`. Call this before wallet.transfer / trading.* to " +
        "know where the USDC lives and how much gas each chain has. " +
        "Read-only, no cost.",
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
  /** Which chain to send USDC on. Default 137 (Polygon).
   *  Also accepted: 8453 (Base). Any other value is rejected by the
   *  Secure Wallet Service before the policy check even runs. */
  chainId?: number;
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
    // Si no dice cadena, se usa DONDE TIENE PLATA — no un 137 fijo. Su USDC
    // vive en Base desde el primer swap, así que el default viejo la mandaba
    // a una cadena con saldo cero: fallaba, reintentaba, y así en bucle.
    let chainId = args.chainId;
    if (chainId === undefined) {
      const b = await service.readBalances(ctx.agentId).catch(() => null);
      const conSaldo = b && Object.entries(b.byChain)
        .filter(([, v]) => v.usdc >= args.amountUsdc)
        .sort((x, y) => y[1].usdc - x[1].usdc)[0];
      chainId = conSaldo ? Number(conSaldo[0]) : 137;
    }
    const result = await service.transferUsdc({
      agentId: ctx.agentId,
      to: args.to,
      destinationRole: args.destinationRole,
      amountUsdc: args.amountUsdc,
      reason: args.reason,
      chainId,
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
        "Transfer USDC from the agent's wallet to a whitelisted destination. " +
        "Works on Polygon (chainId=137, default) or Base (chainId=8453). " +
        "Requires reason (recorded in the Economic Ledger). Rejected if it " +
        "would breach any Policy Engine limit — the agent must not retry blindly. " +
        "Pick chainId based on where the agent has USDC (call wallet.getBalance " +
        "first — the byChain field shows the per-chain split).",
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
          chainId: {
            type: "number",
            enum: [137, 8453],
            description: "137 = Polygon (default). 8453 = Base.",
          },
        },
      },
    },
    exec,
    toIntent: (a, _ctx) => {
      // El destino se REVISA acá, antes de la Policy Engine. Antes iba sólo
      // el `destinationRole` que la propia agente se inventaba, así que la
      // prohibición 'transfer-to-unknown-eoa' nunca se evaluaba y se
      // perdieron $0.06 mandando USDC al contrato de USDC de otra red.
      const v = revisarDestino(a.to);
      return {
        tool: "wallet.transfer",
        level: PermissionLevel.FINANCIAL,
        valueUsd: a.amountUsdc,
        destinationRole: a.destinationRole,
        chainId: a.chainId ?? 137,
        ...(v.ok ? {} : { category: v.categoria, metadata: { motivo: v.motivo } }),
      };
    },
  };
}
