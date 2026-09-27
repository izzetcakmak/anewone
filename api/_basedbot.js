// Public read-only index API for A NEW ONE, shaped for trading terminals and screeners
// (basedbot.app asked for nothing; this is what a terminal needs to list a launchpad).
//
// Everything here is already public: it is derived from data/floor.json, the same on-chain
// index the floor itself reads, which the scanner rebuilds at most every half hour and
// republishes only when something moved. Nothing is signed, nothing is private, and no caller
// is identified. GET only, CORS open, cached at the edge for CACHE_S seconds so a busy terminal
// costs one origin read per window.
//
// Amounts: USD figures are plain numbers in dollars (Arc's native currency is USDC, so a
// dollar IS the chain's unit); token amounts are plain numbers of whole tokens. Where exactness
// matters the wei string is given alongside (priceWad, raisedWei). Every volume figure is
// already converted to the CURVE side of the trade, the way the contract's own comment on the
// Trade event asks indexers to do it; summing the raw event values would overstate buys by the
// fee.
//
// Times are unix seconds. The chain emits block numbers, not timestamps, so a block is turned
// into a time with the index's measured block time; expect a second or two of drift on old
// blocks, not more.
//
// No wallet is named. The index behind this API knows every holder and every trader by address,
// with their USDC in and out, and all of it is on chain for anyone who wants to walk the logs
// themselves; this API deliberately does not hand it over ready made. Holders are a count and a
// concentration figure, trades are a tape of sides and sizes. A terminal needs nothing else, and
// our traders do not get their book served to a third party by us.
import { readFile } from "node:fs/promises";
import { tooMany } from "./_ratelimit.js";

const SITE = "https://anewone.xyz";
const FLOOR_URL = `${SITE}/data/floor.json`;
const CACHE_S = 15; // edge + in-instance
const RATE = 240; // requests per IP per minute; a terminal polling every 5s needs 12
const WAD = 10n ** 18n;
const BPS = 10_000n;
const FEE_BPS = 150n; // 1.5% trade fee, of which a third goes to the coin's creator
const SUPPLY = 1_000_000_000; // every coin launches with the same 1B; migrate() burns part of it
const ANTI_SNIPE_BLOCKS = 20; // as in the contract: for this many blocks after its creation,
const ANTI_SNIPE_MAX = SUPPLY / 50; // a coin sells one wallet at most 2% of its supply
const DAY_BLOCKS = 172_800;
const MAX_LIST = 500;
const MAX_TRADES = 1000;
const MAX_CANDLES = 1000;
const TFS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
const NO_COIN = "no coin at that address on this platform";

/** The curve-side USDC of a trade: a buy paid the fee on top, a sell had it deducted. */
const curveSide = (u, isBuy) => (isBuy ? (u * (BPS - FEE_BPS)) / BPS : (u * BPS) / (BPS - FEE_BPS));

const num = (wei, dp = 18) => Number(wei) / 10 ** dp;
const round = (x, dp) => (Number.isFinite(x) ? Number(x.toFixed(dp)) : 0);
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

// The index ships with this function. The scanner publishes data/floor.json by pushing it, a
// push is a deployment, and vercel.json bundles the file into this function, so the copy on
// disk is the very file the site serves. Reading it there keeps the API off the public edge,
// where a firewall challenge or a slow answer would take every endpoint down with it. The
// public URL is only the fallback for a bundle that lacks the file.
const BUNDLED = new URL("../docs/data/floor.json", import.meta.url);
let warnedBundle = false;

let cache = { at: 0, floor: null };

