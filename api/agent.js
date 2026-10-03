// /api/agent — the index API of api/_basedbot.js behind the x402 paywall of api/_x402.js: the
// same answers as /api/basedbot, priced per call in USDC for agents that pay as they go. The
// document at the root is free and says what each endpoint costs; until X402_PAY_TO is set the
// priced endpoints answer 503 and point at the free index.
import { serve } from "./_basedbot.js";
import { paywall, paymentInfo } from "./_x402.js";

export default async function handler(req, res) {
  try {
    return await serve(req, res, { prefix: "agent", paywall, payment: paymentInfo });
  } catch (e) {
    console.error("agent:", e);
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "internal error" });
  }
}
