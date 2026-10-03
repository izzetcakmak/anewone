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
// fee. A migrated coin's pool swaps are counted the same way, on the pool's side: the USDC that
// crossed its reserve, so a buy less the 1% pool fee and a sell as paid out.
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
/** The pool-side USDC of a swap: v3 takes its 1% from the input, so off a buy's USDC only. */
const POOL_FEE_BPS = 100n;
const poolSide = (u, isBuy) => (isBuy ? (u * (BPS - POOL_FEE_BPS)) / BPS : u);
const DAY_BUCKET = 600; // the scanner keeps a pool's 24h volume in buckets of this many blocks

/**
 * A migrated coin's pool swaps as the index read them (index.pool, written by the scanner from
 * the coin's Migrated log on), or null: for a coin on its curve, or an entry for another pool.
 */
function poolOf(floor, t) {
  const e = t && t.migrated ? ((floor.index || {}).pool || {})[t.addr] : null;
  return e && e.pool === t.pool && Array.isArray(e.recent) && Array.isArray(e.series) && Array.isArray(e.day) ? e : null;
}
/**
 * A coin's price points, the curve's, then its pool's as indexed, then the live swaps since, in
 * block order. When the scanner has dropped the pool's oldest points, the first one kept is
 * marked `gap`: nothing is known between the curve's last point and it, so no candle or price
 * change may bridge the two.
 */
function seriesOf(floor, t, tailSwaps = []) {
  const curve = ((floor.index || {}).series || {})[t.addr] || [];
  const px = poolOf(floor, t);
  if (!px) return curve;
  const pool = px.series.map((x, i) => (i === 0 && px.trimmed ? { ...x, gap: true } : x));
  const live = tailSwaps.map((s) => ({ b: s.b, p: s.p.toString(), u: poolSide(s.u, s.buy).toString() }));
  return [...curve, ...pool, ...live].sort((x, y) => x.b - y.b);
}
/** Whether an answer about this coin reads the chain live: only a migrated coin's does. */
const needsLive = (floor, addr) => !!addr && (floor.tokens || []).some((x) => x.addr === addr && x.migrated);
const migratedAny = (floor) => (floor.tokens || []).some((x) => x.migrated);
/** The scanner's holder figures for a coin (index.hold, from Transfer logs), or null before its first full read. */
function holdOf(floor, addr) {
  const x = (((floor.index || {}).hold || {}).coins || {})[addr];
  return x && Number.isFinite(x.holders) && Array.isArray(x.top) ? x : null;
}

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

// ---------------------------------------------------------------- live pool reads
// A migrated coin trades in its Uniswap v3 pool, which the index does not follow: a swap there
// leaves no log on the platform, and the index publishes every half hour at best. So a
// migrated coin's price and pool balances are read from the pool itself, live, in one batch
// per CACHE_S window. Only migrated coins are read: until the first migration this makes no
// call at all. The upstreams are the ones api/rpc.js relays to.
const ARC_RPCS = ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"];
const USDC_ERC20 = "0x3600000000000000000000000000000000000000"; // a pool's other side, 6 decimals
const SEL_SLOT0 = "0x3850c7bd";
const SEL_BALANCE_OF = "0x70a08231";
const Q192 = 1n << 192n;
const E30 = 10n ** 30n; // 1e12 from USDC's 6 decimals up to the token's 18, and 1e18 for the wad
const BURN = "0x000000000000000000000000000000000000dead"; // migrate() and collectPoolFees() burn here
// The public Arc RPC throttles at about 20 calls a burst per IP, batch entries each counted, and
// answers the excess 200 with per-call errors: batches of 20, one after another.
const BATCH = 20;
const LIVE_WAIT_MS = 3000; // the longest a request waits on a pool refresh
// The swaps since the index last read the pools (see livePools): Uniswap v3 Swap logs, read on
// from where this instance got to, a few windows a refresh.
const TOPIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const TAIL_CHUNK = 9_999; // blocks per getLogs, the public RPC's cap
const TAIL_CHUNKS = 3; // per refresh: a cold instance behind an old index catches up over a few
const TAIL_LAG = 2; // blocks left at the chain's edge, where a load-balanced node may lag behind
const TAIL_MIN_WIN = 500; // the smallest window a refused one is cut down to
const TAIL_MAX = 20_000; // swaps held per coin; only a scanner down for days on a busy pool gets near
const LIVE_NONE = { prices: {}, tail: null };