async function loadFloor() {
  if (cache.floor && Date.now() - cache.at < CACHE_S * 1000) return cache.floor;
  let floor;
  try {
    floor = JSON.parse(await readFile(BUNDLED, "utf8"));
  } catch (e) {
    if (!warnedBundle) console.warn("basedbot: bundled index unreadable, reading the public copy:", e.message);
    warnedBundle = true;
    const r = await fetch(FLOOR_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("index unavailable (" + r.status + ")");
    floor = await r.json();
  }
  cache = { at: Date.now(), floor };
  return floor;
}

/** Block number to unix seconds, from the index's tip and measured block time. */
function clock(floor) {
  const genSec = Math.floor(new Date(floor.generatedAt).getTime() / 1000);
  const bt = Number(floor.blockTimeSec) || 1;
  return { at: (b) => Math.round(genSec - (floor.tip - b) * bt), bt, genSec };
}

/** Everything the list and the single-coin view need, per coin, in one pass. */
function shape(floor) {
  const ix = floor.index || {};
  const { at, bt } = clock(floor);
  const cutoff = floor.tip - DAY_BLOCKS;
  const gradTarget = num(BigInt(floor.gradTarget || "0"));

  // 24h volume and trade count, per coin, from the 24h trade list
  const day = {};
  for (const r of ix.recent || []) {
    if (r.b < cutoff) continue;
    const d = day[r.tk] || (day[r.tk] = { vol: 0n, trades: 0, last: 0 });
    d.vol += curveSide(BigInt(r.u), !!r.buy);
    d.trades++;
    if (r.b > d.last) d.last = r.b;
  }

  return (floor.tokens || []).map((t) => {
    const addr = t.addr;
    const priceWad = (BigInt(t.vUsdc) * WAD) / BigInt(t.tReserve);
    const priceUsd = num(priceWad);
    const raisedUsd = num(BigInt(t.raised || "0"));
    const a = (ix.agg || {})[addr] || { volAll: "0", trades: 0, lastBlock: 0 };
    const d = day[addr] || { vol: 0n, trades: 0, last: 0 };
    const series = (ix.series || {})[addr] || [];
    const holders = Object.values((ix.net || {})[addr] || {}).filter((h) => BigInt(h.t) > 0n).length;

    // price at (now - seconds), from the last point at or before that block
    const back = (sec) => {
      const b = floor.tip - Math.round(sec / bt);
      let p = null;
      for (const x of series) { if (x.b > b) break; p = x.p; }
      if (p === null || BigInt(p) === 0n) return null;
      return round((priceUsd / num(BigInt(p)) - 1) * 100, 2);
    };

    const lastBlock = Math.max(a.lastBlock || 0, d.last || 0);
    // Supply as it is, not as it launched. On the curve the unsold tokens are the curve's own
    // (tReserve): nobody can trade them but the curve, so they are not circulating. After
    // migration the burned part is gone for good, and the pool's inventory is on the open
    // market, so it circulates like any pool's does. holderSupply leaves the pool out too.
    const burned = num(BigInt(t.burned || "0"));
    const totalSupply = SUPPLY - burned;
    const circulatingSupply = Math.max(0, t.migrated ? totalSupply : totalSupply - num(BigInt(t.tReserve)));
    const holderSupply = Math.max(0, circulatingSupply - (t.migrated ? num(BigInt(t.inPool || "0")) : 0));
    return {
      address: addr,
      name: t.name,
      symbol: t.symbol,
      creator: t.creator,
      createdBlock: t.createdBlock,
      createdAt: at(t.createdBlock),
      graduated: !!t.graduated,
      venue: t.graduated ? "uniswap-v3" : "bonding-curve",
      priceUsd,
      priceWad: priceWad.toString(),
      // price x circulating supply: what screeners call market cap
      marketCapUsd: round(priceUsd * circulatingSupply, 2),
      // price x the tokens in wallets only, the Uniswap pool's inventory left out
      holderCapUsd: round(priceUsd * holderSupply, 2),
      // price x total supply (1B less anything burned): fully diluted value
      fdvUsd: round(priceUsd * totalSupply, 2),
      circulatingSupply: round(circulatingSupply, 6),
      holderSupply: round(holderSupply, 6),
      totalSupply: round(totalSupply, 6),
      burnedSupply: round(burned, 6),
      initialSupply: SUPPLY,
      // USDC actually sitting in the curve and withdrawable by sellers; the curve also carries
      // a virtual 4,000 USDC that sets the opening price and is not real money
      liquidityUsd: round(raisedUsd, 2),
      raisedUsd: round(raisedUsd, 2),
      raisedWei: String(t.raised || "0"),
      graduationTargetUsd: gradTarget,
      graduationProgressPct: gradTarget ? round(Math.min(100, (raisedUsd / gradTarget) * 100), 2) : null,
      volumeUsd24h: round(num(d.vol), 2),
      volumeUsdAll: round(num(BigInt(a.volAll || "0")), 2),
      trades24h: d.trades,
      tradesAll: a.trades || 0,
      holders,
      lastTradeAt: lastBlock ? at(lastBlock) : null,
      priceChangePct: { m5: back(300), h1: back(3600), h24: back(86_400) },
      buyFeeBps: Number(FEE_BPS),
      sellFeeBps: Number(FEE_BPS),
      metadataURI: t.metadataURI || null,
      imageUrl: `${SITE}/t/${addr}/card.jpg`,
      url: `${SITE}/#t=${addr}`,
      shareUrl: `${SITE}/t/${addr}/`,
      explorerUrl: `https://explorer.arc.io/address/${addr}`,
    };
  });
}

function meta(floor) {
  const bt = Number(floor.blockTimeSec) || 0.5;
  const gradUsd = num(BigInt(floor.gradTarget || "0"));
  return {
    platform: "A NEW ONE",
    url: SITE,
    docs: `${SITE}/api/basedbot`,
    source: "https://github.com/izzetcakmak/anewone",
    chain: { name: "Arc", chainId: 5042, explorer: "https://explorer.arc.io" },
    quote: {
      symbol: "USDC",
      native: true,
      nativeDecimals: 18,
      erc20: "0x3600000000000000000000000000000000000000",
      erc20Decimals: 6,
      note: "USDC is Arc's native currency: prices, gas and fees are all dollars",
    },
    contract: floor.platform,
    mechanics: {
      model: "constant product bonding curve priced in USDC",
      initialSupply: SUPPLY,
      virtualUsdc: 4000,
      tradeFeeBps: Number(FEE_BPS),
      creatorShareOfFeeBps: 50,
      graduationRaisedUsd: num(BigInt(floor.gradTarget || "0")),
      graduationVenue: "full range Uniswap v3 1% pool, liquidity locked permanently",
    },
    events: {
      TokenCreated: "TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI)",
      TokenImage: "TokenImage(address indexed token, string imageURI)",
      Trade: "Trade(address indexed token, address indexed trader, bool indexed isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 newPriceWad)",
      Graduated: "Graduated(address indexed token, uint256 raised)",
      Migrated: "Migrated(address indexed token, address indexed pool, uint256 positionId, uint256 tokensToPool, uint256 usdcToPool, uint128 liquidity, uint256 tokensBurned)",
      note: "Trade.usdcAmount is trader centric: fee included on a buy, fee deducted on a sell. Convert to the curve side (buy x 0.985, sell / 0.985) before summing it as volume. Every field in this API is already converted.",
    },
    // What a terminal needs to trade a coin still on its curve, since this API only reads.
    // Every line here is the contract's own behaviour (src/ANewOne.sol), not a policy of ours.
    trading: {
      note: "this API only reads. A trade is a transaction from the trader's own wallet straight to the platform contract (contract, above): nothing to register, and no caller is refused for being a bot or a contract",
      abi: [
        "function buy(address token, uint256 minTokensOut) payable",
        "function sell(address token, uint256 tokenAmount, uint256 minUsdcOut)",
        "function quoteBuy(address token, uint256 usdcIn) view returns (uint256 tokensOut)",
        "function quoteSell(address token, uint256 tokenAmount) view returns (uint256 usdcOut)",
        "function priceWad(address token) view returns (uint256)",
      ],
      units: "18 decimals on both sides: token amounts, and USDC as native value, so 1 USDC is 1e18 here, not 1e6 (see quote)",
      buy: "msg.value is the USDC to spend, the fee included, and no approval is needed; the coin goes to msg.sender",
      sell: "approve the platform contract on the coin first (a plain ERC-20; an allowance of 2^256-1 is never spent down). The USDC, fee deducted, is paid to msg.sender as native value, so a contract that sells needs a receive()",
      quotes: "quoteBuy takes what buy's msg.value would be, quoteSell a token amount; both count the fee and give exactly what the trade would at the same block. priceWad is the spot price every coin here carries",
      slippage: "minTokensOut and minUsdcOut are the only guard and there is no deadline: set them from a fresh quote less your tolerance",
      antiSnipe: {
        blocks: ANTI_SNIPE_BLOCKS,
        maxTokensPerWallet: ANTI_SNIPE_MAX,
        note: `from a coin's createdBlock through ${ANTI_SNIPE_BLOCKS} blocks later (about ${Math.round(ANTI_SNIPE_BLOCKS * bt)} s) one wallet can buy at most ${ANTI_SNIPE_MAX.toLocaleString("en-US")} tokens, 2% of the supply; a buy past that reverts with 'anti-snipe cap'. Sells are never capped`,
      },
      lifecycle: `a coin trades on its curve until a buy lifts its raised USDC to ${gradUsd.toLocaleString("en-US")}; that buy fills in full and graduates it. The curve then closes: buy, sell and both quotes revert with 'graduated'. migrate() moves the coin into a full range Uniswap v3 pool against the ERC-20 USDC (quote.erc20, 6 decimals) at the 1% fee tier, and the Migrated event names the pool; from then on it trades there like any v3 pool. Should the move stall, the platform may reopen the curve an hour after graduation, and the quotes answer again`,
      reverts: {
        "unknown token": "not a coin of this platform (the quotes answer 0 instead)",
        graduated: "the curve is closed, see lifecycle",
        slippage: "the trade would pay less than minTokensOut or minUsdcOut, or nothing at all",
        "anti-snipe cap": "past a wallet's early limit, see antiSnipe",
        "no value": "a buy sent without USDC",
        "no amount": "a sell of 0 tokens",
        allowance: "a sell without enough approval, from the coin's own transferFrom",
        balance: "a sell of more tokens than the wallet holds, from the coin's own transferFrom",
        send: "the USDC could not be paid to msg.sender: a contract without receive()",
      },
    },
    endpoints: [
      "GET /api/basedbot                                  this document",
      "GET /api/basedbot/tokens?limit=100&sort=volume24h   every coin, newest index",
      "GET /api/basedbot/{address}                         one coin, with distribution and last trades",
      "GET /api/basedbot/trades?address={a}&limit=100      trades in the last 24h, newest first",
      "GET /api/basedbot/candles?address={a}&tf=5m         OHLCV, tf one of " + Object.keys(TFS).join(", "),
      "GET /api/basedbot/distribution?address={a}          holder count and concentration",
    ],
    privacy: "no wallet is named: holders come back as a count and concentration shares, trades as sides and sizes. Every trade is in the Trade event on chain if you index it yourself.",
    sorts: ["volume24h", "volumeAll", "marketCap", "fdv", "liquidity", "trades24h", "holders", "age", "created"],
    supply: "fdvUsd = price x totalSupply, where totalSupply is 1B minus what migration burned. marketCapUsd = price x circulatingSupply: before migration the curve's unsold reserve is left out; after it, everything not burned circulates, the Uniswap pool's inventory included. holderCapUsd = price x holderSupply, the tokens in wallets only (circulating less the pool's inventory).",
    untrusted: "name, symbol and metadataURI are whatever the coin's creator wrote on chain: escape them before rendering, and check metadataURI's scheme before following it",
    freshness: {
      // FLOOR_REFRESH_MS in monitor/scan.mjs: the scanner runs every minute, but rebuilds the
      // index at most this often, and publishes it only when a chain event or a coin landed
      publishedEverySec: 1800,
      cachedSec: CACHE_S,
      note: "indexed from chain by our scanner at most every 30 minutes and published only when something changed, so in quiet hours updatedAt can be older than that; updatedAt and blockHeight on every response",
    },
    rateLimit: { perIpPerMinute: RATE },
    contact: { x: "https://x.com/anewone_xyz" },
  };
}

const envelope = (floor, extra) => ({
  updatedAt: Math.floor(new Date(floor.generatedAt).getTime() / 1000),
  blockHeight: floor.tip,
  chainId: 5042,
  ...extra,
});

function tradesOf(floor, addr, limit) {
  const { at } = clock(floor);
  const rows = ((floor.index || {}).recent || [])
    .filter((r) => !addr || r.tk === addr)
    .slice()
    .sort((x, y) => y.b - x.b)
    .slice(0, limit);
  return rows.map((r) => ({
    token: r.tk,
    side: r.buy ? "buy" : "sell",
    block: r.b,
    time: at(r.b),
    usdcPaidOrReceived: round(num(BigInt(r.u)), 6),
    volumeUsd: round(num(curveSide(BigInt(r.u), !!r.buy)), 6),
    tokenAmount: round(num(BigInt(r.t)), 6),
  }));
}

/**
 * How the supply is spread, without naming anyone: a count, the largest holders' shares and the
 * creator's own share, which is the one thing a screener really wants to flag.
 */
function distributionOf(floor, addr) {
  const m = ((floor.index || {}).net || {})[addr] || {};
  const creator = ((floor.tokens || []).find((t) => t.addr === addr) || {}).creator;
  const share = (bal) => round((num(bal) / SUPPLY) * 100, 4);
  const bals = Object.entries(m)
    .map(([wallet, h]) => ({ wallet, bal: BigInt(h.t) }))
    .filter((h) => h.bal > 0n)
    .sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0));
  const sum = (n) => bals.slice(0, n).reduce((a, h) => a + h.bal, 0n);
  const mine = bals.find((h) => h.wallet === creator);
  return {
    holders: bals.length,
    topHolderPct: bals.length ? share(bals[0].bal) : 0,
    top5Pct: share(sum(5)),
    top10Pct: share(sum(10)),
    creatorPct: mine ? share(mine.bal) : 0,
    curveHeldPct: round(100 - share(sum(bals.length)), 4),
    note: "shares of total supply; no wallet is named by this API",
  };
}

