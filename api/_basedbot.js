// Public read-only index API for A NEW ONE, shaped for trading terminals and screeners
// (basedbot.app asked for nothing; this is what a terminal needs to list a launchpad).
//
// Everything here is already public: it is derived from data/floor.json, the same on-chain
// index the floor itself reads, which the scanner republishes every minute. Nothing is signed,
// nothing is private, and no caller is identified. GET only, CORS open, cached at the edge for
// CACHE_S seconds so a busy terminal costs one origin read per window.
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
import { tooMany } from "./_ratelimit.js";

const SITE = "https://anewone.xyz";
const FLOOR_URL = `${SITE}/data/floor.json`;
const CACHE_S = 15; // edge + in-instance
const RATE = 240; // requests per IP per minute; a terminal polling every 5s needs 12
const WAD = 10n ** 18n;
const BPS = 10_000n;
const FEE_BPS = 150n; // 1.5% trade fee, of which a third goes to the coin's creator
const SUPPLY = 1_000_000_000; // every coin on this platform has the same fixed supply
const DAY_BLOCKS = 172_800;
const MAX_LIST = 500;
const MAX_TRADES = 1000;
const MAX_CANDLES = 1000;
const TFS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };

/** The curve-side USDC of a trade: a buy paid the fee on top, a sell had it deducted. */
const curveSide = (u, isBuy) => (isBuy ? (u * (BPS - FEE_BPS)) / BPS : (u * BPS) / (BPS - FEE_BPS));

const num = (wei, dp = 18) => Number(wei) / 10 ** dp;
const round = (x, dp) => (Number.isFinite(x) ? Number(x.toFixed(dp)) : 0);
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

let cache = { at: 0, floor: null };

async function loadFloor() {
  if (cache.floor && Date.now() - cache.at < CACHE_S * 1000) return cache.floor;
  const r = await fetch(FLOOR_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("index unavailable (" + r.status + ")");
  const floor = await r.json();
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
      marketCapUsd: round(priceUsd * SUPPLY, 2),
      totalSupply: SUPPLY,
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
      totalSupply: SUPPLY,
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
    endpoints: [
      "GET /api/basedbot                                  this document",
      "GET /api/basedbot/tokens?limit=100&sort=volume24h   every coin, newest index",
      "GET /api/basedbot/token/{address}                   one coin, with distribution and last trades",
      "GET /api/basedbot/trades?address={a}&limit=100      trades in the last 24h, newest first",
      "GET /api/basedbot/candles?address={a}&tf=5m         OHLCV, tf one of " + Object.keys(TFS).join(", "),
      "GET /api/basedbot/distribution?address={a}          holder count and concentration",
    ],
    privacy: "no wallet is named: holders come back as a count and concentration shares, trades as sides and sizes. Every trade is in the Trade event on chain if you index it yourself.",
    sorts: ["volume24h", "volumeAll", "marketCap", "liquidity", "trades24h", "holders", "age", "created"],
    freshness: {
      publishedEverySec: 60,
      cachedSec: CACHE_S,
      note: "indexed from chain by our scanner; updatedAt and blockHeight on every response",
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

export default async function handler(req, res) {
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

  let floor;
  try { floor = await loadFloor(); } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: String((e && e.message) || e) });
  }

  const route = (parts[0] || "").toLowerCase();

  if (!route) return res.status(200).json(envelope(floor, meta(floor)));

  if (route === "tokens" || route === "token" || route === "coins") {
    const one = addrOf(1);
    const all = shape(floor);
    if (one) {
      const t = all.find((x) => x.address === one);
      if (!t) return res.status(404).json({ error: "no coin at that address on this platform" });
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
    const key = {
      volume24h: (t) => t.volumeUsd24h,
      volumeall: (t) => t.volumeUsdAll,
      marketcap: (t) => t.marketCapUsd,
      liquidity: (t) => t.liquidityUsd,
      trades24h: (t) => t.trades24h,
      holders: (t) => t.holders,
      created: (t) => t.createdAt,
      age: (t) => -t.createdAt,
    }[(q.get("sort") || "volume24h").toLowerCase()];
    rows = rows.slice().sort((a, b) => (key ? key(b) - key(a) : b.volumeUsd24h - a.volumeUsd24h));
    return res.status(200).json(envelope(floor, { count: rows.length, tokens: rows.slice(0, clamp("limit", 100, MAX_LIST)) }));
  }

  if (route === "trades") {
    const a = addrOf(1);
    if (parts[1] && !a) return res.status(400).json({ error: "address must be a 0x address" });
    return res.status(200).json(envelope(floor, {
      token: a,
      windowHours: 24,
      trades: tradesOf(floor, a, clamp("limit", 100, MAX_TRADES)),
    }));
  }

  if (route === "distribution" || route === "holders") {
    const a = addrOf(1);
    if (!a) return res.status(400).json({ error: "address required" });
    return res.status(200).json(envelope(floor, { token: a, distribution: distributionOf(floor, a) }));
  }

  if (route === "candles" || route === "ohlcv") {
    const a = addrOf(1);
    if (!a) return res.status(400).json({ error: "address required" });
    const tf = (q.get("tf") || q.get("interval") || "5m").toLowerCase();
    if (!TFS[tf]) return res.status(400).json({ error: "tf must be one of " + Object.keys(TFS).join(", ") });
    return res.status(200).json(envelope(floor, {
      token: a,
      tf,
      note: "built from the indexed price points of this curve, at most 600 per coin",
      candles: candlesOf(floor, a, TFS[tf], clamp("limit", 500, MAX_CANDLES)),
    }));
  }

  return res.status(404).json({ error: "unknown endpoint", endpoints: meta(floor).endpoints });
}
