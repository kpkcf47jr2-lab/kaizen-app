// La agente ve 36 herramientas como una lista de nombres y no sabe cuáles
// tienen credencial. Medido el 2026-09-03: en 20 minutos hizo 15 búsquedas y
// 6 transferencias, y NUNCA —ni una vez en toda su vida— probó
// sites.deployLanding, su único camino a ingreso que no depende del dueño.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { caminosDisponibles } from "../caminos.js";

const CLAVES = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "SERPER_API_KEY",
                "AMAZON_ASSOCIATES_TAG", "KAIZEN_TELEGRAM_BOT_TOKEN",
                "KAIZEN_TELEGRAM_DEFAULT_CHAT"];
let previo: Record<string, string | undefined> = {};
beforeEach(() => { previo = {}; for (const k of CLAVES) { previo[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of CLAVES) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; } });

const buscar = (n: string) => caminosDisponibles().find((c) => c.nombre.includes(n))!;

describe("caminos disponibles", () => {
  it("con las claves de Cloudflare, la landing figura ABIERTA", () => {
    process.env.CLOUDFLARE_API_TOKEN = "x";
    process.env.CLOUDFLARE_ACCOUNT_ID = "y";
    const c = buscar("landing");
    expect(c.abierto).toBe(true);
    expect(c.detalle).toContain("URL pública");
  });

  it("sin las claves, figura cerrada y dice qué falta", () => {
    const c = buscar("landing");
    expect(c.abierto).toBe(false);
    expect(c.detalle).toContain("Cloudflare");
  });

  it("sin el tag de Amazon le dice que NO insista con esa herramienta", () => {
    const c = buscar("afiliado");
    expect(c.abierto).toBe(false);
    expect(c.detalle).toContain("no insistas");
  });

  it("con el tag, el camino de afiliación se abre solo", () => {
    process.env.AMAZON_ASSOCIATES_TAG = "kaizen777-20";
    expect(buscar("afiliado").abierto).toBe(true);
  });

  it("marca el catálogo como muerto y le ofrece la alternativa", () => {
    const c = buscar("catálogo");
    expect(c.abierto).toBe(false);
    expect(c.detalle).toContain("web.search");
  });

  it("es honesto sobre operar con capital chico", () => {
    expect(buscar("cadena").detalle).toContain("deslizamiento");
  });

  it("sale del entorno real, no de una lista escrita a mano", () => {
    // Si el dueño agrega una credencial, el camino se abre sin tocar código.
    expect(buscar("investigar").abierto).toBe(false);
    process.env.SERPER_API_KEY = "k";
    expect(buscar("investigar").abierto).toBe(true);
  });
});

// Yo marqué "crear contenido" como abierto sin probarlo. Ella confió en el
// mapa y gastó 12 llamadas a kame.createImage: todas devolvieron
// {"ok":false,"error":"Not Found"}. Un mapa que miente es peor que ninguno —
// la manda con confianza contra una pared.
describe("el mapa no afirma sin evidencia", () => {
  it("sin verificar, NO se anuncia abierto", async () => {
    const { fijarKameParaTest } = await import("../caminos.js");
    fijarKameParaTest(null);
    const c = buscar("contenido");
    expect(c.abierto).toBe(false);
    expect(c.detalle).toContain("sin verificar");
  });

  it("verificado como caído, se lo dice y le pide que NO lo use", async () => {
    const { fijarKameParaTest } = await import("../caminos.js");
    fijarKameParaTest(false);
    const c = buscar("contenido");
    expect(c.abierto).toBe(false);
    expect(c.detalle).toContain("Not Found");
    expect(c.detalle).toContain("NO lo uses");
  });

  it("verificado como vivo, recién ahí figura abierto", async () => {
    const { fijarKameParaTest } = await import("../caminos.js");
    fijarKameParaTest(true);
    expect(buscar("contenido").abierto).toBe(true);
  });
});
