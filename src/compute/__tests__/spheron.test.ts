// Lo que se prueba acá es el dinero, no la felicidad del camino.
//
// El adaptador de Spheron es el único que gasta USDC real de Kaizen sin que
// medie un humano. Cada caso corresponde a una forma concreta de perder plata.
import { describe, it, expect } from "vitest";
import { SpheronComputeProvider, buildIcl } from "../spheron.js";

const noKey = async () => {
  throw new Error("el vault no debería abrirse en estas pruebas");
};

describe("SpheronComputeProvider", () => {
  it("no toca el vault para listar precios", async () => {
    // Consultar el catálogo no puede requerir la llave: si la pidiera, cada
    // ojeada de precios abriría el vault sin necesidad.
    const p = new SpheronComputeProvider({ getPrivateKey: noKey });
    const gpus = await p.list();
    expect(gpus.length).toBeGreaterThan(0);
    expect(gpus.every((g) => g.hourlyUsd > 0 && g.vramGb > 0)).toBe(true);
  });

  it("rechaza una GPU que no existe sin firmar nada", async () => {
    const p = new SpheronComputeProvider({ getPrivateKey: noKey });
    const r = await p.rent({ gpuTypeId: "no-existe", hoursMax: 1 });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("GPU desconocida");
  });

  it("un depósito de cero o negativo se corta antes de tocar la cadena", async () => {
    const p = new SpheronComputeProvider({ getPrivateKey: noKey });
    for (const amount of [0, -5]) {
      const r = await p.depositUsd(amount);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("mayor a cero");
    }
  });

  it("no arranca el alquiler si no pudo cubrir lo que falta en el escrow", async () => {
    // El fallo del depósito tiene que abortar: un lease sin fondos muere a
    // mitad y se pierde lo ya pagado sin trabajo terminado.
    const p = new SpheronComputeProvider({
      getPrivateKey: async () => "0x" + "11".repeat(32),
    });
    // Sin red, el saldo del escrow falla -> 0, y el depósito también falla.
    const r = await p.rent({ gpuTypeId: "h100", hoursMax: 2 });
    expect(r.status).toBe("failed");
    expect(r.rentalId).toBe("");
  });

  it("el ICL fija duración y precio del alquiler aprobado", async () => {
    // Si el YAML no llevara el tope, el gasto real podría exceder lo que la
    // Policy Engine autorizó.
    const icl = buildIcl({
      gpu: { id: "h100", name: "H100 80GB", hourlyUsd: 0.72, vramGb: 80 },
      req: { gpuTypeId: "h100", hoursMax: 3 },
    });
    expect(icl).toContain("duration: 3h");
    expect(icl).toContain("amount: 0.72");
    expect(icl).toContain("token: USDC");
    expect(icl).toContain("model: h100");
  });

  it("las variables de entorno del pedido llegan al despliegue", async () => {
    const icl = buildIcl({
      gpu: { id: "rtx4090", name: "RTX 4090 24GB", hourlyUsd: 0.35, vramGb: 24 },
      req: { gpuTypeId: "rtx4090", hoursMax: 1, envVars: { MODEL: "kaizen-8b" } },
    });
    expect(icl).toContain("MODEL=kaizen-8b");
  });

  it("por defecto apunta a Base mainnet y cobra en USDC", async () => {
    // Base es donde vive el USDC de Kaizen. Si el default cambiara a otra
    // red, sus fondos no estarían del lado correcto.
    const p = new SpheronComputeProvider({ getPrivateKey: noKey });
    expect(p.name).toBe("spheron");
    const icl = buildIcl({
      gpu: { id: "h100", name: "H100", hourlyUsd: 1, vramGb: 80 },
      req: { gpuTypeId: "h100", hoursMax: 1 },
    });
    expect(icl).toContain("token: USDC");
  });
});

// Hallazgos verificados contra el SDK real el 2026-09-03. Estos tests son la
// memoria de por qué el adaptador quedó así: sin ellos, alguien "arregla" el
// default a USDC y la agente vuelve a fallar en cada alquiler.
describe("token y red — verificado contra @spheron/protocol-sdk 2.6.0", () => {
  const llaveFalsa = async () => "0x" + "11".repeat(32);

  it("en mainnet usa uSPON, NO USDC — el escrow rechaza USDC", () => {
    const p = new SpheronComputeProvider({ getPrivateKey: llaveFalsa, networkType: "mainnet" });
    expect((p as unknown as { cfg: { token: string } }).cfg.token).toBe("uSPON");
  });

  it("en testnet usa USDC, que ahí sí existe", () => {
    const p = new SpheronComputeProvider({ getPrivateKey: llaveFalsa, networkType: "testnet" });
    expect((p as unknown as { cfg: { token: string } }).cfg.token).toBe("USDC");
  });

  it("un token explícito manda sobre el default", () => {
    const p = new SpheronComputeProvider({ getPrivateKey: llaveFalsa, networkType: "mainnet", token: "DAI" });
    expect((p as unknown as { cfg: { token: string } }).cfg.token).toBe("DAI");
  });

  it("testnet se considera usable sin consultar la cadena", async () => {
    const p = new SpheronComputeProvider({ getPrivateKey: llaveFalsa, networkType: "testnet" });
    await expect(p.redUsable()).resolves.toEqual({ ok: true });
  });

  it("no arranca un alquiler si la red no sirve, y dice por qué", async () => {
    const p = new SpheronComputeProvider({ getPrivateKey: llaveFalsa, networkType: "mainnet" });
    // Se fuerza el veredicto para no depender de la red en los tests.
    p.redUsable = async () => ({ ok: false, motivo: "Spheron cobra en uSPON y no tenés uSPON" });
    const r = await p.rent({ gpuTypeId: "rtx4090", hoursMax: 1 } as never);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("no tenés uSPON");
  });
});
