// Tells the demo whether the keyed LI.FI proxy is available (never reveals the key).
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ proxied: !!process.env.LIFI_API_KEY, base: "/api/lifi" });
}
