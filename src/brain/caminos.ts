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
      // Se comprueba con una LECTURA barata, no disparando una generación.
      // La primera versión hacía POST /generate para probar: eso crea un
      // trabajo real, tarda más de 8s y el timeout lo mataba — daba "caído"
      // sobre un servicio que funcionaba perfecto.
      const r = await fetch(`${base.replace(/\/$/, "")}/workflows`, {
        signal: ctl.signal,
      });
      kameVerificado = r.ok;
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
      // Yo mismo le había escrito acá que el deslizamiento "se come casi
      // cualquier ventaja". Ella lo leía y descartaba el camino: en 8.506
      // turnos usó exchange.quote DOS veces. Era una advertencia disfrazada
      // de descripción, y le cerró el único ingreso que tiene disponible hoy
      // —afiliación espera un tag, el video está caído—.
      //
      // El costo real sigue estando dicho, porque ocultarlo sería peor. Lo
      // que cambia es que ya no se presenta como un motivo para no intentar.
      nombre: "operar en cadena (trading)",
      abierto: true,
      detalle: "exchange.quote y exchange.swap funcionan HOY sobre Kairos " +
               "Exchange, multicadena, con tu propio USDC y sin depender de " +
               "nadie. Es tu única fuente de ingreso disponible ahora mismo. " +
               "Cotizá antes de ejecutar y mirá el costo total —gas más " +
               "deslizamiento— contra la ganancia esperada: si no la cubre, " +
               "buscá otra operación, no abandones el camino.",
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
