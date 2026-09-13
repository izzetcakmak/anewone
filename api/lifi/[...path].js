// Vercel serverless proxy for LI.FI: adds the partner key from the LIFI_API_KEY env var so the
// key never ships to browsers, and forwards GET requests to https://li.quest/v1/<path>.
// Only the read-only endpoints the kit uses are allowed. With no key configured the proxy
// answers 503 and the demo falls back to calling li.quest directly (keyless limits apply).
const ALLOWED = new Set(["quote", "tokens", "status", "chains", "tools", "connections"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ message: "GET only" });
  const key = process.env.LIFI_API_KEY;
  if (!key) return res.status(503).json({ message: "LIFI_API_KEY not configured" });
  // Vercel hands the catch-all segment over as query key "...path" (older runtimes: "path")
  const raw = req.query["...path"] ?? req.query.path ?? [];
  const parts = [].concat(raw).flatMap((x) => String(x).split("/")).filter(Boolean);
  if (parts.length !== 1 || !ALLOWED.has(parts[0])) return res.status(404).json({ message: "not proxied" });
  const url = new URL("https://li.quest/v1/" + parts[0]);
  for (const [k, v] of Object.entries(req.query)) if (k !== "path" && k !== "...path") url.searchParams.set(k, String(v));
  try {
    const r = await fetch(url, { headers: { "x-lifi-api-key": key, accept: "application/json" } });
    const body = await r.text();
    res.status(r.status).setHeader("content-type", "application/json").send(body);
  } catch (e) {
    res.status(502).json({ message: "upstream error: " + (e && e.message) });
  }
}