const big = (x) => { try { return BigInt(x); } catch { return null; } };
const word0 = (hex) => (typeof hex === "string" && /^0x[0-9a-fA-F]{64}/.test(hex) ? BigInt(hex.slice(0, 66)) : null);
const pad32 = (a) => a.slice(2).toLowerCase().padStart(64, "0");
// a pool sorts its two tokens by address, and USDC's is 0x36...: most coins sort first
const tokenIsZero = (addr) => addr.toLowerCase() < USDC_ERC20;

/**
 * priceWad, the curve's unit (USDC per whole token, x1e18), from a pool's sqrtPriceX96. The pool
 * prices token1 in token0 in raw units: USDC units per token wei when the coin sorts first,
 * token wei per USDC unit when it sorts second. null for a pool nobody has initialised.
 */
function poolPriceWad(sqrtPriceX96, zero) {
  const s2 = sqrtPriceX96 * sqrtPriceX96;
  if (s2 === 0n) return null;
  return zero ? (s2 * E30) / Q192 : (Q192 * E30) / s2;
}

const toInt256 = (h) => { const x = BigInt("0x" + h); return x >= 1n << 255n ? x - (1n << 256n) : x; };
/**
 * One Uniswap v3 Swap log as { b, i, u, t, buy, p }, the scanner's units (monitor/floor.mjs
 * decodeSwap): u the trader's USDC in 18 decimals, t the coin, p the price after it. null when it
 * does not decode or moved nothing.
 */
function decodeSwapLog(lg, zero) {
  try {
    const d = lg.data.slice(2);
    const a0 = toInt256(d.slice(0, 64)), a1 = toInt256(d.slice(64, 128)), s = BigInt("0x" + d.slice(128, 192));
    const coin = zero ? a0 : a1, usdc = zero ? a1 : a0; // positive: the pool received it
    const p = poolPriceWad(s, zero);
    if ((coin === 0n && usdc === 0n) || p === null) return null;
    return { b: Number(BigInt(lg.blockNumber)), i: Number(BigInt(lg.logIndex ?? "0x0")), u: (usdc < 0n ? -usdc : usdc) * 10n ** 12n, t: coin < 0n ? -coin : coin, buy: coin < 0n, p };
  } catch { return null; }
}

// A revert is an answer; a missing entry or any other error (a throttle, a timeout) is not.
const answered = (x) => !!x && (x.result !== undefined || (!!x.error && (x.error.code === 3 || /revert/i.test(x.error.message || ""))));
let preferred = 0; // the upstream that last answered in full is asked first

/** One JSON-RPC batch, from the first upstream that answers all of it; results in the order asked. */
async function rpcBatch(calls) {
  let last = "no upstream";
  for (let k = 0; k < ARC_RPCS.length; k++) {
    const i = (preferred + k) % ARC_RPCS.length, url = ARC_RPCS[i];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls), signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      if (!Array.isArray(j)) { last = `${url}: ${r.status}`; continue; }
      const byId = new Map(j.map((x) => [x && x.id, x]));
      const out = calls.map((c) => byId.get(c.id));
      const missed = out.filter((x) => !answered(x));
      if (missed.length) { last = `${url}: ${missed.length}/${calls.length} unanswered (${(missed.find(Boolean) || {}).error?.message || "missing"})`; continue; }
      preferred = i;
      return out;
    } catch (e) { last = `${url}: ${(e && e.message) || e}`; }
  }
  throw new Error("pool read: " + last);
}

let pools = { at: 0, key: "", data: {}, tail: null };
let poolsInflight = null;

/**
 * What the chain says now about migrated coins, beyond the index:
 * - prices: address -> { pool, priceWad, inPool, usdcInPool, burned, at } per coin, `at` being
 *   when that pool was read. A coin whose read fails this time keeps its last live read, with its
 *   own date, and shape() takes whichever of that and the index's read is newer.
 * - tail: { hi, byCoin } the pools' swaps after the index last read them, up to block hi, so a
 *   migrated coin's volume, tape and candles are as live as its price. Read on from where this
 *   instance got to; an index that reaches further (a new deployment) starts it over from there.
 * A failure is kept for the window too, so a dead RPC is not asked on every request.
 */
