// Kaizen-8B pidió `web_search` seis veces seguidas (2026-09-03) en vez de
// `web.search`. Cada una se rechazó con "Unknown tool" y su herramienta más
// útil quedó inalcanzable por un punto. Algunos parsers de tool-calling
// normalizan el separador, así que el nombre que llega no siempre es el
// publicado.

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../registry.js";
import { PermissionLevel } from "../../policy/limits.js";

function registro(): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of ["web.search", "wallet.getBalance", "commerce.discoverProducts"]) {
    r.register({
      def: { name, description: name, level: PermissionLevel.ZERO_COST,
             parameters: { type: "object", properties: {} } },
      exec: async () => ({ ok: true, name }),
      toIntent: () => ({ tool: name, level: PermissionLevel.ZERO_COST }),
    });
  }
  return r;
}

describe("resolución tolerante de nombres", () => {
  it("resuelve el caso real: web_search → web.search", () => {
    expect(registro().get("web_search")?.def.name).toBe("web.search");
  });

  it("el nombre exacto sigue funcionando y tiene prioridad", () => {
    expect(registro().get("web.search")?.def.name).toBe("web.search");
  });

  it("tolera guion medio y mayúsculas", () => {
    const r = registro();
    expect(r.get("web-search")?.def.name).toBe("web.search");
    expect(r.get("WEB_SEARCH")?.def.name).toBe("web.search");
    expect(r.get("wallet_getbalance")?.def.name).toBe("wallet.getBalance");
  });

  it("resuelve nombres largos en camelCase", () => {
    expect(registro().get("commerce_discoverProducts")?.def.name)
      .toBe("commerce.discoverProducts");
  });

  it("NO inventa una herramienta que no existe", () => {
    // Tolerar el separador no puede volverse adivinar: si pide algo que no
    // está, tiene que fallar para que lo registre como lección.
    for (const falsa of ["no_existe", "wallet.drain", "", "web", "search"]) {
      expect(registro().get(falsa), `resolvió "${falsa}"`).toBeUndefined();
    }
  });

  it("no confunde dos herramientas distintas entre sí", () => {
    const r = registro();
    expect(r.get("wallet_getBalance")?.def.name).toBe("wallet.getBalance");
    expect(r.get("web_search")?.def.name).toBe("web.search");
  });
});
