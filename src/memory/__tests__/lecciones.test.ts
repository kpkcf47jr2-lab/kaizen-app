// Memoria de largo plazo: lo que la agente APRENDIÓ, no lo que hizo.
//
// El aislamiento entre agentes es un requisito del dueño, no un detalle:
// cada usuario tiene su propia agente y sus lecciones NUNCA pueden cruzarse.
// Un cruce filtraría a un usuario lo que otro descubrió — y con ello sus
// montos, sus rutas y su estrategia.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../store.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaizen-lecciones-"));
  process.env.KAIZEN_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.KAIZEN_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const conMemoria = <T>(agentId: string, fn: (m: MemoryStore) => T): T => {
  const m = new MemoryStore(agentId);
  try { return fn(m); } finally { m.close(); }
};

describe("lecciones — memoria de largo plazo", () => {
  it("guarda una lección y la devuelve", () => {
    conMemoria("agt_uno", (m) => {
      m.aprender({ scope: "ruta", clave: "base:weth", leccion: "El gas en Base es barato" });
      const l = m.lecciones();
      expect(l).toHaveLength(1);
      expect(l[0].leccion).toBe("El gas en Base es barato");
      expect(l[0].veces).toBe(1);
    });
  });

  it("la MISMA lección no se duplica: suma confirmaciones y acumula costo", () => {
    conMemoria("agt_uno", (m) => {
      m.aprender({ scope: "herramienta", clave: "falla:swap", leccion: "swap falló", costoUsd: 0.02 });
      m.aprender({ scope: "herramienta", clave: "falla:swap", leccion: "swap falló", costoUsd: 0.03 });
      m.aprender({ scope: "herramienta", clave: "falla:swap", leccion: "swap falló otra vez", costoUsd: 0.05 });

      const l = m.lecciones();
      expect(l).toHaveLength(1);
      expect(l[0].veces).toBe(3);
      expect(l[0].costoUsd).toBeCloseTo(0.10, 6);
      // El texto se actualiza al más reciente.
      expect(l[0].leccion).toBe("swap falló otra vez");
    });
  });

  it("misma clave en distinto scope son lecciones distintas", () => {
    conMemoria("agt_uno", (m) => {
      m.aprender({ scope: "ruta", clave: "x", leccion: "sobre la ruta" });
      m.aprender({ scope: "tactica", clave: "x", leccion: "sobre la táctica" });
      expect(m.contarLecciones()).toBe(2);
    });
  });

  it("las más confirmadas van primero — es lo que más respaldo tiene", () => {
    conMemoria("agt_uno", (m) => {
      m.aprender({ scope: "a", clave: "floja", leccion: "vista una vez" });
      for (let i = 0; i < 4; i++) {
        m.aprender({ scope: "a", clave: "firme", leccion: "vista cuatro veces" });
      }
      const l = m.lecciones();
      expect(l[0].clave).toBe("firme");
      expect(l[0].veces).toBe(4);
    });
  });

  it("marca los callejones sin salida para no reintentarlos", () => {
    conMemoria("agt_uno", (m) => {
      m.aprender({ scope: "ruta", clave: "mala", leccion: "no rinde", util: false });
      expect(m.lecciones()[0].util).toBe(0);
    });
  });

  it("respeta el límite pedido", () => {
    conMemoria("agt_uno", (m) => {
      for (let i = 0; i < 30; i++) {
        m.aprender({ scope: "a", clave: `k${i}`, leccion: `lección ${i}` });
      }
      expect(m.lecciones(5)).toHaveLength(5);
      expect(m.contarLecciones()).toBe(30);
    });
  });

  it("AISLAMIENTO: las lecciones de una agente no llegan a otra", () => {
    conMemoria("agt_usuario_a", (m) => {
      m.aprender({
        scope: "ruta", clave: "secreta",
        leccion: "La ruta X con $500 rinde 3%",
        evidencia: "0xdeadbeef",
      });
    });

    conMemoria("agt_usuario_b", (m) => {
      expect(m.contarLecciones()).toBe(0);
      expect(m.lecciones()).toEqual([]);
    });

    // Y la de A sigue intacta: aislar no es borrar.
    conMemoria("agt_usuario_a", (m) => {
      expect(m.contarLecciones()).toBe(1);
      expect(m.lecciones()[0].leccion).toContain("rinde 3%");
    });
  });

  it("AISLAMIENTO: cada agente tiene su propio archivo en disco", () => {
    conMemoria("agt_usuario_a", (m) => m.aprender({ scope: "a", clave: "k", leccion: "x" }));
    conMemoria("agt_usuario_b", (m) => m.aprender({ scope: "a", clave: "k", leccion: "y" }));

    const archivos = fs.readdirSync(path.join(dir, "memory")).filter((f) => f.endsWith(".sqlite"));
    expect(archivos).toContain("agt_usuario_a.sqlite");
    expect(archivos).toContain("agt_usuario_b.sqlite");

    // Misma clave, contenido distinto: no se pisaron.
    conMemoria("agt_usuario_a", (m) => expect(m.lecciones()[0].leccion).toBe("x"));
    conMemoria("agt_usuario_b", (m) => expect(m.lecciones()[0].leccion).toBe("y"));
  });

  it("la memoria sobrevive al cierre: sirve para sesiones futuras", () => {
    conMemoria("agt_uno", (m) => m.aprender({ scope: "ruta", clave: "k", leccion: "persistente" }));
    // Nueva instancia = nueva sesión.
    conMemoria("agt_uno", (m) => {
      expect(m.contarLecciones()).toBe(1);
      expect(m.lecciones()[0].leccion).toBe("persistente");
    });
  });
});
