// The Funds page's window onto USYC's price report: the public, keyless feed at
// usyc.hashnote.com (Hashnote, now Circle), which browsers cannot read directly because it sends
// no CORS headers. The page reads price, yield and the Arc supply from the chain itself; what
// only the report knows is the fund's global size. The function relays and caches, nothing more.
//
//   GET /api/usyc   { at, roundId, price, nextPrice, nav, supply, reportedAt }
//                   nav is the fund's balance in USD, supply the USYC in issue across chains;
//                   cached TTL seconds in Redis (api/_kv.js) and in the instance.
import { kv, kvAvailable } from "./_kv.js";
import { tooMany } from "./_ratelimit.js";

const SRC = "https://usyc.hashnote.com/api/price-reports";
const TTL = 900; // the report moves once per business day
const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);
let mem = null; // { until, value }

async function load() {
  const r = await fetch(SRC, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("hashnote " + r.status);
  const j = await r.json(), d = j && Array.isArray(j.data) ? j.data[0] : null;
  if (!d || !(Number(d.balance) > 0)) throw new Error("no report");
  return { at: Date.now(), roundId: Number(d.roundId), price: Number(d.price), nextPrice: Number(d.nextPrice),
    nav: Number(d.balance), supply: Number(d.totalSupply), reportedAt: Number(d.timestamp) * 1000 };
}

export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "method" }); }
  // Not a security boundary, a cost one: the relay is for this site's pages.
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ error: "forbidden" });
  if (await tooMany(req, res, "usyc", 60)) return;
  try {
    let v = mem && mem.until > Date.now() ? mem.value : null;
    if (!v && kvAvailable()) { try { const raw = await kv("GET", "usyc:report"); if (raw) v = JSON.parse(raw); } catch {} }
    if (!v) {
      v = await load();
      if (kvAvailable()) { try { await kv("SET", "usyc:report", JSON.stringify(v), "EX", TTL); } catch {} }
    }
    mem = { until: Date.now() + Math.min(TTL, 60) * 1000, value: v };
    res.setHeader("Cache-Control", `public, max-age=${TTL}`);
    return res.status(200).json(v);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "issuer data unavailable", detail: String(e && e.message || e).slice(0, 200) });
  }
}
