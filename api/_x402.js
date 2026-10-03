// The x402 paywall for the agent API (api/agent.js, api/agent/*), settled by Circle's Facilitator
// Service. DRAFT: nothing here runs until X402_PAY_TO is set; api/basedbot stays free and untouched.
//
// The handshake (x402 v2, https://developers.circle.com/x402-facilitators/x402):
//   1. GET /api/agent/tokens                      -> 402 + PAYMENT-REQUIRED header (base64 JSON: accepts[])
//   2. GET /api/agent/tokens + PAYMENT-SIGNATURE  -> the buyer's signed EIP-3009 TransferWithAuthorization
//   3. we POST it to the facilitator's /settle; on terminal success the resource goes out with a
//      PAYMENT-RESPONSE header (base64 JSON: transaction, network, payer)
//
// Money: USDC, 6-decimal units in `amount` ("1000" = $0.001). payTo is X402_PAY_TO, a wallet of ours
// that holds nothing but the fees it collects. The facilitator is authenticated either with
// CIRCLE_API_KEY (production, bearer) or, on the keyless trial, with a Facilitator-Seller-Proof:
// an EIP-712 signature by the payTo key over this exact request (X402_SELLER_KEY). The key signs
// proofs only; it never moves funds and the facilitator never sees it.
//
// Networks: Arc mainnet by default (eip155:5042, native USDC at 0x3600...0000, ~0.5 s finality).
// Base and Polygon can be added with X402_NETWORKS; Circle's facilitator settles on those three.
// Gateway nanopayments (GatewayWalletBatched, sub-cent and gasless) are the next step: they need
// @circle-fin/x402-batching on the settle side and are not in this draft.
//
// What a paid response must never be: cached. The function sets Cache-Control: no-store on every
// 402 and on every paid 200, so the edge serves nothing paid to a caller who did not pay.
import { randomBytes } from "node:crypto";
import { Wallet, keccak256, toUtf8Bytes, getAddress } from "ethers";
import { kv, kvAvailable } from "./_kv.js";

const FACILITATOR = "https://api.circle.com/v1/facilitator/x402";
const SITE = "https://anewone.xyz";
const MAX_TIMEOUT_S = 60; // how long the buyer's authorization stays acceptable to us
const SETTLE_TIMEOUT_MS = 20_000;

// The facilitator's networks: CAIP-2 id, chain id, USDC contract and USDC's EIP-712 domain
// (what the buyer signs against). https://developers.circle.com/facilitator-service/supported-networks
export const NETWORKS = {
  "eip155:5042": { name: "Arc", chainId: 5042, usdc: "0x3600000000000000000000000000000000000000", domain: { name: "USDC", version: "2" } },
  "eip155:5042002": { name: "Arc Testnet", chainId: 5042002, usdc: "0x3600000000000000000000000000000000000000", domain: { name: "USDC", version: "2" } },
  "eip155:8453": { name: "Base", chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", domain: { name: "USD Coin", version: "2" } },
  "eip155:137": { name: "Polygon PoS", chainId: 137, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", domain: { name: "USD Coin", version: "2" } },
};

// Prices in USDC 6-decimal units per route key (see routeKey in api/_basedbot.js). The document
// itself is free so an agent, and the marketplace's health check, can read what is on offer.
// X402_PRICES overrides any of them as JSON, e.g. {"candles":"5000"}.
const DEFAULT_PRICES = {
  "": "0",
  tokens: "1000",       // $0.001 the list
  token: "1000",        // $0.001 one coin with its distribution and tape
  trades: "1000",       // $0.001
  distribution: "1000", // $0.001
  candles: "2000",      // $0.002 OHLCV
};

// What each route takes and gives, for the 402's discovery extension (x402 Bazaar), which is
// what the marketplace and the Circle CLI read to describe an endpoint to an agent.
const DESCRIBE = {
  "": { description: "The agent API's own document: endpoints, prices, field semantics", query: {} },
  tokens: {
    description: "Every coin on A NEW ONE (Arc mainnet): price, caps, liquidity, 24h volume, holders, venue",
    query: { limit: "integer, max 500", sort: "volume24h|volumeAll|marketCap|fdv|liquidity|trades24h|holders|age|created", graduated: "true|false", q: "name or symbol substring" },
  },
  token: { description: "One coin by address, with holder distribution and its last trades", query: { address: "0x address", trades: "integer, max 200" } },
  trades: { description: "Trades of the last 24h, newest first, curve and Uniswap pool", query: { address: "0x address (optional)", limit: "integer, max 1000" } },
  distribution: { description: "Holder count and concentration shares; no wallet is named", query: { address: "0x address" } },
  candles: { description: "OHLCV candles in USDC", query: { address: "0x address", tf: "1m|5m|15m|1h|4h|1d", limit: "integer, max 1000" } },
};

function config() {
  const payTo = (process.env.X402_PAY_TO || "").trim();
  const sellerKey = (process.env.X402_SELLER_KEY || "").trim();
  const apiKey = (process.env.CIRCLE_API_KEY || "").trim();
  const nets = (process.env.X402_NETWORKS || "eip155:5042").split(",").map((s) => s.trim()).filter((n) => NETWORKS[n]);
  let prices = DEFAULT_PRICES;
  try { if (process.env.X402_PRICES) prices = { ...DEFAULT_PRICES, ...JSON.parse(process.env.X402_PRICES) }; } catch { /* keep the defaults */ }
  const ok = /^0x[0-9a-fA-F]{40}$/.test(payTo) && (apiKey || /^0x[0-9a-fA-F]{64}$/.test(sellerKey)) && nets.length > 0;
  // checksummed on the way out whatever case it was pasted in
  return { ok, payTo: ok ? getAddress(payTo.toLowerCase()) : payTo, sellerKey, apiKey, nets, prices };
}

/** The price of a route in USDC units, "0" for free. */
export const priceOf = (route) => config().prices[route] ?? "0";

/** The accepts[] we advertise for one resource: one entry per network, vanilla EIP-3009. */
function accepts(cfg, amount) {
  return cfg.nets.map((network) => {
    const n = NETWORKS[network];
    return {
      scheme: "exact",
      network,
      amount,
      asset: n.usdc,
      payTo: cfg.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_S,
      extra: { name: n.domain.name, version: n.domain.version, assetTransferMethod: "eip3009" },
    };
  });
}

/** The 402 body, also what PAYMENT-REQUIRED carries base64-encoded. */
export function paymentRequired(cfg, resourceUrl, route, amount, error) {
  const d = DESCRIBE[route] || DESCRIBE[""];
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: resourceUrl, description: d.description, mimeType: "application/json" },
    accepts: accepts(cfg, amount),
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: d.query },
          output: { type: "json" },
        },
      },
    },
  };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

