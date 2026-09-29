// Tokenized US stocks through Dinari, for the "Stocks" page. Dinari is the SEC-registered
// transfer agent and broker-dealer behind dShares; this function is the site's side of its
// partner API and nothing more: it turns a visitor's wallet into a Dinari customer, hands them
// Dinari's KYC page, links their wallet, and prepares the gasless "proxied" orders they sign in
// their own wallet. Dinari does the KYC, holds no key of ours in the browser, and settles the
// order on chain; the dShares land in the visitor's wallet, never in ours.
//
// The Dinari API key never leaves this function. Every account-bound route derives the Dinari
// account from the wallet the visitor proved with the site's sign-in (api/_auth.js): the entity
// for a wallet is the one whose reference_id is that address, so no request can name someone
// else's account. Market data is public and cached at the edge; everything else is no-store.
//
// Routes are one segment deep, as the platform's catch-alls are (see api/_basedbot.js):
//   GET  /api/dinari/stocks             the tradable list, cached a minute
//   GET  /api/dinari/price?stock=<id>   current price and bid/ask, cached 15s
//   GET  /api/dinari/hours              market hours
//   POST /api/dinari/me         {auth}                      customer, KYC status, linked wallet
//   POST /api/dinari/kyc        {auth}                      Dinari's KYC page URL for this visitor
//   POST /api/dinari/nonce      {auth}                      Dinari's wallet-ownership message to sign
//   POST /api/dinari/wallet     {auth, nonce, signature}    link the wallet with that signature
//   POST /api/dinari/faucet     {auth}                      sandbox only: 1,000 mockUSD
//   POST /api/dinari/permit     {auth, stockId, usd | qty, side}   prepare an order; returns the permit to sign
//   POST /api/dinari/submit     {auth, orderRequestId, signature}  submit the signed permit
//   POST /api/dinari/order      {auth, orderRequestId}      order request and, once it exists, the order
//   POST /api/dinari/portfolio  {auth}                      dShares and cash
//
// Sandbox and production differ only by the key and DINARI_ENV; until Dinari admits the site
// as a partner, DINARI_ENV=sandbox against sandbox keys is the whole world.
import Dinari from "@dinari/api-sdk";
import { verifyAuth } from "./_auth.js";
import { tooMany } from "./_ratelimit.js";
import { kv, kvAvailable } from "./_kv.js";

const ORIGINS = new Set(["https://anewone.xyz", "https://www.anewone.xyz"]);
const ENV = process.env.DINARI_ENV === "production" ? "production" : "sandbox";
// Where orders are placed. The sandbox faucet mints on Arbitrum Sepolia; in production Dinari's
// chains are Ethereum, Arbitrum, Base, Avalanche and others, not Arc yet, so the visitor's USDC
// crosses over CCTP first (the gangway does that) and the dShares live on that chain.
const CHAIN = process.env.DINARI_CHAIN || (ENV === "production" ? "eip155:42161" : "eip155:421614");
// USDC on the chains Dinari trades on; the sandbox's mockUSD is read from the cash balances instead
const USDC = {
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const RATE = 60;        // requests per IP per minute
const STOCKS_CACHE_S = 60, PRICE_CACHE_S = 15;

let client = null;
function dinari() {
  if (client) return client;
  const apiKeyID = process.env.DINARI_API_KEY_ID, apiSecretKey = process.env.DINARI_API_SECRET_KEY;
  if (!apiKeyID || !apiSecretKey) return null;
  client = new Dinari({ apiKeyID, apiSecretKey, environment: ENV, maxRetries: 1, timeout: 20_000 });
  return client;
}
export const enabled = () => !!(process.env.DINARI_API_KEY_ID && process.env.DINARI_API_SECRET_KEY);

// ---- the visitor's Dinari customer: found by reference_id, created on first sight
async function customerFor(address) {
  const key = "dinari:" + address.toLowerCase();
  if (kvAvailable()) { try { const j = await kv("GET", key); if (j) return JSON.parse(j); } catch {} }
  const d = dinari();
  const ref = address.toLowerCase();
  let entity = (await d.v2.entities.list({ reference_id: ref })).data?.[0];
  if (!entity) entity = await d.v2.entities.create({ name: address, reference_id: ref });
  let account = (await d.v2.entities.accounts.list(entity.id)).data?.[0];
  if (!account) account = await d.v2.entities.accounts.create(entity.id, { jurisdiction: "BASELINE" });
  const cust = { entityId: entity.id, accountId: account.id };
  if (kvAvailable()) { try { await kv("SET", key, JSON.stringify(cust)); } catch {} }
  return cust;
}
const notFound = (e) => e && e.status === 404;

// The payment token for an order: USDC on the order chain, or whatever the account holds there
// (the sandbox's mockUSD). A production account outside the US may pay with other stablecoins
// Dinari accepts; USDC is the one the floor speaks.
async function paymentTokenFor(accountId) {
  if (process.env.DINARI_PAYMENT_TOKEN) return process.env.DINARI_PAYMENT_TOKEN;
  if (ENV === "production" && USDC[CHAIN]) return USDC[CHAIN];
  const cash = await dinari().v2.accounts.getCashBalances(accountId);
  const b = cash.find((x) => x.chain_id === CHAIN);
  if (!b) throw Object.assign(new Error("no payment token on " + CHAIN + " in this account" + (ENV === "sandbox" ? "; use the faucet first" : "")), { status: 409 });
  return b.token_address;
}

// ---- market data, cached per warm instance
const cache = new Map(); // key -> { at, value }
async function cached(key, ttlS, load) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlS * 1000) return c.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
async function stocks() {
  return cached("stocks", STOCKS_CACHE_S, async () => {
    const list = await dinari().v2.marketData.stocks.list({ limit: 200 });
    return list.data.filter((s) => s.is_tradable).map((s) => ({
      id: s.id, symbol: s.symbol, name: s.display_name || s.name, logo: s.logo_url || null,
      fractional: s.is_fractionable, tokens: s.tokens || [],
      onChain: (s.tokens || []).some((t) => t.startsWith(CHAIN + ":")),
    }));
  });
}

