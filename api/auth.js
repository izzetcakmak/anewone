// Sign-in: a signed SIWE message in, a day's session token out (api/_auth.js). The page calls
// this once after the wallet signs, and from then on sends the token instead of the
// signature. DELETE ends the session. Without Redis the answer carries no token and the page
// keeps the signature as its credential, exactly as before.
import { issueSession, endSession } from "./_auth.js";
import { tooMany } from "./_ratelimit.js";

const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ error: "this endpoint serves anewone.xyz" });
  if (req.method !== "POST" && req.method !== "DELETE") return res.status(405).json({ error: "POST or DELETE" });
  if (await tooMany(req, res, "auth", 10)) return;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); } }

  if (req.method === "DELETE") { await endSession(body?.auth); return res.status(200).json({ ok: true }); }
  try {
    const r = await issueSession(body?.auth);
    if (r.error) return res.status(401).json({ error: r.error });
    return res.status(200).json(r);
  } catch (e) {
    return res.status(502).json({ error: "session store: " + (e.message || e) });
  }
}
