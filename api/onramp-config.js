// Tells the page whether card purchases are switched on for this deployment (never reveals
// the key). Without ONRAMP_API_KEY the "Buy USDC with card" button is not rendered at all.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ enabled: !!process.env.ONRAMP_API_KEY, endpoint: "/api/onramp-session" });
}
