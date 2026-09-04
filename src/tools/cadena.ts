// La cadena donde la agente OPERA por defecto.
//
// Estaba escrito 137 (Polygon) a mano en exchange.ts, trading.ts y
// wallet.ts. Pero su USDC vive en BASE desde el primer swap del 28/08, así
// que cada llamada sin chainId explícito iba a una cadena con saldo cero.
// El 2026-09-03 eso la metió en un bucle de "ERC20: transfer amount exceeds
// balance" hasta que dedujo sola que debía usar Base.
//
// Un default equivocado es peor que no tener default: la manda a fallar en
// silencio y le hace creer que el problema es otro.
export function cadenaPorDefecto(): number {
  const n = Number(process.env.KAIZEN_CHAIN_DEFAULT || 8453);
  return Number.isInteger(n) && n > 0 ? n : 8453;
}
