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
//
// What it will not do: answer more than RATE requests a minute per IP, carry a body over
// MAX_BODY bytes or a batch over MAX_BATCH calls, or fetch logs across more than MAX_LOG_RANGE
// blocks in one call, which is where an upstream's quota would go first. The pages never ask
// for more than that; the relay is for them, not a free RPC for anyone who finds the URL.
import { tooMany } from "./_ratelimit.js";

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
const MAX_BODY = 64 * 1024;
const MAX_LOG_RANGE = 10_000; // what the public endpoints themselves accept per call
const RATE = 240; // per IP per minute; a Brave tab on the floor needs about 30

const bad = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** A getLogs call is bounded: a single block by hash, or a numeric range of MAX_LOG_RANGE or less. */
function logsCallOk(c) {
  const f = Array.isArray(c.params) ? c.params[0] : null;
  if (!f || typeof f !== "object") return false;
  if (typeof f.blockHash === "string") return true;
  const num = (x) => (typeof x === "string" && /^0x[0-9a-f]+$/i.test(x) ? Number.parseInt(x, 16) : NaN);
  const from = num(f.fromBlock), to = num(f.toBlock);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from < MAX_LOG_RANGE;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json(bad(null, -32600, "POST only"));
  // Not a security boundary (every read here is public), a cost one: the relay is for this
  // site's pages, not a free RPC for anyone who finds the URL.
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/"));
  if (!fromSite) return res.status(403).json(bad(null, -32600, "this relay serves anewone.xyz"));
  if (await tooMany(req, res, "rpc", RATE)) return;

  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY) return res.status(413).json(bad(null, -32600, "request too large"));
    try { body = JSON.parse(body); } catch { return res.status(400).json(bad(null, -32700, "parse error")); }
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return res.status(400).json(bad(null, -32600, "empty or oversized batch"));
  for (const c of calls) {
    if (!c || c.jsonrpc !== "2.0" || typeof c.method !== "string") return res.status(400).json(bad(c && c.id, -32600, "invalid request"));
    if (!ALLOWED.has(c.method)) return res.status(400).json(bad(c.id, -32601, "method not relayed: " + c.method));
    if (c.method === "eth_getLogs" && !logsCallOk(c)) return res.status(400).json(bad(c.id, -32602, `eth_getLogs: give a numeric range under ${MAX_LOG_RANGE} blocks, or a blockHash`));
  }

  const payload = JSON.stringify(body);
  if (payload.length > MAX_BODY) return res.status(413).json(bad(null, -32600, "request too large"));
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
