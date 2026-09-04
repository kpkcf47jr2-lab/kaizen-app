// La primera página que publicó salió sin una sola línea de CSS: fuente serif
// por defecto, viñetas, enlaces violetas. El dueño la vio y el diagnóstico fue
// inmediato — "eso es muy genérico, tiene que vender a los ojos".
//
// Pedirlo en la descripción no alcanza: se ignora. Esto lo rechaza.

import { describe, it, expect } from "vitest";
import { revisarCalidad } from "../commerce_web.js";

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const RELLENO = "<p>" + "contenido de producto. ".repeat(60) + "</p>";

describe("guarda de calidad de páginas", () => {
  it("RECHAZA la página real que publicó: sin CSS", () => {
    const p = revisarCalidad(`<!doctype html><html><head>${VIEWPORT}</head><body><h1>Bienvenido a Kaizen</h1>${RELLENO}</body></html>`);
    expect(p.some((x) => x.includes("CSS"))).toBe(true);
  });

  it("acepta una página con <style> embebido", () => {
    const p = revisarCalidad(`<!doctype html><html><head>${VIEWPORT}<style>body{font-family:system-ui;background:#0b0b0f;color:#eee}</style></head><body><h1>Tienda</h1>${RELLENO}</body></html>`);
    expect(p).toEqual([]);
  });

  it("acepta estilos en atributo o por hoja externa", () => {
    for (const est of ['<div style="color:red">x</div>', '<link rel="stylesheet" href="/a.css">']) {
      const p = revisarCalidad(`<!doctype html><head>${VIEWPORT}</head><body>${est}${RELLENO}`);
      expect(p, `rechazó ${est}`).toEqual([]);
    }
  });

  it("exige viewport — casi todos entran desde el teléfono", () => {
    const p = revisarCalidad(`<!doctype html><head><style>body{color:#111}</style></head><body>${RELLENO}`);
    expect(p.some((x) => x.includes("viewport"))).toBe(true);
  });

  it("rechaza páginas demasiado cortas para vender algo", () => {
    const p = revisarCalidad(`<!doctype html><head>${VIEWPORT}<style>b{color:red}</style></head><body><h1>Hola</h1>`);
    expect(p.some((x) => x.includes("corta"))).toBe(true);
  });

  it("el mensaje dice QUÉ hacer, no sólo que está mal", () => {
    const p = revisarCalidad("<html><body>x</body></html>");
    expect(p.join(" ")).toContain("Embebé un <style>");
  });
});
