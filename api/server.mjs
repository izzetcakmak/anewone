#!/usr/bin/env node
/**
 * ANEWONE x402 API — paid floor-stats endpoints for AI agents. Zero dependencies.
 *
 * Implements the x402 payment flow (HTTP 402 Payment Required, x402Version 1):
 *   1. Agent hits a paid route with no X-PAYMENT header -> 402 + accepts[] payment terms
 *   2. Agent signs an EIP-3009 authorization, retries with X-PAYMENT (base64 JSON)
 *   3. Server asks the facilitator to /verify, serves the data, then /settle,
 *      and returns the settlement receipt in the X-PAYMENT-RESPONSE header.
 *
 * Routes:
 *   GET /            free   service index (machine-readable, Agent Marketplace friendly)
 *   GET /healthz     free   liveness probe
 *   GET /floor       paid   live curve stats for every token on the floor
 *   GET /token/0x…   paid   single-token detail + quoteBuy samples
 *
 * Env (all optional — defaults target Arc testnet from docs/config.js):
 *   PORT=8402 HOST=127.0.0.1
 *   RPC_URL=https://rpc.testnet.arc.network
 *   PLATFORM=0x30c941ed26088DED6c5D4F1571a49f74478DCc84
 *   CHAIN_ID=5042002
 *   PAY_TO=0x…                 payment recipient (default: owners(0) read from chain)
 *   FACILITATOR_URL=https://…  x402 facilitator (e.g. Circle Gateway / Nanopayments)
 *   X402_NETWORK=arc-testnet   network id your facilitator expects
 *   X402_ASSET=0x…             asset your facilitator expects (Gateway USDC)
 *   X402_ASSET_DECIMALS=6
 *   PRICE_FLOOR_USD=0.001 PRICE_TOKEN_USD=0.0005
 *   MOCK_FACILITATOR=1         serve an in-process facilitator that accepts payments (dev)
 *   MOCK_CHAIN=1               canned $NOAH fixtures instead of RPC (offline dev)
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------- keccak-256
// Compact keccak-f[1600] over BigInt lanes. Only used for a handful of function
// selectors at startup, so clarity beats speed. Self-tested below against known
// vectors — the process refuses to start if the implementation is off.

const MASK64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// rho rotation offsets, indexed [x][y]
const RHO = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const rot = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64;

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    const C = [], D = [];
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
    for (let i = 0; i < 25; i++) A[i] ^= D[i % 5];
    const B = new Array(25);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rot(A[x + 5 * y], RHO[x][y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        A[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & MASK64) & B[(x + 2) % 5 + 5 * y];
    A[0] ^= RC[round];
  }
}

function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const selector = (sig) => hex(keccak256(new TextEncoder().encode(sig)).slice(0, 4));

// refuse to serve if keccak is broken
if (hex(keccak256(new Uint8Array(0))) !== "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  || selector("transfer(address,uint256)") !== "a9059cbb"
  || selector("balanceOf(address)") !== "70a08231") {
  throw new Error("keccak-256 self-test failed");
}

// ---------------------------------------------------------------- config

const CFG = {
  port: Number(process.env.PORT || 8402),
  host: process.env.HOST || "127.0.0.1",
  rpc: process.env.RPC_URL || "https://rpc.testnet.arc.network",
  platform: process.env.PLATFORM || "0x30c941ed26088DED6c5D4F1571a49f74478DCc84",
  chainId: Number(process.env.CHAIN_ID || 5042002),
  payTo: process.env.PAY_TO || null, // resolved from owners(0) at startup if unset
  facilitator: process.env.FACILITATOR_URL || null,
  network: process.env.X402_NETWORK || "arc-testnet",
  // The asset your facilitator settles in (Circle Gateway USDC balance for
  // Nanopayments). Zero address = native USDC on Arc; override per facilitator.
  asset: process.env.X402_ASSET || "0x0000000000000000000000000000000000000000",
  assetDecimals: Number(process.env.X402_ASSET_DECIMALS || 6),
  priceFloorUsd: process.env.PRICE_FLOOR_USD || "0.001",
  priceTokenUsd: process.env.PRICE_TOKEN_USD || "0.0005",
  mockFacilitator: process.env.MOCK_FACILITATOR === "1",
  mockChain: process.env.MOCK_CHAIN === "1",
};
if (CFG.mockFacilitator) CFG.facilitator = `http://${CFG.host}:${CFG.port}/facilitator`;
if (!CFG.facilitator) {
  console.error("No FACILITATOR_URL set and MOCK_FACILITATOR!=1 — paid routes cannot settle.\n" +
    "Point FACILITATOR_URL at an x402 facilitator (Circle Gateway / Nanopayments), or run with MOCK_FACILITATOR=1 for local dev.");
  process.exit(1);
}

const usdToAtomic = (usd) => {
  const [i, f = ""] = String(usd).split(".");
  return (BigInt(i + f.padEnd(CFG.assetDecimals, "0").slice(0, CFG.assetDecimals))).toString();
};

// ---------------------------------------------------------------- chain reads

const SEL = {
  tokensCount: selector("tokensCount()"),
  allTokens: selector("allTokens(uint256)"),
  priceWad: selector("priceWad(address)"),
  progressBps: selector("progressBps(address)"),
  info: selector("info(address)"),
  quoteBuy: selector("quoteBuy(address,uint256)"),
  owners: selector("owners(uint256)"),
  gradTarget: selector("gradTarget()"),
  name: selector("name()"),
  symbol: selector("symbol()"),
};

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrArg = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

async function ethCall(to, data) {
  const res = await fetch(CFG.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc: ${j.error.message}`);
  return j.result;
}

const decUint = (ret, i = 0) => BigInt("0x" + (ret.slice(2).slice(i * 64, i * 64 + 64) || "0"));
const decAddr = (ret, i = 0) => "0x" + ret.slice(2).slice(i * 64 + 24, i * 64 + 64);
function decString(ret, i = 0) {
  const body = ret.slice(2);
  const off = Number(decUint(ret, i)) * 2;
  const len = parseInt(body.slice(off, off + 64), 16) * 2;
  const raw = body.slice(off + 64, off + 64 + len);
  return Buffer.from(raw, "hex").toString("utf8");
}

// wei (18 dec) -> decimal string, trimmed
function fmt18(v) {
  const s = v.toString().padStart(19, "0");
  const int = s.slice(0, -18), frac = s.slice(-18).replace(/0+$/, "");
  return frac ? `${int}.${frac.slice(0, 8)}` : int;
}

const cache = new Map(); // rate-limit friendly: tiny TTL cache in front of the RPC
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const MOCK_NOAH = {
  address: "0xdd1B695d94dE16A85E17E772664067020806E4A1",
  name: "Noah's Arc", symbol: "NOAH",
  creator: "0x000000000000000000000000000000000000c0de",
  graduated: false,
  vUsdc: 5_234_560_000_000_000_000_000n,   // 4,000 virtual + 1,234.56 raised
  tReserve: 764_100_000_000_000_000_000_000_000n,
  raised: 1_234_560_000_000_000_000_000n,
  metadataURI: "https://anewone.xyz/meta/noah.json",
};
const MOCK_GRAD_TARGET = 5_000_000_000_000_000_000_000n;

async function readToken(addr) {
  if (CFG.mockChain) {
    const t = { ...MOCK_NOAH, address: addr };
    return {
      address: addr, name: t.name, symbol: t.symbol, creator: t.creator, graduated: t.graduated,
      priceUsdc: fmt18((t.vUsdc * 10n ** 18n) / t.tReserve),
      progressBps: Number((t.raised * 10_000n) / MOCK_GRAD_TARGET),
      raisedUsdc: fmt18(t.raised), curveTokens: fmt18(t.tReserve), metadataURI: t.metadataURI,
    };
  }
  const arg = addrArg(addr);
  const [info, priceWad, progressBps, name, symbol] = await Promise.all([
    ethCall(CFG.platform, "0x" + SEL.info + arg),
    ethCall(CFG.platform, "0x" + SEL.priceWad + arg),
    ethCall(CFG.platform, "0x" + SEL.progressBps + arg),
    ethCall(addr, "0x" + SEL.name),
    ethCall(addr, "0x" + SEL.symbol),
  ]);
  // info(address): (creator, createdBlock, graduated, vUsdc, tReserve, raised, metadataURI)
  return {
    address: addr,
    name: decString(name), symbol: decString(symbol),
    creator: decAddr(info, 0),
    graduated: decUint(info, 2) === 1n,
    priceUsdc: fmt18(decUint(priceWad)),
    progressBps: Number(decUint(progressBps)),
    raisedUsdc: fmt18(decUint(info, 5)),
    curveTokens: fmt18(decUint(info, 4)),
    metadataURI: decString(info, 6),
  };
}

async function readFloor() {
  return cached("floor", 5_000, async () => {
    if (CFG.mockChain) {
      const noah = await readToken(MOCK_NOAH.address);
      return { platform: CFG.platform, chainId: CFG.chainId, tokensCount: 1, tokens: [noah] };
    }
    const count = Number(decUint(await ethCall(CFG.platform, "0x" + SEL.tokensCount)));
    const addrs = await Promise.all(
      Array.from({ length: count }, (_, i) => ethCall(CFG.platform, "0x" + SEL.allTokens + word(i)).then((r) => decAddr(r)))
    );
    const tokens = await Promise.all(addrs.map(readToken));
    return { platform: CFG.platform, chainId: CFG.chainId, tokensCount: count, tokens };
  });
}

async function readTokenDetail(addr) {
  return cached(`token:${addr.toLowerCase()}`, 5_000, async () => {
    const base = await readToken(addr);
    const samples = [1n, 10n, 100n].map((u) => u * 10n ** 18n);
    let quotes;
    if (CFG.mockChain) {
      const t = MOCK_NOAH, k = t.vUsdc * t.tReserve;
      quotes = samples.map((usdcIn) => {
        const inAfterFee = usdcIn - (usdcIn * 100n) / 10_000n;
        return { usdcIn: fmt18(usdcIn), tokensOut: fmt18(t.tReserve - k / (t.vUsdc + inAfterFee)) };
      });
    } else {
      quotes = await Promise.all(samples.map(async (usdcIn) => ({
        usdcIn: fmt18(usdcIn),
        tokensOut: fmt18(decUint(await ethCall(CFG.platform, "0x" + SEL.quoteBuy + addrArg(addr) + word(usdcIn)))),
      })));
    }
    return { ...base, quoteBuy: quotes };
  });
}

async function resolvePayTo() {
  if (CFG.payTo) return;
  if (CFG.mockChain) { CFG.payTo = "0x00000000000000000000000000000000deadbeef"; return; }
  CFG.payTo = decAddr(await ethCall(CFG.platform, "0x" + SEL.owners + word(0)));
}

// ---------------------------------------------------------------- x402

const b64ToJson = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const jsonToB64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

function paymentRequirements(req, price, description) {
  return {
    scheme: "exact",
    network: CFG.network,
    maxAmountRequired: usdToAtomic(price),
    resource: `http://${req.headers.host}${req.url.split("?")[0]}`,
    description,
    mimeType: "application/json",
    payTo: CFG.payTo,
    maxTimeoutSeconds: 60,
    asset: CFG.asset,
    extra: { name: "USDC", version: "2" }, // EIP-712 domain for EIP-3009 signing
  };
}

async function facilitator(path, paymentPayload, requirements) {
  const res = await fetch(`${CFG.facilitator}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: requirements }),
  });
  if (!res.ok) throw new Error(`facilitator /${path} http ${res.status}`);
  return res.json();
}

/** Gate a route behind an x402 payment. Returns null if a 402/error was sent. */
async function requirePayment(req, res, price, description) {
  const requirements = paymentRequirements(req, price, description);
  const header = req.headers["x-payment"];
  if (!header) {
    send(res, 402, { x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirements] });
    return null;
  }
  let payload;
  try { payload = b64ToJson(header); }
  catch { send(res, 402, { x402Version: 1, error: "malformed X-PAYMENT header", accepts: [requirements] }); return null; }
  if (payload.scheme !== requirements.scheme || payload.network !== requirements.network) {
    send(res, 402, { x402Version: 1, error: "unsupported scheme or network", accepts: [requirements] });
    return null;
  }
  try {
    const v = await facilitator("verify", payload, requirements);
    if (!v.isValid) {
      send(res, 402, { x402Version: 1, error: v.invalidReason || "payment verification failed", accepts: [requirements] });
      return null;
    }
  } catch (e) {
    send(res, 502, { error: `facilitator unreachable: ${e.message}` });
    return null;
  }
  return { payload, requirements };
}

