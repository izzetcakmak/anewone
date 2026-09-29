// Tells the Stocks page whether Dinari is switched on for this deployment, and whether it is
// the sandbox (never reveals the key). Without DINARI_API_KEY_ID the page shows its notice
// and nothing else.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const enabled = !!(process.env.DINARI_API_KEY_ID && process.env.DINARI_API_SECRET_KEY);
  const env = process.env.DINARI_ENV === "production" ? "production" : "sandbox";
  res.status(200).json({ enabled, env, chain: process.env.DINARI_CHAIN || (env === "production" ? "eip155:42161" : "eip155:421614"), base: "/api/dinari" });
}
