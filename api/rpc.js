// Same-origin JSON-RPC relay for Arc mainnet reads.
//
// Brave Shields blocks every request to *.arc.io by default (the domain sits on its filter lists
// from an old ad network of the same name), and every public Arc mainnet RPC lives there. In
// Brave the floor could not read the chain at all: no prices, no trades, "RPC busy" forever.
// A request to the site's own origin is not blocked, so the pages keep this relay as the last
// entry of their RPC pools; other browsers reach the public endpoints directly and never get
// this far.
//
// Reads, plus the broadcast of an already-signed transaction: the Google sign-in wallet
// (Web3Auth) signs in the page and sends over the RPC it is given, and in Brave that has to be
// this relay too, or every trade from it dies at the blocked *.arc.io host. Relaying a raw
// transaction gives nobody anything they could not do against any public RPC; nothing here
// signs. (25 Sep 2026)
const UPSTREAMS = [
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://rpc.mainnet.arc.io",
  "https://rpc.quicknode.mainnet.arc.io",
];
const ALLOWED = new Set([
  "eth_chainId", "net_version", "eth_blockNumber", "eth_call", "eth_getLogs", "eth_getBalance",
  "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount", "eth_getTransactionReceipt",
  "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_gasPrice",
  "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_estimateGas", "eth_sendRawTransaction",
]);
const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);
const MAX_BATCH = 20;

const bad = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json(bad(null, -32600, "POST only"));
  // Not a security boundary (every read here is public), a cost one: the relay is for this
  // site's pages, not a free RPC for anyone who finds the URL.
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/"));
  if (!fromSite) return res.status(403).json(bad(null, -32600, "this relay serves anewone.xyz"));

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json(bad(null, -32700, "parse error")); } }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return res.status(400).json(bad(null, -32600, "empty or oversized batch"));
  for (const c of calls) {
    if (!c || c.jsonrpc !== "2.0" || typeof c.method !== "string") return res.status(400).json(bad(c && c.id, -32600, "invalid request"));
    if (!ALLOWED.has(c.method)) return res.status(400).json(bad(c.id, -32601, "method not relayed: " + c.method));
  }

  const payload = JSON.stringify(body);
  let last = null;
  for (const url of UPSTREAMS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(8000) });
      const text = await r.text();
      // a throttled or broken upstream is skipped; a JSON-RPC answer (errors included) is final
      if (r.status === 429 || r.status >= 500 || !text.trim().startsWith("{") && !text.trim().startsWith("[")) { last = r.status + " " + text.slice(0, 80); continue; }
      return res.status(200).setHeader("content-type", "application/json").send(text);
    } catch (e) { last = String((e && e.message) || e); }
  }
  return res.status(502).json(bad(calls[0] && calls[0].id, -32603, "no upstream answered: " + last));
}
