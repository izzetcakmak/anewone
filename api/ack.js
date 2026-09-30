// Records a wallet's signed acceptance of the Terms of Use and Privacy Notice, so the site
// can show it accepted them and when. The page (docs/earn/) has the wallet sign a fixed
// English text with personal_sign; this checks the signature really comes from that address
// and keeps address, version, signature, the text's hash and the time in Redis (api/_kv.js).
// GET ?address=0x… says whether an acceptance of the current version is on file.
// Without Redis the POST still verifies and answers ok, and the browser's own copy stands.
import { getAddress, verifyMessage, keccak256, toUtf8Bytes } from "ethers";
import { kv, kvAvailable } from "./_kv.js";
import { tooMany } from "./_ratelimit.js";

const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const key = (addr) => `ack:${addr.toLowerCase()}`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ error: "forbidden" });

  if (req.method === "GET") {
    if (await tooMany(req, res, "ack-get", 60)) return;
    let addr;
    try { addr = getAddress(String(req.query.address || "")); } catch { return res.status(400).json({ error: "bad address" }); }
    if (!kvAvailable()) return res.status(200).json({ accepted: null });
    try {
      const raw = await kv("GET", key(addr));
      const rec = raw ? JSON.parse(raw) : null;
      return res.status(200).json({ accepted: rec ? { version: rec.version, at: rec.at } : null });
    } catch { return res.status(200).json({ accepted: null }); }
  }

  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "method" }); }
  if (await tooMany(req, res, "ack-post", 10)) return;
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const { address, version, text, signature } = b;
  if ([address, version, text, signature].some((x) => typeof x !== "string")) return res.status(400).json({ error: "bad request" });
  if (!VERSION_RE.test(version) || text.length > 4000 || !text.startsWith("A NEW ONE (anewone.xyz) - Terms acknowledgment")) return res.status(400).json({ error: "bad text" });
  let addr;
  try { addr = getAddress(address); } catch { return res.status(400).json({ error: "bad address" }); }
  // the text must name the wallet it is signed by, and the version it accepts
  if (!text.includes(`Wallet: ${addr}`) && !text.toLowerCase().includes(`wallet: ${addr.toLowerCase()}`)) return res.status(400).json({ error: "text/wallet mismatch" });
  if (!text.includes(`version ${version}`)) return res.status(400).json({ error: "text/version mismatch" });
  let rec;
  try { rec = verifyMessage(text, signature); } catch { return res.status(400).json({ error: "bad signature" }); }
  if (rec.toLowerCase() !== addr.toLowerCase()) return res.status(400).json({ error: "signature is not from that wallet" });

  const record = { address: addr, version, signature, textHash: keccak256(toUtf8Bytes(text)), at: new Date().toISOString() };
  if (kvAvailable()) {
    try { await kv("SET", key(addr), JSON.stringify(record)); }
    catch { return res.status(200).json({ ok: true, stored: false }); }
    return res.status(200).json({ ok: true, stored: true, at: record.at });
  }
  return res.status(200).json({ ok: true, stored: false });
}