async function settle(res, payment) {
  try {
    const s = await facilitator("settle", payment.payload, payment.requirements);
    res.setHeader("X-PAYMENT-RESPONSE", jsonToB64(s));
  } catch (e) {
    res.setHeader("X-PAYMENT-RESPONSE", jsonToB64({ success: false, error: e.message }));
  }
}

// In-process mock facilitator: accepts any well-formed payment. Dev only.
function mockFacilitator(path, body, res) {
  const auth = body?.paymentPayload?.payload?.authorization;
  const ok = auth?.from && auth?.to?.toLowerCase() === body?.paymentRequirements?.payTo?.toLowerCase()
    && BigInt(auth?.value ?? 0) >= BigInt(body?.paymentRequirements?.maxAmountRequired ?? 0);
  if (path === "verify") {
    return send(res, 200, ok ? { isValid: true, payer: auth.from }
      : { isValid: false, invalidReason: "authorization missing, wrong payTo, or value below maxAmountRequired" });
  }
  if (path === "settle") {
    return send(res, 200, ok
      ? { success: true, network: body.paymentRequirements.network, payer: auth.from, transaction: "0xmock" + hex(randomBytes(30)) }
      : { success: false, errorReason: "invalid payment" });
  }
  send(res, 404, { error: "unknown facilitator route" });
}

