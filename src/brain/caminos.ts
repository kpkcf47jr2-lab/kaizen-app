// Qué caminos a ingreso están REALMENTE disponibles.
//
// La agente ve 36 herramientas como una lista de nombres, sin saber cuáles
// tienen credencial. Medido el 2026-09-03: en 20 minutos hizo 15 búsquedas
// y 6 transferencias, y nunca —ni una vez— probó sites.deployLanding, su
// único camino a ingreso que no depende de que el dueño consiga nada.
//
// Esto se calcula del entorno real, no de una lista escrita a mano: si el
// dueño agrega el tag de Amazon mañana, el camino se abre solo.

import type { Camino } from "./prompt.js";

const hay = (k: string) => Boolean(process.env[k]?.trim());

/** null = sin probar, true/false = probado. Se resuelve una vez al arrancar
 *  el backend, no en cada tick: probar cuesta una llamada de red. */
let kameVerificado: boolean | null = null;

/** Prueba de verdad si Kame sirve. Se llama al arrancar; si falla la
 *  comprobación, queda en "sin verificar" y el camino no se anuncia abierto. */
export async function verificarKame(): Promise<boolean> {
  const base = process.env.KAIROS_KAME_BASE || "https://api.kairos777.com/api/kame";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "ping", aspectRatio: "1:1", dryRun: true }),
        signal: ctl.signal,
      });
      kameVerificado = r.status !== 404;
    } finally { clearTimeout(t); }
  } catch {
    kameVerificado = false;
  }
  return kameVerificado;
}

/** Sólo para tests. */
export function fijarKameParaTest(v: boolean | null): void { kameVerificado = v; }

export function caminosDisponibles(): Camino[] {
  return [
    {
      nombre: "publicar una landing",
      abierto: hay("CLOUDFLARE_API_TOKEN") && hay("CLOUDFLARE_ACCOUNT_ID"),
      detalle: hay("CLOUDFLARE_API_TOKEN")
        ? "sites.deployLanding publica una página REAL en internet, con URL pública. " +
          "No necesita capital ni permiso de nadie. Nunca lo probaste."
        : "faltan las claves de Cloudflare",
    },
    {
      nombre: "investigar en la web",
      abierto: hay("SERPER_API_KEY"),
      detalle: hay("SERPER_API_KEY")
        ? "web.search devuelve resultados reales de Google"
        : "falta SERPER_API_KEY — devuelve vacío",
    },
    {
      // NO se afirma "abierto" sin evidencia. Yo lo di por bueno sin probarlo
      // y ella gastó 12 llamadas a kame.createImage confiando en el mapa:
      // todas devolvieron {"ok":false,"error":"Not Found"}. El servicio vive
      // (/health responde 0.2.0-video) pero /image y /video dan 404.
      //
      // Un mapa que miente es peor que no tener mapa: la manda con confianza
      // contra una pared.
      nombre: "crear contenido",
      abierto: kameVerificado === true,
      detalle: kameVerificado === true
        ? "kame.createImage y kame.createVideo generan imágenes y video"
        : kameVerificado === false
          ? "kame.* responde 'Not Found' — el servicio está desplegado pero sin " +
            "las rutas de imagen/video. NO lo uses hasta que el dueño lo arregle."
          : "kame.* sin verificar todavía",
    },
    {
      nombre: "operar en cadena",
      abierto: true,
      detalle: "exchange.quote y exchange.swap funcionan, pero con $3 el " +
               "deslizamiento y el gas se comen casi cualquier ventaja",
    },
    {
      nombre: "enlaces de afiliado",
      abierto: hay("AMAZON_ASSOCIATES_TAG"),
      detalle: hay("AMAZON_ASSOCIATES_TAG")
        ? "affiliate.amazon.link convierte una URL de producto en enlace que paga"
        : "falta el tag de Amazon (en trámite). Sin él NO podés cobrar comisión: " +
          "no insistas con esta herramienta",
    },
    {
      nombre: "catálogo de productos",
      abierto: false,
      detalle: "commerce.discoverProducts usa una API de Amazon deprecada y " +
               "devuelve vacío siempre. Buscá productos con web.search",
    },
    {
      nombre: "difundir",
      abierto: hay("KAIZEN_TELEGRAM_BOT_TOKEN") && hay("KAIZEN_TELEGRAM_DEFAULT_CHAT"),
      detalle: hay("KAIZEN_TELEGRAM_DEFAULT_CHAT")
        ? "telegram.postMessage publica en el canal"
        : "falta el canal de Telegram — sin audiencia nadie ve lo que publiques",
    },
  ];
}
