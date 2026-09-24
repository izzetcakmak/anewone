// Mints a short-lived Circle Onramp session so a visitor can buy USDC with a card, Apple Pay
// or Google Pay straight into their Arc wallet. The long-lived ONRAMP_API_KEY never leaves
// this function; the browser only ever sees the per-user sessionToken / widgetUrl.
//
// The destination address is not taken from the request body on trust: the caller must
// present the same wallet signature the Deck Hand chat uses (api/_auth.js), and the session
// is minted for the address that signature recovers to. Nobody can point someone else's
// purchase at a wallet they do not control.
//
// The widget is pinned to USDC on Arc. referrerDomain is a server-side construction option
// on purpose: it widens the payment provider's frame-ancestor allowlist, so it comes from
// our own env (ONRAMP_REFERRER_DOMAIN = anewone.xyz) and never from the client.
import { createOnrampServerKit, KitError } from "@circle-fin/onramp-kit/server";
import { verifyAuth } from "./_auth.js";

const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);
const CHAIN = process.env.ONRAMP_CHAIN || "arc"; // 'arc-testnet' on a testnet deployment

let kit = null;
function server() {
  if (kit) return kit;
  const apiKey = process.env.ONRAMP_API_KEY;
  if (!apiKey) return null;
  kit = createOnrampServerKit({
    apiKey,
    referrerDomain: process.env.ONRAMP_REFERRER_DOMAIN || undefined,
    requestTimeoutMs: 15_000,
  });
  return kit;
}

// ---- rate limit: per IP, per warm lambda. A cost guard, not a security boundary.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter((t) => now - t < 60_000);
  recent.push(now); hits.set(ip, recent);
  return recent.length > 10;
}

const statusFor = (type) =>
  type === "INPUT" ? 400 : type === "RATE_LIMIT" ? 429 : type === "NETWORK" ? 504 :
  type === "SERVICE" || type === "RPC" ? 502 : 500;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ error: "this endpoint serves anewone.xyz" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const s = server();
  if (!s) return res.status(503).json({ error: "card purchases are not enabled on this deployment" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
  if (limited(ip)) return res.status(429).json({ error: "slow down a little" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); } }
  const address = verifyAuth(body?.auth);
  if (!address) return res.status(401).json({ error: "sign in with the wallet first" });

  try {
    const session = await s.createSession({
      appUserId: address.toLowerCase(),
      destinationAddress: address,
      assets: { pairs: [{ token: "USDC", chain: CHAIN }] },
      metadata: { site: "anewone.xyz" },
    });
    // Only what the client kit needs to mount the widget.
    const { sessionId, sessionToken, widgetUrl, expiresAt } = session;
    return res.status(200).json({ sessionId, sessionToken, widgetUrl, expiresAt, destinationAddress: address });
  } catch (e) {
    if (e instanceof KitError) {
      // a rejected key is our misconfiguration, not the visitor's input
      if (e.name === "INPUT_INVALID_API_KEY") return res.status(503).json({ error: "card purchases are misconfigured on this deployment (ONRAMP_API_KEY rejected by Circle)" });
      return res.status(statusFor(e.type)).json({ error: e.message, type: e.type, recoverability: e.recoverability });
    }
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
