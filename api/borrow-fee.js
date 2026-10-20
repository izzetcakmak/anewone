// Borrow Kit's two fee-bearing calls, forwarded to Circle with the site's API key. Circle charges
// a loan the integrator fee configured for the key that asks (15 bps to the admin wallet, set on
// 30 Sep 2026); the kit only sends a key it holds, and the page runs keyless in the browser, so
// until 20 Oct 2026 Morpho loans carried no fee at all. The page now points just these two calls
// here (config.baseUrl, the kit's own per-request override); vercel.json rewrites the kit's paths:
//
//   POST /v1/borrowKit/loans/borrow/quote  ->  /api/borrow-fee?op=quote
//   POST /v1/borrowKit/loans/borrow        ->  /api/borrow-fee?op=execute
//
// Nothing else of Circle's API is reachable through it: market and loan reads, repay, collateral
// and close go from the browser straight to Circle, keyless, as before. The key never leaves this
// function, the body is rebuilt from the fields these two routes take, and without a key the call
// is forwarded keyless, so borrowing still works, just without the fee.
import { tooMany } from "./_ratelimit.js";

const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);
const CIRCLE = "https://api.circle.com";
const ROUTES = { quote: "/v1/borrowKit/loans/borrow/quote", execute: "/v1/borrowKit/loans/borrow" };
const FIELDS = ["walletAddress", "chain", "marketId", "loanId", "amount", "slippageBps", "idempotencyKey"];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ code: 403, message: "this endpoint serves anewone.xyz" });
  if (req.method !== "POST") return res.status(405).json({ code: 405, message: "POST only" });
  const path = ROUTES[req.query?.op];
  if (!path) return res.status(404).json({ code: 404, message: "unknown route" });
  // a quote per keystroke pause and a retry or two: generous for a person, a wall for a script
  if (await tooMany(req, res, "borrow-fee", 60)) return;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ code: 400, message: "bad json" }); } }
  if (!body || typeof body !== "object") return res.status(400).json({ code: 400, message: "bad body" });
  const clean = {};
  for (const k of FIELDS) {
    const v = body[k];
    if (v === undefined) continue;
    if ((typeof v !== "string" && typeof v !== "number") || String(v).length > 200) return res.status(400).json({ code: 400, message: `bad ${k}` });
    clean[k] = v;
  }

  const key = process.env.CIRCLE_BORROW_API_KEY || process.env.ONRAMP_API_KEY;
  try {
    const r = await fetch(CIRCLE + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(clean),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await r.text();
    res.setHeader("content-type", r.headers.get("content-type") || "application/json");
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(504).json({ code: 504, message: "Borrow Service did not answer: " + String(e?.message || e).slice(0, 120) });
  }
}
