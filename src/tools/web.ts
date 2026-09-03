// ═══════════════════════════════════════════════════════════════════════
//  Kaizen — web tools (Path A.1)
//
//  Kaizen navigates the internet freely. Three tools:
//    · web.search — Serper.dev adapter (Brave + Google alt), mock fallback
//    · web.fetch  — plain fetch with sensible defaults + text/HTML/JSON parsing
//    · web.scrape — cheerio-powered structured extraction
//
//  Design constraints:
//    · Refuse localhost / private IPs → prevents SSRF
//    · Read-only — never POST/PUT/DELETE to external endpoints (that's
//      what shopify.*, ads.*, etc are for — dedicated + policy-checked)
//    · Timeouts capped at 30s
//    · Response size capped at 5 MB (defensive)
// ═══════════════════════════════════════════════════════════════════════

import { PermissionLevel } from "../policy/limits.js";
import type { RegisteredTool, ToolFn } from "./registry.js";
import * as cheerio from "cheerio";

// ── Safety helpers ───────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function isSafeUrl(url: string): { ok: true; parsed: URL } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: `invalid URL: ${url}` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase();
  // SSRF guard — refuse loopback + private ranges + link-local.
  const privatePrefixes = ["10.", "192.168.", "169.254.", "127.", "0."];
  if (host === "localhost" || host === "::1" || privatePrefixes.some((p) => host.startsWith(p))
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: `refusing internal/loopback host ${host}` };
  }
  return { ok: true, parsed: u };
}

async function boundedFetch(url: string, init?: RequestInit): Promise<{ status: number; contentType: string; text: string; url: string }> {
  const safe = isSafeUrl(url);
  if (!safe.ok) throw new Error(safe.reason);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // Realistic UA — anti-bot defenses reject the default node UA.
        "User-Agent": "Mozilla/5.0 (compatible; Kaizen/0.1; +https://kaizen-777.com)",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        ...(init?.headers as Record<string, string> ?? {}),
      },
      ...init,
    });
    // Read a bounded amount so a hostile server can't OOM us.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_BYTES) {
            void reader.cancel();
            throw new Error(`response body exceeded ${MAX_BYTES} bytes`);
          }
          chunks.push(value);
        }
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    const text = new TextDecoder("utf-8").decode(buf);
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, url: res.url };
  } finally { clearTimeout(timer); }
}

// ── web.search ───────────────────────────────────────────────────────

export interface SearchArgs {
  query: string;
  numResults?: number;
}
export interface SearchResult {
  ok: boolean;
  /** "sin-configurar" reemplazó a "mock": antes se devolvían resultados
   *  inventados como si fueran reales. Ahora falta de credencial es un
   *  fallo explícito, no una ficción con ok:true. */
  provider: "serper" | "sin-configurar";
  query: string;
  results: Array<{ title: string; link: string; snippet: string; position?: number }>;
  error?: string;
}

export function makeWebSearchTool(): RegisteredTool<SearchArgs, SearchResult> {
  const exec: ToolFn<SearchArgs, SearchResult> = async (args) => {
    const q = String(args.query ?? "").trim();
    if (!q) return { ok: false, provider: "sin-configurar", query: q, results: [], error: "empty query" };
    const num = Math.max(1, Math.min(20, Number(args.numResults ?? 10)));
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      // Antes esto devolvía ok:true con un resultado inventado que apuntaba
      // a example.com. Medido el 2026-09-03: la agente buscó "best affiliate
      // programs for AI tools high commission 2026" —una consulta buena— y
      // recibió esa ficción como si fuera información real.
      //
      // Devolver ok:false es mejor por dos razones: no puede construir un
      // plan sobre datos que no existen, y el destilador de lecciones marca
      // la herramienta como callejón sin salida, así que deja de gastar
      // pasos reintentándola en cada ciclo.
      return {
        ok: false,
        provider: "sin-configurar",
        query: q,
        error:
          "web.search no tiene credencial (falta SERPER_API_KEY), así que no " +
          "puedo buscar en la web. NO reintentes esta herramienta en este " +
          "ciclo: va a fallar igual hasta que el dueño configure la clave. " +
          "Buscá otro camino con las herramientas que sí funcionan.",
        results: [],
      };
    }
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num }),
      });
      if (!res.ok) return { ok: false, provider: "serper", query: q, results: [], error: `Serper HTTP ${res.status}` };
      const data = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string; position?: number }> };
      const results = (data.organic ?? []).slice(0, num).map((r) => ({
        title: r.title ?? "", link: r.link ?? "", snippet: r.snippet ?? "", position: r.position,
      }));
      return { ok: true, provider: "serper", query: q, results };
    } catch (e) {
      return { ok: false, provider: "serper", query: q, results: [], error: (e as Error).message };
    }
  };
  return {
    def: {
      name: "web.search",
      description:
        "Search Google (via Serper.dev) for a query and get the top organic results. " +
        "Read-only, ~1 cent per call when SERPER_API_KEY is set. Falls back to mock results if " +
        "no key — Kaizen can still call the tool safely to test its own logic.",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query (natural language)." },
          numResults: { type: "number", description: "How many results to return (1-20, default 10)." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "web.search", level: PermissionLevel.ZERO_COST }),
  };
}

// ── web.fetch ────────────────────────────────────────────────────────