function reply402(res, body) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("PAYMENT-REQUIRED", b64(body));
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  return res.status(402).json(body);
}

/** The Facilitator-Seller-Proof header for one facilitator call on the keyless trial. */
async function sellerProof(cfg, purpose, method, body, network) {
  const wallet = new Wallet(cfg.sellerKey);
  if (wallet.address.toLowerCase() !== cfg.payTo.toLowerCase()) throw new Error("X402_SELLER_KEY does not control X402_PAY_TO");
  const nonce = "0x" + randomBytes(32).toString("hex");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300; // the most the facilitator allows
  const signature = await wallet.signTypedData(
    { name: "Circle Facilitator Seller Request", version: "1", chainId: NETWORKS[network].chainId },
    {
      SellerRequest: [
        { name: "purpose", type: "string" },
        { name: "method", type: "string" },
        { name: "bodyHash", type: "bytes32" },
        { name: "network", type: "string" },
        { name: "payTo", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    {
      purpose,
      method: method.toUpperCase(),
      bodyHash: keccak256(toUtf8Bytes(body)), // GET hashes the empty string
      network,
      payTo: cfg.payTo,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  );
  const envelope = { version: 1, signature, network, payTo: cfg.payTo, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

async function facilitator(cfg, purpose, path, body, network) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (cfg.apiKey) headers.authorization = "Bearer " + cfg.apiKey;
  else headers["Facilitator-Seller-Proof"] = await sellerProof(cfg, purpose, body ? "POST" : "GET", body || "", network);
  const r = await fetch(FACILITATOR + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

// A buyer's authorization is single-use on chain, but between our seeing it and the facilitator
// settling it the same header could be replayed at another route: the nonce is remembered for
// the hour the authorization could be valid. In memory without Redis, as the rate limiter does.
const seen = new Map();
async function alreadyUsed(network, nonce) {
  const key = `x402:nonce:${network}:${String(nonce).toLowerCase()}`;
  if (kvAvailable()) {
    try { return (await kv("SET", key, "1", "EX", 3600, "NX")) === null; } catch { /* fall through */ }
  }
  if (seen.has(key)) return true;
  if (seen.size > 10_000) seen.clear();
  seen.set(key, Date.now());
  return false;
}

const big = (x) => { try { return BigInt(x); } catch { return null; } };

/**
 * Gate one request. Returns true when the route is free or paid for, in which case the caller
 * serves the resource; false when a response (402, 503) has already been sent.
 */
export async function paywall(req, res, route) {
  const cfg = config();
  const amount = cfg.prices[route] ?? "0";
  if (amount === "0") return true;
  const resourceUrl = SITE + (req.url || "/").split("?")[0];
  if (!cfg.ok) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "paid API not configured; the free index is at " + SITE + "/api/basedbot" });
    return false;
  }

  const header = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!header) return reply402(res, paymentRequired(cfg, resourceUrl, route, amount)) && false;

  let payload;
  try { payload = JSON.parse(Buffer.from(String(header), "base64").toString("utf8")); } catch {
    return reply402(res, paymentRequired(cfg, resourceUrl, route, amount, "PAYMENT-SIGNATURE is not base64 JSON")) && false;
  }
  const acc = payload && payload.accepted, pl = payload && payload.payload, auth = pl && pl.authorization;
  const ours = acc && accepts(cfg, amount).find((a) =>
    a.scheme === acc.scheme && a.network === acc.network &&
    String(acc.asset || "").toLowerCase() === a.asset.toLowerCase() &&
    String(acc.payTo || "").toLowerCase() === a.payTo.toLowerCase());
  const fail = (why) => reply402(res, paymentRequired(cfg, resourceUrl, route, amount, why)) && false;
  if (payload.x402Version !== 2 || !ours) return fail("payment does not match an accepted option");
  if (!auth || !pl.signature) return fail("payload.signature and payload.authorization required");
  const value = big(auth.value), validBefore = big(auth.validBefore), validAfter = big(auth.validAfter || "0");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (value === null || value < BigInt(amount)) return fail("authorization value below the price " + amount);
  if (String(auth.to || "").toLowerCase() !== cfg.payTo.toLowerCase()) return fail("authorization.to is not payTo");
  if (validBefore === null || validBefore <= now + 5n) return fail("authorization expired or expires too soon");
  if (validAfter === null || validAfter > now) return fail("authorization not yet valid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(auth.nonce || ""))) return fail("authorization.nonce must be bytes32");
  if (await alreadyUsed(ours.network, auth.nonce)) return fail("authorization already used");

  const settleBody = JSON.stringify({
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: resourceUrl, description: (DESCRIBE[route] || DESCRIBE[""]).description, mimeType: "application/json" },
      accepted: ours,
      payload: { signature: pl.signature, authorization: auth },
      extensions: payload.extensions || {},
    },
    paymentRequirements: ours,
  });
  let out;
  try { out = await facilitator(cfg, "settle", "/settle", settleBody, ours.network); } catch (e) {
    console.error("x402: settle unreachable:", e.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "payment facilitator unreachable, retry with the same authorization" });
    return false;
  }
  const s = out.body || {};
  if (out.status === 200 && s.success === true) {
    const receipt = { success: true, transaction: s.transaction, network: s.network, payer: s.payer, amount: s.amount };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("PAYMENT-RESPONSE", b64(receipt));
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    return true;
  }
  // Pending is not paid: the facilitator did not see the transfer confirm in its window. The
  // buyer retries with the very same authorization (same nonce), which the facilitator treats as
  // the same payment; the nonce guard above would refuse it, so it is released here.
  if (out.status === 200 && s.errorReason === "settlement_pending") {
    const st = (s.extensions || {})["settlement-status"] || {};
    if (kvAvailable()) { try { await kv("DEL", `x402:nonce:${ours.network}:${String(auth.nonce).toLowerCase()}`); } catch { /* the hour passes */ } }
    seen.delete(`x402:nonce:${ours.network}:${String(auth.nonce).toLowerCase()}`);
    return fail("settlement pending, retry this exact authorization shortly" + (st.paymentId ? " (payment " + st.paymentId + ")" : ""));
  }
  console.error("x402: settle refused:", out.status, JSON.stringify(s).slice(0, 500));
  return fail("payment refused: " + (s.errorReason || s.message || ("HTTP " + out.status)));
}

/** What the agent document says about paying, for the root route. */
export function paymentInfo(route = "") {
  const cfg = config();
  return {
    protocol: "x402 v2",
    configured: cfg.ok,
    payTo: cfg.ok ? cfg.payTo : null,
    networks: cfg.nets.map((n) => ({ network: n, name: NETWORKS[n].name, usdc: NETWORKS[n].usdc })),
    pricesUsdc: Object.fromEntries(Object.entries(cfg.prices).map(([k, v]) => [k || "document", Number(v) / 1e6])),
    howTo: "call any priced endpoint without a PAYMENT-SIGNATURE header to get a 402 with the accepted options (also base64 in the PAYMENT-REQUIRED header), sign an EIP-3009 TransferWithAuthorization for one of them, and retry with the signed payload base64 in PAYMENT-SIGNATURE; the Circle CLI does all of this: circle services pay <url> -X GET",
    settledBy: "Circle Facilitator Service",
    thisRoute: route,
  };
}
