// El incidente que estos tests custodian (2026-09-03): la agente mandó seis
// transferencias de 0.01 USDC a 0x3c499c…f619 —el contrato de USDC en
// Polygon— pero sobre BASE, donde nadie controla esa dirección. Perdió $0.06
// y cada intento devolvió txHash y "éxito". Esa dirección ya acumula 1300
// USDC de otra gente que hizo lo mismo.
//
// La regla existía en HARD_LIMITS y nada la evaluaba.

import { describe, it, expect } from "vitest";
import { revisarDestino, destinoExisteEnCadena } from "../destinos.js";

const BILLETERA_REAL = "0x1111111111111111111111111111111111111111";

describe("revisarDestino", () => {
  it("BLOQUEA la dirección exacta del incidente", () => {
    const v = revisarDestino("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
    expect(v.ok).toBe(false);
    expect(v.categoria).toBe("transfer-to-unknown-eoa");
    expect(v.motivo).toContain("contrato de un token");
  });

  it("bloquea sin importar mayúsculas — una dirección es la misma en cualquier grafía", () => {
    expect(revisarDestino("0x3C499C542CEF5E3811E1192CE70D8CC03D5C3359").ok).toBe(false);
    expect(revisarDestino("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359").ok).toBe(false);
  });

  it("bloquea otros contratos de token, no sólo el del incidente", () => {
    for (const c of [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base
      "0x4200000000000000000000000000000000000006", // WETH Base
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT Polygon
    ]) {
      expect(revisarDestino(c).ok, `dejó pasar ${c}`).toBe(false);
    }
  });

  it("bloquea la dirección cero y la de quema", () => {
    expect(revisarDestino("0x0000000000000000000000000000000000000000").ok).toBe(false);
    expect(revisarDestino("0x000000000000000000000000000000000000dEaD").ok).toBe(false);
  });

  it("bloquea mandarse dinero a sí misma — sólo quema gas", () => {
    const v = revisarDestino(BILLETERA_REAL, BILLETERA_REAL);
    expect(v.ok).toBe(false);
    expect(v.motivo).toContain("propia dirección");
  });

  it("bloquea cualquier cosa que no sea una dirección", () => {
    for (const basura of ["", "hola", "0x123", null, undefined, 42, "0xZZZZ", BILLETERA_REAL + "00"]) {
      expect(revisarDestino(basura as never).ok, `dejó pasar ${String(basura)}`).toBe(false);
    }
  });

  it("DEJA PASAR una billetera normal — el guardia no puede paralizarla", () => {
    const v = revisarDestino(BILLETERA_REAL);
    expect(v.ok).toBe(true);
    expect(v.categoria).toBeUndefined();
  });

  it("deja pasar su propia dirección si no se le dice cuál es la propia", () => {
    // El chequeo de auto-envío es opcional: sin ese dato no se inventa.
    expect(revisarDestino(BILLETERA_REAL).ok).toBe(true);
  });
});

describe("destinoExisteEnCadena", () => {
  it("bloquea una dirección sin código y sin historial", async () => {
    const falso = "http://rpc.invalido";
    const orig = globalThis.fetch;
    // Se simula el proveedor devolviendo código vacío y nonce 0.
    const v = await destinoExisteEnCadena(BILLETERA_REAL, falso);
    // Con un RPC inválido debe FALLAR ABIERTO, no bloquear.
    expect(v.ok).toBe(true);
    globalThis.fetch = orig;
  });

  it("falla abierto si el RPC no responde — no puede dejarla sin pagar a nadie", async () => {
    const v = await destinoExisteEnCadena(BILLETERA_REAL, "http://127.0.0.1:1");
    expect(v.ok).toBe(true);
  });
});

// Prueba de extremo a extremo: el guardia sólo sirve si la Policy Engine
// efectivamente RECHAZA. Sin esto, revisarDestino podría estar perfecto y el
// dinero irse igual — que es exactamente lo que pasó el 2026-09-03.
describe("la cadena completa rechaza el destino del incidente", () => {
  it("toIntent + PolicyEngine bloquean la transferencia", async () => {
    const { PolicyEngine } = await import("../engine.js");
    const { PermissionLevel } = await import("../limits.js");
    const { makeTransferTool } = await import("../../tools/wallet.js");

    const tool = makeTransferTool({} as never);
    const intent = tool.toIntent(
      {
        to: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        destinationRole: "known-vendor",   // la etiqueta que ella se inventó
        amountUsdc: 0.01,
        reason: "prueba",
      },
      { agentId: "agt_demo" },
    );
    expect(intent.category).toBe("transfer-to-unknown-eoa");

    const decision = new PolicyEngine().evaluate(
      {
        agentId: "agt_demo", netWorthUsd: 6, cashUsd: 3, peakNetWorthUsd: 6,
        openPositions: 0, outflow24hUsd: 0, outflow7dUsd: 0, txCountLastHour: 0,
        toolCallsLastMinute: 0, gpuSpend24hUsd: 0, adSpend24hUsd: 0,
        maxAllowedLevel: PermissionLevel.FINANCIAL,
        selfLimits: { maxTxUsd: 50, maxTradeUsd: 50, maxDailyOutflowUsd: 100, strategyExposureCapPct: 25 },
      },
      intent,
    );
    expect(decision.allow, "la Policy Engine dejó pasar el destino muerto").toBe(false);
  });

  it("y DEJA PASAR una billetera normal", async () => {
    const { makeTransferTool } = await import("../../tools/wallet.js");
    const intent = makeTransferTool({} as never).toIntent(
      { to: BILLETERA_REAL, destinationRole: "vendor", amountUsdc: 0.01, reason: "x" },
      { agentId: "agt_demo" },
    );
    expect(intent.category).toBeUndefined();
  });
});