async function livePools(floor) {
  const coins = (floor.tokens || []).filter((t) => t.migrated && isAddr(t.pool) && isAddr(t.addr));
  if (!coins.length) return LIVE_NONE;
  const key = coins.map((t) => t.addr + t.pool).join();
  if (pools.key === key && Date.now() - pools.at < CACHE_S * 1000) return { prices: pools.data, tail: pools.tail };
  if (poolsInflight && poolsInflight.key === key) return poolsInflight.run;
  const N = 4; // calls per coin; BATCH is a multiple, so a coin's calls share one batch
  // Only the latest refresh may write the cache or clear the in-flight mark: one for a set of
  // coins that has since changed must not undo the one for the set that replaced it.
  const me = { key, run: null };
  poolsInflight = me;
  me.run = (async () => {
    const calls = coins.flatMap((t, i) => {
      const p = pad32(t.pool);
      const call = (j, to, data) => ({ jsonrpc: "2.0", id: N * i + j, method: "eth_call", params: [{ to, data }, "latest"] });
      return [
        call(0, t.pool, SEL_SLOT0),
        call(1, t.addr, SEL_BALANCE_OF + p), // the coin in the pool
        call(2, USDC_ERC20, SEL_BALANCE_OF + p), // the USDC in the pool
        call(3, t.addr, SEL_BALANCE_OF + pad32(BURN)), // burned: the pool's fees burn as it trades
      ];
    });
    // each answer is dated by its own batch: a slow batch after it must not make it look newer
    const out = [], when = [];
    for (let k = 0; k < calls.length; k += BATCH) {
      const chunk = calls.slice(k, k + BATCH);
      try { out.push(...(await rpcBatch(chunk))); } catch (e) {
        console.warn("basedbot:", e.message);
        out.push(...chunk.map(() => undefined));
      }
      when.push(...chunk.map(() => Math.floor(Date.now() / 1000)));
    }
    const prev = pools.data, data = {};
    coins.forEach((t, i) => {
      const [s, inPool, usdcInPool, burned] = [0, 1, 2, 3].map((j) => word0(out[N * i + j] && out[N * i + j].result));
      const priceWad = s === null ? null : poolPriceWad(s, tokenIsZero(t.addr));
      if (priceWad !== null && inPool !== null && usdcInPool !== null && burned !== null) {
        data[t.addr] = { pool: t.pool, priceWad, inPool, usdcInPool, burned, at: when[N * i] };
      } else if (prev[t.addr] && prev[t.addr].pool === t.pool) {
        data[t.addr] = prev[t.addr];
      }
    });
    // The prices are kept as soon as they are read: a request that stops waiting on the swaps
    // below (livePoolsBounded) is answered with these, not the last window's.
    if (poolsInflight === me) pools = { at: Date.now(), key, data, tail: pools.key === key ? pools.tail : null };

    // The swaps since the index: from the lowest block any of these pools was indexed to, a
    // window at a time. A window an upstream refuses or times out on is halved for the next try,
    // and grows back once one answers. Past TAIL_MAX swaps for a coin the read stops rather than
    // drop the oldest: what is served stays whole up to where it got, and says so (tail.hi).
    const reach = Math.min(...coins.map((t) => { const px = poolOf(floor, t); return px ? px.hi : floor.tip; }));
    const tkey = `${key}@${reach}`;
    const was = pools.tail && pools.tail.key === tkey ? pools.tail : null;
    const tail = { key: tkey, hi: was ? was.hi : reach, win: was ? was.win : TAIL_CHUNK, byCoin: was ? { ...was.byCoin } : {} };
    try {
      const [bn] = await rpcBatch([{ jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] }]);
      const edge = Number(BigInt(bn.result)) - TAIL_LAG;
      const byPool = new Map(coins.map((t) => [t.pool.toLowerCase(), t]));
      for (let n = 0; tail.hi < edge && n < TAIL_CHUNKS; n++) {
        const to = Math.min(edge, tail.hi + tail.win);
        let lg;
        try {
          [lg] = await rpcBatch([{ jsonrpc: "2.0", id: 0, method: "eth_getLogs", params: [{
            address: coins.map((t) => t.pool), topics: [TOPIC_SWAP], fromBlock: "0x" + (tail.hi + 1).toString(16), toBlock: "0x" + to.toString(16),
          }] }]);
          if (!Array.isArray(lg.result)) throw new Error("getLogs answered no list");
        } catch (e) {
          tail.win = Math.max(TAIL_MIN_WIN, Math.floor(tail.win / 2));
          throw e;
        }
        const got = {};
        for (const l of lg.result) {
          const t = byPool.get(String(l.address).toLowerCase());
          const s = t && decodeSwapLog(l, tokenIsZero(t.addr));
          if (s) (got[t.addr] = got[t.addr] || []).push(s);
        }
        if (Object.entries(got).some(([a, list]) => (tail.byCoin[a] || []).length + list.length > TAIL_MAX)) {
          console.warn(`basedbot: pool swaps: over ${TAIL_MAX} for a coin since the index; the live read stops at block ${tail.hi} until a newer index`);
          break;
        }
        for (const [a, list] of Object.entries(got)) {
          tail.byCoin[a] = [...(tail.byCoin[a] || []), ...list.sort((x, y) => x.b - y.b || x.i - y.i)];
        }
        tail.hi = to;
        tail.win = Math.min(TAIL_CHUNK, tail.win * 2);
      }
    } catch (e) {
      console.warn("basedbot: pool swaps:", e.message);
    }
    if (poolsInflight === me) pools = { ...pools, tail };
    return { prices: data, tail };
  })().finally(() => { if (poolsInflight === me) poolsInflight = null; });
  return me.run;
}

