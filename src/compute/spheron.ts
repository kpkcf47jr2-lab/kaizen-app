// ═══════════════════════════════════════════════════════════════════════
//  Spheron — el único proveedor que Kaizen puede pagar POR SÍ MISMA.
//
//  Runpod, Lightning y NVIDIA Brev cobran con API key, o sea contra una
//  cuenta con tarjeta de un humano. Eso rompe la premisa: si alguien tiene
//  que poner la tarjeta, la agente no se autoabastece.
//
//  Spheron corre sobre BASE con escrow on-chain, y el SDK firma con una
//  llave privada — así ella paga su propio cómputo sin intermediario.
//
//  ⚠ VERIFICADO CONTRA EL SDK REAL (2026-09-03, @spheron/protocol-sdk 2.6.0):
//
//    · El escrow de mainnet NO acepta USDC. getUserBalance("USDC") tira
//      "Transaction failed without revert data". Los únicos símbolos que
//      responden son uSPON y SPON.
//    · uSPON es "USD Pegged SPON" (0xBf0f…0f5e), desplegado y vivo en Base
//      mainnet. El SDK define ADEMÁS uSPONTestnet (0xeD8F…23D2), que no
//      existe en mainnet: confundirlas hace creer que la red está rota.
//    · Los seis métodos que usa este adaptador existen con estas firmas:
//      getUserBalance(token, wallet), depositBalance({token,amount}),
//      withdrawBalance({token,amount}), createDeployment(icl, proxyUrl),
//      getDeployment(leaseId, proxyUrl), closeDeployment(leaseId).
//
//  O sea: el riel funciona, pero se paga en uSPON. Para pagarlo con el USDC
//  que ella tiene hace falta el paso previo USDC → uSPON.
//
//  SEGURIDAD — por qué esto recibe una función y no una llave:
//  la llave de Kaizen vive cifrada en el vault y sólo se abre dentro del
//  Secure Wallet Service para firmar. Entregársela cruda a una librería de
//  terceros tiraría ese modelo abajo. Este adaptador pide una función que
//  DEVUELVE la llave sólo en el momento de firmar y nunca la guarda en un
//  campo, para que su vida en memoria sea lo más corta posible.
// ═══════════════════════════════════════════════════════════════════════

import type { ComputeProvider, GpuOption, Rental, RentalRequest } from "./provider.js";

export interface SpheronConfig {
  /** Devuelve la llave sólo cuando hay que firmar. No se cachea. */
  getPrivateKey: () => Promise<string>;
  /** 'mainnet' = Base. 'testnet' = Base Sepolia. */
  networkType?: "mainnet" | "testnet";
  /** Token del escrow. USDC es el que tiene Kaizen. */
  token?: string;
  /** Proxy del provider que exige el SDK para hablar con el operador. */
  providerProxyUrl?: string;
  /** Catálogo de GPUs. El SDK no expone un listado, así que se declara. */
  catalog?: GpuOption[];
}

/** Sin listado on-chain, el catálogo es explícito y auditable: `list()` no
 *  inventa precios. Referencia de Spheron al 2026-09-03. */
/** uSPON de MAINNET. Verificado on-chain el 2026-09-03: 22.700 bytes de
 *  código en Base mainnet (8453). Ojo: el SDK define también uSPONTestnet
 *  (0xeD8F…23D2), que NO existe en mainnet — confundirlas hace creer que la
 *  red entera está rota cuando no lo está. */
const USPON_ADDR = "0xBf0fA0461331d815A103e59929E5a19A48C30f5e";

const DEFAULT_CATALOG: GpuOption[] = [
  { id: "rtx4090", name: "RTX 4090 24GB", hourlyUsd: 0.35, vramGb: 24 },
  { id: "a100-40", name: "A100 40GB", hourlyUsd: 1.10, vramGb: 40 },
  { id: "h100", name: "H100 80GB", hourlyUsd: 0.72, vramGb: 80 },
];

export class SpheronComputeProvider implements ComputeProvider {
  name = "spheron";
  private readonly cfg: SpheronConfig & {
    networkType: "mainnet" | "testnet";
    token: string;
    providerProxyUrl: string;
  };
  private readonly rentals = new Map<string, Rental>();

