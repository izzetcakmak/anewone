// /api/basedbot — the free index API, see api/_basedbot.js.
//
// /api/agent is the same function: vercel.json rewrites /api/agent/* here with ?door=agent, and
// that door serves the same answers behind the x402 paywall of api/_x402.js (one function, not
// three: the Hobby plan allows twelve a deployment and this project is near it).
import { serve } from "./_basedbot.js";
import { paywall, paymentInfo } from "./_x402.js";

export default async function handler(req, res) {
  try {
    // The door is read two ways because Vercel hands the two functions different URLs. The
    // plain function (the root document) gets the rewritten query, ?door=agent. The catch-all
    // gets the rewritten path with the caller's own query and nothing the rewrite added to the
    // query, so there the door rides in the path segment itself: /api/basedbot/agent-tokens.
    const u = new URL(req.url || "/", "https://anewone.xyz");
    const agent = u.searchParams.get("door") === "agent" || /^\/api\/(agent(\/|$)|basedbot\/agent-)/.test(u.pathname);
    return await serve(req, res, agent ? { prefix: "agent", paywall, payment: paymentInfo } : {});
  } catch (e) {
    // a bug or a malformed index, never the caller's doing: the details go to the function log,
    // the caller gets a plain 500 that no cache keeps
    console.error("basedbot:", e);
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "internal error" });
  }
}