/**
 * livePools, but a request waits at most LIVE_WAIT_MS on it: past that it is answered from the
 * last reads, each dated by its priceAt, and the refresh carries on for the requests after it.
 */
async function livePoolsBounded(floor) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ prices: pools.data, tail: pools.tail }), LIVE_WAIT_MS); });
  try { return await Promise.race([livePools(floor), late]); } finally { clearTimeout(timer); }
}

/** A migrated coin's swaps after its index entry reached (px.hi), from the live tail. */
function tailOf(live, t, px) {
  if (!px || !live || !live.tail) return { swaps: [], hi: px ? px.hi : 0 };
  return { swaps: (live.tail.byCoin[t.addr] || []).filter((s) => s.b > px.hi), hi: Math.max(px.hi, live.tail.hi) };
}

/** Block number to unix seconds, from the index's tip and measured block time. */
function clock(floor) {
  const genSec = Math.floor(new Date(floor.generatedAt).getTime() / 1000);
  const bt = Number(floor.blockTimeSec) || 1;
  return { at: (b) => Math.round(genSec - (floor.tip - b) * bt), bt, genSec };
}

/** Everything the list and the single-coin view need, per coin, in one pass. */
function shape(floor, live = LIVE_NONE) {
  const ix = floor.index || {};
  const { at, bt, genSec } = clock(floor);
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
  /**
   * A migrated coin's day, measured back from as far as its pool is known, which the live tail
   * carries past the index: its curve trades in that window, the scanner's 5-minute buckets of
   * pool swaps (one that reaches into the window counts, so the far edge is exact to the bucket),
   * and the swaps since. All on the curve's or the pool's side.
   */
  const poolDay = (t, px, tl) => {
    const from = tl.hi - DAY_BLOCKS, d = { vol: 0n, trades: 0, last: 0 };
    for (const r of ix.recent || []) {
      if (r.tk !== t.addr || r.b < from) continue;
      d.vol += curveSide(BigInt(r.u), !!r.buy); d.trades++; if (r.b > d.last) d.last = r.b;
    }
    for (const [b, v, n] of px.day) if (b + DAY_BUCKET > from) { d.vol += big(v) ?? 0n; d.trades += Number(n) || 0; }
    for (const s of tl.swaps) if (s.b >= from) { d.vol += poolSide(s.u, s.buy); d.trades++; if (s.b > d.last) d.last = s.b; }
    return d;
  };

  return (floor.tokens || []).map((t) => {
    const addr = t.addr;
    // The curve's spot price as the index read it, unless the coin has moved into its pool:
    // then the pool's, from whichever read of it is newer, the live one or the index's, with
    // the balances and burn of that same read so the supply figures agree with each other. A
    // migrated coin whose pool was never read keeps the curve's last price, and says so.
    let priceWad = (BigInt(t.vUsdc) * WAD) / BigInt(t.tReserve);
    let priceSource = "bonding-curve", priceAt = genSec;
    let inPool = big(t.inPool || "0") ?? 0n, usdcInPool = null, burnedWei = big(t.burned || "0") ?? 0n;
    if (t.migrated) {
      const lv = live.prices[addr] && live.prices[addr].pool === t.pool ? live.prices[addr] : null;
      const ixSqrt = t.poolSqrtPriceX96 != null ? big(t.poolSqrtPriceX96) : null;
      const ixPrice = ixSqrt !== null ? poolPriceWad(ixSqrt, tokenIsZero(addr)) : null;
      const ixAt = Number.isFinite(t.poolReadAt) ? t.poolReadAt : genSec;
      if (lv && (ixPrice === null || lv.at >= ixAt)) {
        ({ priceWad, inPool, usdcInPool } = lv);
        burnedWei = lv.burned;
        priceSource = "uniswap-v3";
        priceAt = lv.at;
      } else if (ixPrice !== null) {
        priceWad = ixPrice;
        usdcInPool = t.poolUsdc != null ? big(t.poolUsdc) : null;
        priceSource = "uniswap-v3";
        priceAt = ixAt;
      }
    }
    const priceUsd = num(priceWad);
    const raisedUsd = num(BigInt(t.raised || "0"));
    const a = (ix.agg || {})[addr] || { volAll: "0", trades: 0, lastBlock: 0 };
    const px = poolOf(floor, t);
    const tl = tailOf(live, t, px); // a migrated coin's swaps since the index, and how far they reach
    const d = px ? poolDay(t, px, tl) : day[addr] || { vol: 0n, trades: 0, last: 0 };
    const curvePoints = (ix.series || {})[addr] || [];
    const series = seriesOf(floor, t, tl.swaps);
    const hd = holdOf(floor, addr);
    const holders = hd ? hd.holders : Object.values((ix.net || {})[addr] || {}).filter((h) => BigInt(h.t) > 0n).length;

    // The price `sec` before priceAt, from the last point at or before that block: the window
    // ends when the price was read, which for a live pool price is now, not the index tip. A
    // migrated coin's points reach as far as its pool is known (the index's px.hi, carried on by
    // the live tail), or without a pool index only to its last curve trade: a window that opens
    // past them is unknown here, not zero.
    const lastCurve = curvePoints.length ? curvePoints[curvePoints.length - 1].b : 0;
    const knownTo = !t.migrated ? Infinity : px ? tl.hi : lastCurve;
    // and when the pool's oldest points were dropped, nothing is known between the curve's last
    // point and the first pool point kept
    const gapTo = px && px.trimmed && px.series.length ? px.series[0].b : null;
    const back = (sec) => {
      const b = floor.tip - Math.round((genSec - priceAt + sec) / bt); // for priceAt = genSec, exactly tip - round(sec/bt)
      if (b > knownTo || (gapTo !== null && b > lastCurve && b < gapTo)) return null;
      let p = null;
      for (const x of series) { if (x.b > b) break; p = x.p; }
      if (p === null || BigInt(p) === 0n) return null;
      return round((priceUsd / num(BigInt(p)) - 1) * 100, 2);
    };

    const lastBlock = Math.max(a.lastBlock || 0, d.last || 0, (px && px.lastBlock) || 0, tl.swaps.length ? tl.swaps[tl.swaps.length - 1].b : 0);
    const volAllWei = BigInt(a.volAll || "0") + ((px && big(px.volAll)) || 0n) + tl.swaps.reduce((s, x) => s + poolSide(x.u, x.buy), 0n);
    const tradesAll = (a.trades || 0) + ((px && px.trades) || 0) + tl.swaps.length;
    // Supply as it is, not as it launched. On the curve the unsold tokens are the curve's own
    // (tReserve): nobody can trade them but the curve, so they are not circulating. After
    // migration the burned part is gone for good, and the pool's inventory is on the open
    // market, so it circulates like any pool's does. holderSupply leaves the pool out too.
    const burned = num(burnedWei);
    const totalSupply = SUPPLY - burned;
    const circulatingSupply = Math.max(0, t.migrated ? totalSupply : totalSupply - num(BigInt(t.tReserve)));
    const holderSupply = Math.max(0, circulatingSupply - (t.migrated ? num(inPool) : 0));
    // On the curve: the USDC actually sitting in it and withdrawable by sellers (the curve also
    // carries a virtual 4,000 USDC that sets the opening price and is not real money). In a
    // pool: its two balances at its price. null for a migrated coin whose pool was never read.
    const liquidityUsd = !t.migrated ? round(raisedUsd, 2)
      : usdcInPool !== null ? round(num(usdcInPool, 6) + num(inPool) * priceUsd, 2) : null;
    // Where it trades, as the contract's _curveOpen() decides: on the curve until graduation
    // and again while an owner has reopened it; in its Uniswap pool once migrated; and in
    // between nowhere, since this platform closes a curve at graduation. The flags come from
    // the index, which keeps the last known ones when a read fails; a graduated coin without
    // them reads as migrating, which sends nobody to a venue that may not trade.
    const curveOpen = !t.graduated || (!!t.reopened && !t.migrated);
    const venue = curveOpen ? "bonding-curve" : t.migrated ? "uniswap-v3" : "migrating";
    return {
      address: addr,
      name: t.name,
      symbol: t.symbol,
      creator: t.creator,
      createdBlock: t.createdBlock,
      createdAt: at(t.createdBlock),
      graduated: !!t.graduated,
      venue,
      poolAddress: t.migrated && isAddr(t.pool) ? t.pool.toLowerCase() : null,
      priceUsd,
      priceWad: priceWad.toString(),
      priceSource,
      priceAt,
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
      liquidityUsd,
      raisedUsd: round(raisedUsd, 2),
      raisedWei: String(t.raised || "0"),
      graduationTargetUsd: gradTarget,
      // a graduated coin is done, as the contract's progressBps() says: migrate() zeroes raised
      graduationProgressPct: t.graduated ? 100 : gradTarget ? round(Math.min(100, (raisedUsd / gradTarget) * 100), 2) : null,
      volumeUsd24h: round(num(d.vol), 2),
      volumeUsdAll: round(num(volAllWei), 2),
      trades24h: d.trades,
      tradesAll,
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
      Swap: "Uniswap v3 Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick), from a migrated coin's pool (poolAddress): its trading after the move. Counted as volume on the pool's side: a buy's USDC less the 1% pool fee, a sell's as paid out",
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
      quotes: "quoteBuy takes what buy's msg.value would be, quoteSell a token amount; both count the fee and give exactly what the trade would at the same block. The contract's priceWad() is the curve's spot price and stays frozen at the last curve price after migration; the priceWad each coin carries here follows its priceSource",
      slippage: "minTokensOut and minUsdcOut are the only guard and there is no deadline: set them from a fresh quote less your tolerance",
      antiSnipe: {
        blocks: ANTI_SNIPE_BLOCKS,
        maxTokensPerWallet: ANTI_SNIPE_MAX,
        note: `from a coin's createdBlock through ${ANTI_SNIPE_BLOCKS} blocks later (about ${Math.round(ANTI_SNIPE_BLOCKS * bt)} s) one wallet can buy at most ${ANTI_SNIPE_MAX.toLocaleString("en-US")} tokens, 2% of the supply; a buy past that reverts with 'anti-snipe cap'. Sells are never capped`,
      },
      lifecycle: `a coin trades on its curve until a buy lifts its raised USDC to ${gradUsd.toLocaleString("en-US")}; that buy fills in full and graduates it. The curve then closes: buy, sell and both quotes revert with 'graduated'. migrate() moves the coin into a full range Uniswap v3 pool against the ERC-20 USDC (quote.erc20, 6 decimals) at the 1% fee tier, and the Migrated event names the pool, as poolAddress does here; from then on it trades there like any v3 pool. Should the move stall, the platform may reopen the curve an hour after graduation, and the quotes answer again. venue says which of these a coin is in (see venues)`,
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
    venues: {
      "bonding-curve": "trades on its curve through the platform contract, see trading: not graduated yet, or graduated and reopened by the platform",
      migrating: "graduated and not yet moved: the curve takes no trades and the platform's liquidity is not in Uniswap yet. A pool at the address migrate() will use may already exist, opened by someone else at a price of their choosing; it is not this coin's venue until the move, which pulls its price back to the curve's. migrate() is open to anyone and our scanner sends it, so this usually passes within minutes; if the move cannot go through, the platform may reopen the curve an hour after graduation",
      "uniswap-v3": "trades in its Uniswap v3 pool (poolAddress) like any v3 pool; the curve is closed for good. Its price, caps and liquidity come from the pool (see price). Its volume, trade counts, lastTradeAt, the trades tape (venue on each trade) and candles add its pool swaps to its curve trades: those the index read and, read live like its price, those since, so its day runs as far as that live read has got (the chain's edge once an instance has caught up, a few windows a refresh behind an old index); priceChangePct is null for a window that opens past what is known. Holders and distribution count from its Transfer logs (see holders)",
      note: "venue is as fresh as the index (see freshness). For a coin on its curve, quoteBuy answers live: it reverts with 'graduated' once the curve has closed",
    },
    endpoints: [
      "GET /api/basedbot                                  this document",
      "GET /api/basedbot/tokens?limit=100&sort=volume24h   every coin, newest index",
      "GET /api/basedbot/{address}                         one coin, with distribution and last trades",
      "GET /api/basedbot/trades?address={a}&limit=100      trades in the last 24h, newest first, curve and pool",
      "GET /api/basedbot/candles?address={a}&tf=5m         OHLCV, tf one of " + Object.keys(TFS).join(", "),
      "GET /api/basedbot/distribution?address={a}          holder count and concentration",
    ],
    privacy: "no wallet is named: holders come back as a count and concentration shares, trades as sides and sizes. Every curve trade is in the platform's Trade event, and every swap of a migrated coin in its pool's Swap event, if you index them yourself.",
    holders: "holders and the distribution count from each coin's own Transfer logs, so curve trades, pool swaps and transfers between wallets all move them; the curve, burned coins and the coin's Uniswap v3 pools (the one it moved into, and any other on the platform's factory) are not holders, and shares are of the supply that exists (1B less burned); poolHeldPct is what those pools hold. They come with the index (see freshness). Until the scanner's first full read of those logs they count from curve trades alone, and distribution.note says which",
    sorts: ["volume24h", "volumeAll", "marketCap", "fdv", "liquidity", "trades24h", "holders", "age", "created"],
    price: `priceSource says where priceUsd and priceWad come from. 'bonding-curve': the curve's spot price, as the index read it. 'uniswap-v3': a migrated coin's pool price, read live from Arc and kept ${CACHE_S} s; when the chain does not answer, the newest earlier read, ours or the index's. priceAt is when that read was made, in unix seconds, and priceChangePct is measured back from it. The caps and supply of a migrated coin come from the same read, and its liquidityUsd is the pool's two balances at that price (null if the pool was never read)`,
    supply: "fdvUsd = price x totalSupply, where totalSupply is 1B minus everything burned: what migration burned, then the pool's token-side fees, which collectPoolFees() burns. marketCapUsd = price x circulatingSupply: before migration the curve's unsold reserve is left out; after it, everything not burned circulates, the Uniswap pool's inventory included. holderCapUsd = price x holderSupply, the tokens in wallets only (circulating less the pool's inventory).",
    untrusted: "name, symbol and metadataURI are whatever the coin's creator wrote on chain: escape them before rendering, and check metadataURI's scheme before following it",
    freshness: {
      // FLOOR_REFRESH_MS in monitor/scan.mjs: the scanner runs every minute, but rebuilds the
      // index at most this often, and publishes it only when a chain event or a coin landed
      publishedEverySec: 1800,
      cachedSec: CACHE_S,
      note: "indexed from chain by our scanner at most every 30 minutes and published only when something changed, so in quiet hours updatedAt can be older than that; updatedAt and blockHeight on every response. A migrated coin is live on top of the index: its pool price (see price), and its pool swaps since the index, which add to its volume, tape and candles",
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

function tradesOf(floor, addr, limit, live = LIVE_NONE) {
  const { at } = clock(floor);
  // a migrated coin's day runs back from as far as its pool is known, as in shape(): its curve
  // trades are cut there too, so the tape and trades24h cover the same window
  const dayFrom = {};
  for (const t of floor.tokens || []) { const px = poolOf(floor, t); if (px) dayFrom[t.addr] = tailOf(live, t, px).hi - DAY_BLOCKS; }
  const curve = ((floor.index || {}).recent || [])
    .filter((r) => (!addr || r.tk === addr) && !(r.b < (dayFrom[r.tk] ?? -Infinity)))
    .map((r) => ({ ...r, venue: "bonding-curve" }));
  // a migrated coin's swaps in its pool, the same tape: the indexed ones and the live ones since,
  // of the last 24h to as far as its pool is known
  const pool = (floor.tokens || [])
    .filter((t) => !addr || t.addr === addr)
    .flatMap((t) => {
      const px = poolOf(floor, t);
      if (!px) return [];
      const tl = tailOf(live, t, px), from = tl.hi - DAY_BLOCKS;
      return [...px.recent, ...tl.swaps.map((s) => ({ b: s.b, u: s.u.toString(), t: s.t.toString(), buy: s.buy }))]
        .filter((r) => r.b >= from).map((r) => ({ ...r, tk: t.addr, venue: "uniswap-v3" }));
    });
  const rows = [...curve, ...pool].sort((x, y) => y.b - x.b).slice(0, limit);
  return rows.map((r) => ({
    token: r.tk,
    side: r.buy ? "buy" : "sell",
    venue: r.venue,
    block: r.b,
    time: at(r.b),
    usdcPaidOrReceived: round(num(BigInt(r.u)), 6),
    volumeUsd: round(num((r.venue === "uniswap-v3" ? poolSide : curveSide)(BigInt(r.u), !!r.buy)), 6),
    tokenAmount: round(num(BigInt(r.t)), 6),
  }));
}

/**
 * How the supply is spread, without naming anyone: a count, the largest holders' shares and the
 * creator's own share, which is the one thing a screener really wants to flag.
 *
 * From the scanner's holder figures (index.hold), which it builds from the coin's own Transfer
 * logs: curve trades, pool swaps and transfers between wallets all count, and the curve, the
 * pool and burned coins are not holders. Shares are of the supply that exists, 1B less burned.
 * Until the scanner's first full read of those logs, from the curve's trades as before.
 */
function distributionOf(floor, addr) {
  const hd = holdOf(floor, addr);
  if (hd) {
    const burned = big(hd.burned) ?? 0n;
    const total = SUPPLY - num(burned);
    const pct = (x) => round((num(big(x) ?? 0n) / total) * 100, 4);
    const top = hd.top.map((v) => big(v) ?? 0n);
    const sum = (n) => top.slice(0, n).reduce((a, v) => a + v, 0n);
    return {
      holders: hd.holders,
      topHolderPct: top.length ? pct(top[0]) : 0,
      top5Pct: pct(sum(5)),
      top10Pct: pct(sum(10)),
      creatorPct: pct(hd.creator),
      curveHeldPct: pct(hd.curve),
      poolHeldPct: pct(hd.pool),
      note: "shares of the supply that exists (1B less burned), from the coin's Transfer logs: curve trades, pool swaps and transfers between wallets all count; the curve, burned coins and the coin's Uniswap v3 pools are not holders; no wallet is named by this API",
    };
  }
  const m = ((floor.index || {}).net || {})[addr] || {};
  const t = (floor.tokens || []).find((x) => x.addr === addr);
  const creator = (t || {}).creator;
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
    // a migrated coin's pool, as the index last read it
    poolHeldPct: t && t.migrated ? share(big(t.inPool || "0") ?? 0n) : 0,
    note: "shares of total supply, from the curve's trades (the Transfer-based count is not read yet); no wallet is named by this API",
  };
}

function candlesOf(floor, addr, tfSec, limit, live = LIVE_NONE) {
  const { at } = clock(floor);
  // the curve's points and then, for a migrated coin, its pool's and the live swaps since
  const coin = (floor.tokens || []).find((t) => t.addr === addr);
  const series = coin ? seriesOf(floor, coin, tailOf(live, coin, poolOf(floor, coin)).swaps) : ((floor.index || {}).series || {})[addr] || [];
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
      // a bucket opens where the last one closed, so the wick has to cover that too; not across
      // a gap in the points, where the last close is not this bucket's opening price
      const open = last && !x.gap ? last.close : p;
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

/**
 * The whole API. api/basedbot serves it free; api/agent serves the same answers behind the x402
 * paywall (opts.prefix "agent", opts.paywall from api/_x402.js, opts.payment for the document).
 */
export async function serve(req, res, opts = {}) {
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
  const parts = u.pathname.replace(new RegExp("^/api/" + (opts.prefix || "basedbot") + "/?"), "").replace(/\/+$/, "").split("/").filter(Boolean);
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

  // One key per endpoint whatever it was called, which is what the agent API prices by: the
  // list, one coin, trades, distribution, candles, or "" for the document. An unknown route
  // has no price and falls through to the 404 below unpaid.
  const routeKey = !route ? ""
    : isAddr(route) ? "token"
    : route === "tokens" || route === "token" || route === "coins" ? (named(1) ? "token" : "tokens")
    : route === "holders" ? "distribution"
    : route === "ohlcv" ? "candles"
    : route;
  if (opts.paywall && !(await opts.paywall(req, res, routeKey))) return;

  if (!route) {
    let m = meta(floor);
    if (opts.prefix) {
      m = JSON.parse(JSON.stringify(m).replaceAll("/api/basedbot", "/api/" + opts.prefix));
      if (opts.payment) m.payment = opts.payment();
    }
    return res.status(200).json(envelope(floor, m));
  }

  // A serverless catch-all routes exactly one segment on this project: /api/basedbot/token/0x...
  // answers Vercel's own 404, never this handler. So an address IS a route, and every endpoint
  // also takes ?address= .
  if (route === "tokens" || route === "token" || route === "coins" || isAddr(route)) {
    const one = isAddr(route) ? route : addrOf(1);
    if (!one && named(1)) return res.status(400).json(badAddr(1));
    // pools are read for the list, which sorts on price, and for a migrated coin; one coin on
    // its curve needs none of them
    const live = needsLive(floor, one) || !one && migratedAny(floor) ? await livePoolsBounded(floor) : LIVE_NONE;
    const all = shape(floor, live);
    if (one) {
      const t = all.find((x) => x.address === one);
      if (!t) return res.status(404).json({ error: NO_COIN });
      return res.status(200).json(envelope(floor, {
        token: t,
        distribution: distributionOf(floor, one),
        trades: tradesOf(floor, one, clamp("trades", 20, 200), live),
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
    const live = (a ? needsLive(floor, a) : migratedAny(floor)) ? await livePoolsBounded(floor) : LIVE_NONE;
    return res.status(200).json(envelope(floor, {
      token: a,
      windowHours: 24,
      trades: tradesOf(floor, a, clamp("limit", 100, MAX_TRADES), live),
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
    const live = needsLive(floor, a) ? await livePoolsBounded(floor) : LIVE_NONE;
    return res.status(200).json(envelope(floor, {
      token: a,
      tf,
      note: "built from the indexed price points of this curve, at most 600, and once migrated of its pool, the newest 600 indexed and the swaps since",
      candles: candlesOf(floor, a, TFS[tf], clamp("limit", 500, MAX_CANDLES), live),
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