async function serve(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin || "", referer = req.headers.referer || "";
  const fromSite = ORIGINS.has(origin) || [...ORIGINS].some((o) => referer.startsWith(o + "/")) || process.env.CHAT_ALLOW_ANY_ORIGIN === "1";
  if (!fromSite) return res.status(403).json({ error: "this endpoint serves anewone.xyz" });
  if (ORIGINS.has(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
  if (await tooMany(req, res, "dinari", RATE)) return;
  if (!dinari()) return res.status(503).json({ error: "stocks are not switched on for this deployment" });

  const u = new URL(req.url, "https://anewone.xyz");
  const route = u.pathname.replace(/^\/api\/dinari\/?/, "").replace(/\/+$/, "").toLowerCase();
  const q = u.searchParams;

  // ---- public reads
  if (req.method === "GET") {
    if (route === "stocks") {
      res.setHeader("Cache-Control", `public, s-maxage=${STOCKS_CACHE_S}, stale-while-revalidate=300`);
      return res.status(200).json({ env: ENV, chain: CHAIN, stocks: await stocks() });
    }
    if (route === "price") {
      const id = q.get("stock") || "";
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: "stock required" });
      res.setHeader("Cache-Control", `public, s-maxage=${PRICE_CACHE_S}, stale-while-revalidate=60`);
      const d = dinari();
      const [price, quote] = await Promise.all([
        cached("price:" + id, PRICE_CACHE_S, () => d.v2.marketData.stocks.retrieveCurrentPrice(id)),
        cached("quote:" + id, PRICE_CACHE_S, () => d.v2.marketData.stocks.retrieveCurrentQuote(id).catch(() => null)),
      ]);
      return res.status(200).json({ price, quote });
    }
    if (route === "hours") {
      res.setHeader("Cache-Control", `public, s-maxage=${STOCKS_CACHE_S}`);
      return res.status(200).json(await cached("hours", STOCKS_CACHE_S, () => dinari().v2.marketData.retrieveMarketHours()));
    }
    return res.status(404).json({ error: "unknown endpoint" });
  }

  // ---- account-bound: the wallet behind `auth` is the customer, whatever the body says
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); } }
  body = body && typeof body === "object" ? body : {};
  const address = await verifyAuth(body.auth);
  if (!address) return res.status(401).json({ error: "sign in first" });
  const d = dinari();
  const { entityId, accountId } = await customerFor(address);

  if (route === "me") {
    const [kyc, wallet] = await Promise.all([
      d.v2.entities.kyc.retrieve(entityId).catch((e) => (notFound(e) ? null : Promise.reject(e))),
      d.v2.accounts.wallet.get(accountId).catch((e) => (notFound(e) ? null : Promise.reject(e))),
    ]);
    return res.status(200).json({
      env: ENV, chain: CHAIN, address, entityId, accountId,
      kyc: kyc ? kyc.status : "NONE", // PASS | FAIL | PENDING | INCOMPLETE | NEEDS_REVIEW | NONE
      wallet: wallet ? { address: wallet.address, managed: wallet.is_managed_wallet, linked: wallet.address.toLowerCase() === address.toLowerCase() } : null,
    });
  }
  if (route === "kyc") {
    // Dinari's own KYC page, opened by the visitor; the status shows up on /me afterwards
    const r = await d.v2.entities.kyc.createManagedCheck(entityId, { jurisdiction: "BASELINE" });
    return res.status(200).json({ url: r.embed_url, expiresAt: r.expiration_dt });
  }
  if (route === "nonce") {
    const r = await d.v2.accounts.wallet.external.getNonce(accountId, { chain_id: "eip155:0", wallet_address: address });
    return res.status(200).json({ message: r.message, nonce: r.nonce });
  }
  if (route === "wallet") {
    const { nonce, signature } = body;
    if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature || "")) return res.status(400).json({ error: "nonce and signature required" });
    const w = await d.v2.accounts.wallet.external.connect(accountId, { chain_id: "eip155:0", nonce, signature, wallet_address: address });
    return res.status(200).json({ wallet: w });
  }
  if (route === "faucet") {
    if (ENV !== "sandbox") return res.status(404).json({ error: "sandbox only" });
    await d.v2.accounts.mintSandboxTokens(accountId, { chain_id: CHAIN });
    return res.status(200).json({ cash: await d.v2.accounts.getCashBalances(accountId) });
  }
  if (route === "permit") {
    const side = body.side === "SELL" ? "SELL" : "BUY";
    const stockId = String(body.stockId || "");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(stockId)) return res.status(400).json({ error: "stockId required" });
    const usd = Number(body.usd), qty = Number(body.qty);
    if (side === "BUY" && !(usd >= 1 && usd <= 10_000)) return res.status(400).json({ error: "usd must be 1..10000" });
    if (side === "SELL" && !(qty > 0)) return res.status(400).json({ error: "qty required" });
    const input = {
      chain_id: CHAIN, order_side: side, order_type: "MARKET", order_tif: "DAY",
      payment_token: await paymentTokenFor(accountId), stock_id: stockId,
      client_order_id: `anewone-${address.slice(2, 10)}-${Date.now()}`,
    };
    if (side === "BUY") input.payment_token_quantity = Math.round(usd * 100) / 100; else input.asset_token_quantity = qty;
    const r = await d.v2.accounts.orderRequests.eip155.createPermit(accountId, input);
    return res.status(200).json({ orderRequestId: r.order_request_id, permit: r.permit, chain: CHAIN });
  }
  if (route === "submit") {
    const { orderRequestId, signature } = body;
    if (typeof orderRequestId !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature || "")) return res.status(400).json({ error: "orderRequestId and signature required" });
    const r = await d.v2.accounts.orderRequests.eip155.submit(accountId, { order_request_id: orderRequestId, permit_signature: signature });
    return res.status(200).json({ request: r });
  }
  if (route === "order") {
    const id = String(body.orderRequestId || "");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: "orderRequestId required" });
    const request = await d.v2.accounts.orderRequests.retrieve(id, { account_id: accountId });
    const order = request.order_id ? await d.v2.accounts.orders.retrieve(request.order_id, { account_id: accountId }).catch(() => null) : null;
    return res.status(200).json({ request, order });
  }
  if (route === "portfolio") {
    const [portfolio, cash] = await Promise.all([d.v2.accounts.getPortfolio(accountId), d.v2.accounts.getCashBalances(accountId)]);
    return res.status(200).json({ portfolio, cash });
  }
  return res.status(404).json({ error: "unknown endpoint" });
}

export default async function handler(req, res) {
  try {
    return await serve(req, res);
  } catch (e) {
    // Dinari's errors carry a status and a JSON body; the visitor gets the status and the
    // message, the log gets the rest
    console.error("dinari:", e);
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 502;
    return res.status(status).json({ error: status === 502 ? "dinari unavailable" : (e.message || "request failed") });
  }
}
