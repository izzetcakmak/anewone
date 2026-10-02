// The Stocks page's window onto xStocks (Backed Assets (JE) Ltd, a Kraken company): the public,
// keyless half of Backed's API, which browsers cannot call directly because it sends no CORS
// headers. Nothing here is signed or private; the function only relays and caches.
//
//   GET /api/xstocks                 the catalog: every xStock with its logo, underlying, trading
//                                    hours, the EVM address (one address on every EVM chain) and
//                                    its Arc deployment if Backed has published one. Cached
//                                    CATALOG_TTL seconds in Redis (api/_kv.js) and in the instance.
//   GET /api/xstocks?prices=TSLAx,NVDAx   {TSLAx: 357.6, ...} for up to MAX_PRICES symbols,
//                                    each cached PRICE_TTL seconds.
//   GET /api/xstocks?por=TSLAx       proof of reserves for one symbol, cached POR_TTL seconds.
//
// Backed allows about 1000 calls per window per caller; the caches keep this far below that
// however many visitors the page has. Without Redis the instance cache alone carries on.
import { kv, kvAvailable } from "./_kv.js";
import { tooMany } from "./_ratelimit.js";

const BASE = "https://api.backed.fi/api/v2/public";
const CATALOG_TTL = 600, PRICE_TTL = 45, POR_TTL = 300;
const MAX_PRICES = 60;
const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);
const SYM_RE = /^[A-Za-z0-9.]{1,12}$/;

const mem = new Map(); // key -> { until, value }
function memGet(k) { const e = mem.get(k); if (e && e.until > Date.now()) return e.value; mem.delete(k); return undefined; }
function memSet(k, v, ttl) { if (mem.size > 500) mem.clear(); mem.set(k, { until: Date.now() + ttl * 1000, value: v }); }

async function cached(key, ttl, load) {
  const m = memGet(key);
  if (m !== undefined) return m;
  if (kvAvailable()) {
    try { const raw = await kv("GET", key); if (raw) { const v = JSON.parse(raw); memSet(key, v, Math.min(ttl, 60)); return v; } } catch {}
  }
  const v = await load();
  memSet(key, v, ttl);
  if (kvAvailable()) { try { await kv("SET", key, JSON.stringify(v), "EX", ttl); } catch {} }
  return v;
}

async function backed(path) {
  const r = await fetch(BASE + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("backed " + r.status);
  return r.json();
}

/** One page of the catalog, compact. */
function compact(a) {
  const evms = (a.deployments || []).filter((d) => /^0x[0-9a-fA-F]{40}$/.test(d.address || ""));
  const evm = evms[0], wrapped = evms.find((d) => d.wrapperAddressV2); // the same address on every EVM chain
  const arc = (a.deployments || []).find((d) => /^arc$/i.test(d.network || ""));
  const t = a.trading || {};
  return {
    s: a.symbol, n: String(a.name || "").replace(/\s*xStock$/i, ""), u: a.underlyingSymbol || null,
    x: a.underlying && a.underlying.exchange ? a.underlying.exchange.abbreviation || null : null,
    logo: !!a.logo, halted: !!a.isTradingHalted,
    period: t.currentPeriod || null, open: t.openNow == null ? null : !!t.openNow, next: t.nextChangeAt || null,
    addr: evm ? evm.address.toLowerCase() : null, wrap: wrapped ? wrapped.wrapperAddressV2.toLowerCase() : null,
    nc: (a.deployments || []).length,
    arc: arc ? { addr: (arc.address || "").toLowerCase(), wrap: (arc.wrapperAddressV2 || "").toLowerCase() || null, atomic: !!arc.supportsAtomicSwaps } : null,
  };
}

/** The whole catalog: Backed pages it 100 at a time, so pages are fetched six at a time until
 *  one says there is no next page; sequentially it took 20 seconds, longer than a function may run. */
async function loadCatalog() {
  const out = [];
  for (let first = 1; first <= 31; first += 6) {
    const pages = await Promise.all(Array.from({ length: 6 }, (_, i) => backed(`/assets?pageSize=100&page=${first + i}`).catch(() => null)));
    let done = false;
    for (const j of pages) {
      if (!j) { done = true; break; }
      for (const a of j.nodes || []) out.push(compact(a));
      if (!j.page || !j.page.hasNextPage) { done = true; break; }
    }
    if (done) break;
  }
  if (out.length < 100) throw new Error("catalog came back short");
  return { at: Date.now(), count: out.length, assets: out };
}

/** The catalog, or the last good one when Backed does not answer: a stocks page with no
 *  catalog is worse than one a few minutes old. */
async function catalog() {
  try {
    const c = await cached("xs:catalog:v2", CATALOG_TTL, loadCatalog);
    if (kvAvailable()) { try { await kv("SET", "xs:catalog:last", JSON.stringify(c)); } catch {} }
    return c;
  } catch (e) {
    const m = memGet("xs:catalog:last"); if (m) return { ...m, stale: true };
    if (kvAvailable()) { try { const raw = await kv("GET", "xs:catalog:last"); if (raw) { const v = JSON.parse(raw); memSet("xs:catalog:last", v, 60); return { ...v, stale: true }; } } catch {} }
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "method" }); }
  // Not a security boundary, a cost one: the relay is for this site's pages.
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ error: "forbidden" });
  if (await tooMany(req, res, "xstocks", 120)) return;

  try {
    if (typeof req.query.prices === "string") {
      const syms = [...new Set(req.query.prices.split(",").map((s) => s.trim()).filter((s) => SYM_RE.test(s)))].slice(0, MAX_PRICES);
      const pairs = await Promise.all(syms.map(async (s) => {
        try { const v = await cached("xs:px:" + s, PRICE_TTL, async () => { const j = await backed(`/assets/${encodeURIComponent(s)}/price-data`); return j && typeof j.quote === "number" ? j.quote : null; }); return [s, v]; }
        catch { return [s, null]; }
      }));
      res.setHeader("Cache-Control", `public, max-age=${PRICE_TTL}`);
      return res.status(200).json({ at: Date.now(), prices: Object.fromEntries(pairs) });
    }
    if (typeof req.query.por === "string") {
      const s = req.query.por.trim();
      if (!SYM_RE.test(s)) return res.status(400).json({ error: "bad symbol" });
      const j = await cached("xs:por:" + s, POR_TTL, () => backed(`/proof-of-reserves/${encodeURIComponent(s)}`));
      res.setHeader("Cache-Control", `public, max-age=${POR_TTL}`);
      return res.status(200).json(j);
    }
    const c = await catalog();
    res.setHeader("Cache-Control", `public, max-age=${CATALOG_TTL}`);
    return res.status(200).json(c);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "issuer data unavailable", detail: String(e && e.message || e).slice(0, 200) });
  }
}