  constructor(cfg: SpheronConfig) {
    const networkType = cfg.networkType ?? "mainnet";
    this.cfg = {
      ...cfg,
      networkType,
      // VERIFICADO CONTRA EL SDK REAL (2026-09-03, @spheron/protocol-sdk 2.6.0):
      // el escrow NO acepta "USDC" en mainnet. getUserBalance("USDC") tira
      // "Transaction failed without revert data"; el único símbolo del
      // tokenMap de mainnet es uSPON. En testnet sí hay USDC de prueba.
      token: cfg.token ?? (networkType === "mainnet" ? "uSPON" : "USDC"),
      providerProxyUrl: cfg.providerProxyUrl ?? "https://provider-proxy.spheron.network",
    };
  }

  /** Comprueba que se pueda pagar ANTES de gastar.
   *
   *  El escrow de mainnet cobra en uSPON, no en USDC. Verificado el
   *  2026-09-03: no hay liquidez USDC → uSPON en ningún DEX de Base, así que
   *  la agente no puede conseguir uSPON por su cuenta partiendo del USDC que
   *  tiene. Decírselo con ese detalle evita que lo reintente sin entender.
   */
  async redUsable(): Promise<{ ok: boolean; motivo?: string }> {
    if (this.cfg.networkType !== "mainnet") return { ok: true };
    try {
      const { ethers } = await import("ethers");
      const prov = new ethers.JsonRpcProvider("https://mainnet.base.org");
      if ((await prov.getCode(USPON_ADDR)) === "0x") {
        return { ok: false, motivo: `El token uSPON (${USPON_ADDR}) no responde en Base mainnet.` };
      }
      const saldo = await new ethers.Contract(
        USPON_ADDR, ["function balanceOf(address) view returns (uint256)"], prov,
      ).balanceOf(await this.direccion()).catch(() => 0n);
      if (saldo === 0n) {
        return {
          ok: false,
          motivo:
            "Spheron cobra en uSPON y no tenés uSPON. Tu USDC no sirve directo, " +
            "y no hay liquidez USDC → uSPON en ningún DEX de Base, así que no " +
            "podés conseguirlo cambiando. Hay que adquirirlo por fuera. " +
            "No reintentes este camino hasta tener uSPON en la wallet.",
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, motivo: `No se pudo verificar: ${(e as Error).message}` };
    }
  }

  /** Dirección pública de la wallet que firma. */
  private async direccion(): Promise<string> {
    const { ethers } = await import("ethers");
    return new ethers.Wallet(await this.cfg.getPrivateKey()).address;
  }

  /** El SDK se construye por operación y se descarta: la llave no queda
   *  viva en memoria más de lo estrictamente necesario. */
  private async sdk(): Promise<Record<string, any>> {
    const mod = (await import("@spheron/protocol-sdk")) as Record<string, any>;
    const Ctor = mod.SpheronSDK;
    return new Ctor({
      networkType: this.cfg.networkType,
      privateKey: await this.cfg.getPrivateKey(),
    });
  }

  async list(): Promise<GpuOption[]> {
    return this.cfg.catalog ?? DEFAULT_CATALOG;
  }

  /** Saldo que Kaizen tiene depositado en el escrow, en USDC. */
  async escrowBalanceUsd(): Promise<number> {
    const sdk = await this.sdk();
    const b = await sdk.escrow.getUserBalance(this.cfg.token);
    const n = Number(b?.unlockedBalance ?? b?.balance ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  /** Deposita USDC desde su propia wallet. Este es el acto que la vuelve
   *  autosuficiente: nadie pone una tarjeta. */
  async depositUsd(amount: number): Promise<{ ok: boolean; txHash?: string; reason?: string }> {
    if (!(amount > 0)) return { ok: false, reason: "El depósito tiene que ser mayor a cero" };
    try {
      const sdk = await this.sdk();
      const r = await sdk.escrow.depositBalance({ token: this.cfg.token, amount });
      return { ok: true, txHash: r?.transactionHash ?? r?.hash };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /** Recupera lo no gastado. Sin esto el capital queda atrapado en el escrow. */
  async withdrawUsd(amount: number): Promise<{ ok: boolean; txHash?: string; reason?: string }> {
    try {
      const sdk = await this.sdk();
      const r = await sdk.escrow.withdrawBalance({ token: this.cfg.token, amount });
      return { ok: true, txHash: r?.transactionHash ?? r?.hash };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async rent(req: RentalRequest): Promise<Rental> {
    const opt = (await this.list()).find((o) => o.id === req.gpuTypeId);
    const now = Date.now();
    const base: Rental = {
      rentalId: "",
      provider: this.name,
      gpuTypeId: req.gpuTypeId,
      hourlyUsd: opt?.hourlyUsd ?? 0,
      startedAt: now,
      autoStopAt: now + req.hoursMax * 3_600_000,
      status: "failed",
    };
    if (!opt) return { ...base, reason: `GPU desconocida: ${req.gpuTypeId}` };

    // Antes de tocar plata: ¿esta red sirve? Fallar acá con un motivo claro
    // es mucho mejor que fallar depositando contra un contrato inexistente.
    const red = await this.redUsable();
    if (!red.ok) return { ...base, reason: red.motivo ?? "Red no usable" };

    // El costo entero del alquiler tiene que estar depositado ANTES de
    // arrancar: si el escrow se vacía a mitad, el lease muere y se pierde
    // lo ya pagado sin haber terminado el trabajo.
    const needed = opt.hourlyUsd * req.hoursMax;
    const have = await this.escrowBalanceUsd().catch(() => 0);
    if (have < needed) {
      const missing = Number((needed - have).toFixed(2));
      const dep = await this.depositUsd(missing);
      if (!dep.ok) {
        return { ...base, reason: `No se pudieron depositar los $${missing} que faltan: ${dep.reason}` };
      }
    }

    try {
      const sdk = await this.sdk();
      const res = await sdk.deployment.createDeployment(
        buildIcl({ gpu: opt, req }),
        this.cfg.providerProxyUrl,
      );
      const leaseId = String(res?.leaseId ?? "");
      if (!leaseId) return { ...base, reason: "Spheron no devolvió leaseId" };
      const rental: Rental = { ...base, rentalId: leaseId, status: "starting" };
      this.rentals.set(leaseId, rental);
      return rental;
    } catch (e) {
      return { ...base, reason: (e as Error).message };
    }
  }

  async status(rentalId: string): Promise<Rental> {
    const known = this.rentals.get(rentalId);
    const fallback: Rental = known ?? {
      rentalId,
      provider: this.name,
      gpuTypeId: "?",
      hourlyUsd: 0,
      startedAt: 0,
      autoStopAt: 0,
      status: "failed",
      reason: "Alquiler no conocido por este proceso",
    };
    try {
      const sdk = await this.sdk();
      const d = await sdk.deployment.getDeployment(rentalId, this.cfg.providerProxyUrl);
      const running = Boolean(d?.services && Object.keys(d.services).length);
      const updated: Rental = { ...fallback, status: running ? "running" : "starting" };
      this.rentals.set(rentalId, updated);
      return updated;
    } catch (e) {
      return { ...fallback, reason: (e as Error).message };
    }
  }

  async stop(rentalId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const sdk = await this.sdk();
      await sdk.deployment.closeDeployment(rentalId);
      const known = this.rentals.get(rentalId);
      if (known) this.rentals.set(rentalId, { ...known, status: "stopped" });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
}

/** Spheron describe el despliegue en ICL (YAML). Se arma acotado al alquiler
 *  pedido —duración y precio incluidos— para que el gasto no pueda exceder
 *  lo que la Policy Engine ya aprobó. */
export function buildIcl({ gpu, req }: { gpu: GpuOption; req: RentalRequest }): string {
  const image = req.imageName ?? "pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel";
  const disk = req.containerDiskGb ?? 50;
  const env = Object.entries(req.envVars ?? {})
    .map(([k, v]) => `        - ${k}=${v}`)
    .join("\n");
  return `version: "1.0"
services:
  kaizen:
    image: ${image}
    expose:
      - port: 8000
        as: 80
        to:
          - global: true
${env ? `    env:\n${env}\n` : ""}profiles:
  name: kaizen
  duration: ${req.hoursMax}h
  mode: provider
  tier:
    - community
  compute:
    kaizen:
      resources:
        cpu:
          units: 8
        memory:
          size: 32Gi
        storage:
          - size: ${disk}Gi
        gpu:
          units: 1
          attributes:
            vendor:
              nvidia:
                - model: ${gpu.id}
  placement:
    westcoast:
      pricing:
        kaizen:
          token: USDC
          amount: ${gpu.hourlyUsd}
deployment:
  kaizen:
    westcoast:
      profile: kaizen
      count: 1
`;
}