function candlesOf(floor, addr, tfSec, limit) {
  const { at } = clock(floor);
  const series = ((floor.index || {}).series || {})[addr] || [];
  const out = [];
  for (const x of series) {
    const p = num(BigInt(x.p));
    const v = num(BigInt(x.u || "0"));
    const t = Math.floor(at(x.b) / tfSec) * tfSec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, p);
      last.low = Math.min(last.low, p);
      last.close = p;
      last.volumeUsd += v;
      last.trades++;
    } else {
      // a bucket opens where the last one closed, so the wick has to cover that too
      const open = last ? last.close : p;
      out.push({ time: t, open, high: Math.max(open, p), low: Math.min(open, p), close: p, volumeUsd: v, trades: 1 });
    }
  }
  return out.slice(-limit).map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volumeUsd: round(c.volumeUsd, 6),
    trades: c.trades,
  }));
}

async function serve(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ error: "GET only" });
  }
  if (await tooMany(req, res, "basedbot", RATE)) return;
  res.setHeader("Cache-Control", `public, s-maxage=${CACHE_S}, stale-while-revalidate=60`);

  const u = new URL(req.url, "https://anewone.xyz");
  const parts = u.pathname.replace(/^\/api\/basedbot\/?/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  const q = u.searchParams;
  const clamp = (name, def, max) => {
    const n = Number.parseInt(q.get(name) || "", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
  };
  const addrOf = (i) => {
    const a = (parts[i] || q.get("address") || q.get("token") || "").toLowerCase();
    return isAddr(a) ? a : null;
  };
  // whether the request names an address at all: a malformed one is an error, never a request
  // for every coin
  const named = (i) => !!(parts[i] || q.get("address") || q.get("token"));
  const badAddr = (i) => ({ error: named(i) ? "address must be a 0x address" : "address required" });

  let floor;
  try { floor = await loadFloor(); } catch (e) {
    // what went wrong is for the function log; the caller only needs to know to retry
    console.error("basedbot: index unavailable:", e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "index unavailable, try again shortly" });
  }
  const known = (a) => (floor.tokens || []).some((t) => t.addr === a);

  const route = (parts[0] || "").toLowerCase();

  if (!route) return res.status(200).json(envelope(floor, meta(floor)));

  // A serverless catch-all routes exactly one segment on this project: /api/basedbot/token/0x...
  // answers Vercel's own 404, never this handler. So an address IS a route, and every endpoint
  // also takes ?address= .
  if (route === "tokens" || route === "token" || route === "coins" || isAddr(route)) {
    const one = isAddr(route) ? route : addrOf(1);
    if (!one && named(1)) return res.status(400).json(badAddr(1));
    const all = shape(floor);
    if (one) {
      const t = all.find((x) => x.address === one);
      if (!t) return res.status(404).json({ error: NO_COIN });
      return res.status(200).json(envelope(floor, {
        token: t,
        distribution: distributionOf(floor, one),
        trades: tradesOf(floor, one, clamp("trades", 20, 200)),
      }));
    }
    const graduated = q.get("graduated");
    const search = (q.get("q") || "").trim().toLowerCase();
    let rows = all;
    if (graduated === "true") rows = rows.filter((t) => t.graduated);
    if (graduated === "false") rows = rows.filter((t) => !t.graduated);
    if (search) rows = rows.filter((t) => (t.name + " " + t.symbol).toLowerCase().includes(search));
    const sorts = {
      volume24h: (t) => t.volumeUsd24h,
      volumeall: (t) => t.volumeUsdAll,
      marketcap: (t) => t.marketCapUsd,
      fdv: (t) => t.fdvUsd,
      liquidity: (t) => t.liquidityUsd,
      trades24h: (t) => t.trades24h,
      holders: (t) => t.holders,
      created: (t) => t.createdAt,
      age: (t) => -t.createdAt,
    };
    // own keys only: a plain lookup hands "__proto__" Object.prototype, which the sort then
    // calls as a function and crashes on
    const s = (q.get("sort") || "").toLowerCase();
    const key = Object.hasOwn(sorts, s) ? sorts[s] : sorts.volume24h;
    rows = rows.slice().sort((a, b) => key(b) - key(a));
    return res.status(200).json(envelope(floor, { count: rows.length, tokens: rows.slice(0, clamp("limit", 100, MAX_LIST)) }));
  }

  if (route === "trades") {
    const a = addrOf(1);
    if (named(1) && !a) return res.status(400).json(badAddr(1));
    if (a && !known(a)) return res.status(404).json({ error: NO_COIN });
    return res.status(200).json(envelope(floor, {
      token: a,
      windowHours: 24,
      trades: tradesOf(floor, a, clamp("limit", 100, MAX_TRADES)),
    }));
  }

  if (route === "distribution" || route === "holders") {
    const a = addrOf(1);
    if (!a) return res.status(400).json(badAddr(1));
    if (!known(a)) return res.status(404).json({ error: NO_COIN });
    return res.status(200).json(envelope(floor, { token: a, distribution: distributionOf(floor, a) }));
  }

  if (route === "candles" || route === "ohlcv") {
    const a = addrOf(1);
    if (!a) return res.status(400).json(badAddr(1));
    if (!known(a)) return res.status(404).json({ error: NO_COIN });
    const tf = (q.get("tf") || q.get("interval") || "5m").toLowerCase();
    // own keys only, as with sort: "__proto__" or "constructor" would pass and bucket by NaN
    if (!Object.hasOwn(TFS, tf)) return res.status(400).json({ error: "tf must be one of " + Object.keys(TFS).join(", ") });
    return res.status(200).json(envelope(floor, {
      token: a,
      tf,
      note: "built from the indexed price points of this curve, at most 600 per coin",
      candles: candlesOf(floor, a, TFS[tf], clamp("limit", 500, MAX_CANDLES)),
    }));
  }

  return res.status(404).json({ error: "unknown endpoint", endpoints: meta(floor).endpoints });
}

export default async function handler(req, res) {
  try {
    return await serve(req, res);
  } catch (e) {
    // a bug or a malformed index, never the caller's doing: the details go to the function log,
    // the caller gets a plain 500 that no cache keeps
    console.error("basedbot:", e);
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "internal error" });
  }
}