export interface FetchArgs {
  url: string;
  as?: "text" | "html" | "json";
}
export interface FetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  finalUrl: string;
  body: string | Record<string, unknown> | null;
  error?: string;
}

export function makeWebFetchTool(): RegisteredTool<FetchArgs, FetchResult> {
  const exec: ToolFn<FetchArgs, FetchResult> = async (args) => {
    try {
      const r = await boundedFetch(args.url);
      const as = args.as ?? (r.contentType.includes("json") ? "json" : "text");
      let body: FetchResult["body"] = r.text;
      if (as === "json") {
        try { body = JSON.parse(r.text) as Record<string, unknown>; }
        catch (e) { return { ok: false, status: r.status, contentType: r.contentType, finalUrl: r.url, body: r.text, error: `JSON parse failed: ${(e as Error).message}` }; }
      } else if (as === "html") {
        // Return the raw HTML — cheerio parses on-demand in web.scrape.
        body = r.text;
      }
      return { ok: r.status < 400, status: r.status, contentType: r.contentType, finalUrl: r.url, body };
    } catch (e) {
      return { ok: false, status: 0, contentType: "", finalUrl: args.url, body: null, error: (e as Error).message };
    }
  };
  return {
    def: {
      name: "web.fetch",
      description:
        "Fetch a public URL and return its body. Read-only (never POSTs / DELETEs). Refuses " +
        "loopback + private IPs (SSRF guard). Body capped at 5 MB. Returns {status, contentType, body}. " +
        "Set `as` = 'json' | 'html' | 'text' (default: auto based on content-type).",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "Public https:// or http:// URL." },
          as:  { type: "string", enum: ["text", "html", "json"], description: "Return format." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "web.fetch", level: PermissionLevel.ZERO_COST }),
  };
}

// ── web.scrape ───────────────────────────────────────────────────────

export interface ScrapeArgs {
  url: string;
  /** cheerio selector → what to extract. Values are the selectors + attr.
   *  e.g. { title: "h1", price: ".product-price::text", href: "a.buy::attr(href)" } */
  schema: Record<string, string>;
  /** If set, extract from every match; return an array under the field. */
  eachSelector?: string;
}
export interface ScrapeResult {
  ok: boolean;
  url: string;
  extracted: Record<string, unknown>;
  error?: string;
}

export function makeWebScrapeTool(): RegisteredTool<ScrapeArgs, ScrapeResult> {
  const exec: ToolFn<ScrapeArgs, ScrapeResult> = async (args) => {
    try {
      const r = await boundedFetch(args.url);
      if (r.status >= 400) return { ok: false, url: args.url, extracted: {}, error: `HTTP ${r.status}` };
      const $ = cheerio.load(r.text);

      // Cheerio's generic types are notoriously fiddly. Cast to a
      // narrow shape describing only the methods we actually use so
      // the extract helper stays type-safe at the call site.
      type Selectable = { find(sel: string): { first(): { text(): string; attr(a: string): string | undefined } } };
      const searchScope = (root: unknown, sel: string): { text(): string; attr(a: string): string | undefined } => {
        if (root) return (root as Selectable).find(sel).first();
        return $(sel).first() as unknown as { text(): string; attr(a: string): string | undefined };
      };

      const extractOne = (root: unknown, schema: Record<string, string>) => {
        const out: Record<string, string> = {};
        for (const [field, selectorRaw] of Object.entries(schema)) {
          const attrMatch = selectorRaw.match(/^(.+)::attr\(([^)]+)\)$/);
          const textMatch = selectorRaw.match(/^(.+)::text$/);
          let sel = selectorRaw; let mode: "text" | "attr" = "text"; let attr = "";
          if (attrMatch) { sel = attrMatch[1]!; mode = "attr"; attr = attrMatch[2]!; }
          else if (textMatch) { sel = textMatch[1]!; mode = "text"; }
          const node = searchScope(root, sel);
          out[field] = mode === "attr"
            ? String(node.attr(attr) ?? "").trim()
            : String(node.text() ?? "").trim();
        }
        return out;
      };

      let extracted: Record<string, unknown>;
      if (args.eachSelector) {
        const items: Record<string, string>[] = [];
        $(args.eachSelector).each((_i, el) => {
          items.push(extractOne($(el), args.schema));
        });
        extracted = { items };
      } else {
        extracted = extractOne(undefined, args.schema);
      }
      return { ok: true, url: r.url, extracted };
    } catch (e) {
      return { ok: false, url: args.url, extracted: {}, error: (e as Error).message };
    }
  };
  return {
    def: {
      name: "web.scrape",
      description:
        "Fetch a URL and extract structured data with cheerio selectors. " +
        "`schema` is {field: 'cssSelector'} where selector supports " +
        "'sel::text' (default — text content) or 'sel::attr(name)'. " +
        "`eachSelector` iterates over multiple matches (e.g. products list).",
      level: PermissionLevel.ZERO_COST,
      parameters: {
        type: "object",
        required: ["url", "schema"],
        properties: {
          url: { type: "string" },
          schema: { type: "object", description: "field → css selector map" },
          eachSelector: { type: "string", description: "Optional — extract from every match of this selector." },
        },
      },
    },
    exec,
    toIntent: () => ({ tool: "web.scrape", level: PermissionLevel.ZERO_COST }),
  };
}