// ---------------------------------------------------------------- http server

function send(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "X-PAYMENT, Content-Type",
    "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
  });
  res.end(body);
}

const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 100_000) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
});

function index(req) {
  return {
    service: "A NEW ONE floor API",
    description: "Live bonding-curve stats for every meme token on anewone.xyz (Arc). x402-paid, agent-first.",
    platform: CFG.platform,
    chainId: CFG.chainId,
    x402: { version: 1, network: CFG.network, payTo: CFG.payTo, asset: CFG.asset, facilitator: CFG.facilitator },
    endpoints: [
      { path: "/", method: "GET", price: "free", description: "this index" },
      { path: "/healthz", method: "GET", price: "free", description: "liveness probe" },
      { path: "/floor", method: "GET", price: `$${CFG.priceFloorUsd}`, description: "all tokens: price, progress, raised, creator" },
      { path: "/token/{address}", method: "GET", price: `$${CFG.priceTokenUsd}`, description: "single token detail + quoteBuy samples" },
      { path: "/comments/{address}", method: "GET", price: "free", description: "not yet implemented (comment threads are event-only onchain)" },
    ],
    mock: { chain: CFG.mockChain, facilitator: CFG.mockFacilitator },
  };
}

const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "X-PAYMENT, Content-Type",
        "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
      });
      return res.end();
    }

    if (CFG.mockFacilitator && path.startsWith("/facilitator/") && req.method === "POST") {
      return mockFacilitator(path.slice("/facilitator/".length), await readBody(req), res);
    }
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    if (path === "/") return send(res, 200, index(req));
    if (path === "/healthz") return send(res, 200, { ok: true });

    if (path === "/floor") {
      const payment = await requirePayment(req, res, CFG.priceFloorUsd, "A NEW ONE: live curve stats for the whole floor");
      if (!payment) return;
      const data = await readFloor();
      await settle(res, payment);
      return send(res, 200, data);
    }

    const m = path.match(/^\/token\/(0x[0-9a-fA-F]{40})$/);
    if (m) {
      const payment = await requirePayment(req, res, CFG.priceTokenUsd, `A NEW ONE: token detail for ${m[1]}`);
      if (!payment) return;
      const data = await readTokenDetail(m[1]);
      await settle(res, payment);
      return send(res, 200, data);
    }

    send(res, 404, { error: "not found", hint: "GET / for the endpoint index" });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
});

await resolvePayTo();
server.listen(CFG.port, CFG.host, () => {
  console.log(`ANEWONE x402 API on http://${CFG.host}:${CFG.port}`);
  console.log(`  platform ${CFG.platform} (chain ${CFG.chainId})${CFG.mockChain ? " [MOCK CHAIN]" : ""}`);
  console.log(`  payTo ${CFG.payTo} | facilitator ${CFG.facilitator}${CFG.mockFacilitator ? " [MOCK]" : ""}`);
});
