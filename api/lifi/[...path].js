// Vercel serverless proxy for LI.FI: adds the partner key from the LIFI_API_KEY env var so the
// key never ships to browsers, and forwards GET requests to https://li.quest/v1/<path>.
// Only the read-only endpoints the kit uses are allowed. With no key configured the proxy
// answers 503 and the demo falls back to calling li.quest directly (keyless limits apply).
//
// The key's quota is the thing to guard: like the RPC relay and the chat, this only answers
// pages on this site, and each IP gets a bounded number of quotes a minute. Neither is a
// security boundary (every answer here is public), both are cost ones.
import { tooMany } from "../_ratelimit.js";

const ALLOWED = new Set(["quote", "tokens", "status", "chains", "tools", "connections"]);
const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ message: "this proxy serves anewone.xyz" });
  if (ORIGINS.has(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method !== "GET") return res.status(405).json({ message: "GET only" });
  const key = process.env.LIFI_API_KEY;
  if (!key) return res.status(503).json({ message: "LIFI_API_KEY not configured" });
  // GangWay polls /status every few seconds while a bridge is in flight and re-quotes on
  // every amount change, so the ceiling is generous
  if (await tooMany(req, res, "lifi", 60)) return;
  // Vercel hands the catch-all segment over as query key "...path" (older runtimes: "path")
  const raw = req.query["...path"] ?? req.query.path ?? [];
  const parts = [].concat(raw).flatMap((x) => String(x).split("/")).filter(Boolean);
  if (parts.length !== 1 || !ALLOWED.has(parts[0])) return res.status(404).json({ message: "not proxied" });
  const url = new URL("https://li.quest/v1/" + parts[0]);
  for (const [k, v] of Object.entries(req.query)) if (k !== "path" && k !== "...path") url.searchParams.set(k, String(v));
  try {
    const r = await fetch(url, { headers: { "x-lifi-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const body = await r.text();
    res.status(r.status).setHeader("content-type", "application/json").send(body);
  } catch (e) {
    res.status(502).json({ message: "upstream error: " + (e && e.message) });
  }
}
