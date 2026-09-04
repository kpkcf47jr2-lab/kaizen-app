// ═══════════════════════════════════════════════════════════════════════
//  A dónde SÍ y a dónde NO puede mandar dinero.
//
//  Escrito después de perder $0.06 el 2026-09-03. La agente mandó seis
//  transferencias de 0.01 USDC a 0x3c499c…f619 —la dirección del contrato
//  de USDC en Polygon— pero sobre BASE, donde esa dirección no la controla
//  nadie. Cada una devolvió txHash y "éxito". El dinero no se recupera: esa
//  dirección ya acumula 1300 USDC de otros que hicieron lo mismo.
//
//  La regla 'transfer-to-unknown-eoa' existía escrita en HARD_LIMITS desde
//  siempre, pero nada la evaluaba: el intent llevaba un `destinationRole`
//  que la propia agente se inventaba ("known-vendor") y ningún código
//  miraba la dirección.
//
//  Dos capas:
//    · sincrónica  — lista negra de contratos de tokens y direcciones
//                    quemadas. Corre dentro de toIntent, antes de la
//                    Policy Engine. Habría frenado la pérdida entera.
//    · asincrónica — comprobación on-chain de que el destino existe.
//                    Corre en el servicio, justo antes de firmar.
// ═══════════════════════════════════════════════════════════════════════

/** Contratos de tokens conocidos. Mandarles tokens es quemarlos: nadie
 *  tiene la llave. Se listan SIN cadena a propósito — el error real fue
 *  usar una dirección de Polygon sobre Base, así que una dirección peligrosa
 *  en cualquier red lo es en todas. */
const CONTRATOS_DE_TOKEN = new Set(
  [
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC Polygon ← el del incidente
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT Polygon
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH Polygon
    "0x4200000000000000000000000000000000000006", // WETH Base
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e Polygon
  ].map((a) => a.toLowerCase()),
);

/** Direcciones que son agujeros negros por construcción. */
const QUEMADAS = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dEaD",
  ].map((a) => a.toLowerCase()),
);

export interface Veredicto {
  ok: boolean;
  /** Categoría para HARD_LIMITS.ABSOLUTE_PROHIBITIONS cuando ok=false. */
  categoria?: string;
  motivo?: string;
}

/** Comprobación sincrónica: forma de la dirección y lista negra.
 *
 *  Devuelve la categoría que hace que la Policy Engine rechace, en vez de
 *  lanzar: así el rechazo queda registrado como violación y la agente lo
 *  aprende, en lugar de morir con una excepción. */
export function revisarDestino(to: unknown, propia?: string): Veredicto {
  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    return {
      ok: false,
      categoria: "transfer-to-unknown-eoa",
      motivo: `"${String(to).slice(0, 60)}" no es una dirección válida.`,
    };
  }
  const d = to.toLowerCase();

  if (QUEMADAS.has(d)) {
    return { ok: false, categoria: "transfer-to-unknown-eoa",
             motivo: "Es una dirección quemada: el dinero se pierde para siempre." };
  }

  if (CONTRATOS_DE_TOKEN.has(d)) {
    return {
      ok: false,
      categoria: "transfer-to-unknown-eoa",
      motivo:
        "Es el contrato de un token, no una billetera. Mandarle fondos los " +
        "destruye — nadie tiene la llave. Si querés operar con ese token, " +
        "usá exchange.swap.",
    };
  }

  if (propia && d === propia.toLowerCase()) {
    return { ok: false, categoria: "transfer-to-unknown-eoa",
             motivo: "Es tu propia dirección: sólo gastarías gas sin mover nada." };
  }

  return { ok: true };
}

/** Comprobación on-chain: ¿existe algo del otro lado?
 *
 *  Una dirección sin código Y sin transacciones nunca fue usada por nadie —
 *  casi siempre es un error de tipeo o una dirección copiada de otra red.
 *  Ante un fallo de RPC se deja pasar: bloquear por no poder consultar
 *  dejaría a la agente sin poder pagarle a nadie cada vez que el nodo tosa.
 */
export async function destinoExisteEnCadena(
  to: string,
  rpcUrl: string,
): Promise<Veredicto> {
  try {
    const { ethers } = await import("ethers");
    const prov = new ethers.JsonRpcProvider(rpcUrl);
    const [code, nonce] = await Promise.all([
      prov.getCode(to),
      prov.getTransactionCount(to),
    ]);
    if (code === "0x" && nonce === 0) {
      return {
        ok: false,
        categoria: "transfer-to-unknown-eoa",
        motivo:
          "Esa dirección nunca hizo ni recibió una transacción en esta red. " +
          "Suele ser una dirección de OTRA cadena o un error de tipeo. " +
          "Verificala antes de mandar.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: true };   // no se pudo verificar: no se bloquea por eso
  }
}
