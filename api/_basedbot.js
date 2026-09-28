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

let pools = { at: 0, key: "", data: {} };
let poolsInflight = null;

/**
 * address -> { pool, priceWad, inPool, usdcInPool, burned, at } per migrated coin, `at` being
 * when that pool was read. A coin whose read fails this time keeps its last live read, with its
 * own date, and shape() takes whichever of that and the index's read is newer. A failure is
 * kept for the window too, so a dead RPC is not asked on every request.
 */
async function livePools(floor) {
  const coins = (floor.tokens || []).filter((t) => t.migrated && isAddr(t.pool) && isAddr(t.addr));
  if (!coins.length) return {};
  const key = coins.map((t) => t.addr + t.pool).join();
  if (pools.key === key && Date.now() - pools.at < CACHE_S * 1000) return pools.data;
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
    if (poolsInflight === me) pools = { at: Date.now(), key, data };
    return data;
  })().finally(() => { if (poolsInflight === me) poolsInflight = null; });
  return me.run;
}

/**
 * livePools, but a request waits at most LIVE_WAIT_MS on it: past that it is answered from the
 * last reads, each dated by its priceAt, and the refresh carries on for the requests after it.
 */
async function livePoolsBounded(floor) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(pools.data), LIVE_WAIT_MS); });
  try { return await Promise.race([livePools(floor), late]); } finally { clearTimeout(timer); }
}

/** Block number to unix seconds, from the index's tip and measured block time. */
function clock(floor) {
  const genSec = Math.floor(new Date(floor.generatedAt).getTime() / 1000);
  const bt = Number(floor.blockTimeSec) || 1;
  return { at: (b) => Math.round(genSec - (floor.tip - b) * bt), bt, genSec };
}

/** Everything the list and the single-coin view need, per coin, in one pass. */
function shape(floor, live = {}) {
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
      const lv = live[addr] && live[addr].pool === t.pool ? live[addr] : null;
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
    const d = day[addr] || { vol: 0n, trades: 0, last: 0 };
    const series = (ix.series || {})[addr] || [];
    const holders = Object.values((ix.net || {})[addr] || {}).filter((h) => BigInt(h.t) > 0n).length;

    // The price `sec` before priceAt, from the last point at or before that block: the window
    // ends when the price was read, which for a live pool price is now, not the index tip. The
    // points are the curve's, so a migrated coin has none for a window that opens after its
    // last curve trade: that change is unknown here, not zero, and not a change since the move.
    const lastCurveBlock = series.length ? series[series.length - 1].b : 0;
    const back = (sec) => {
      const b = floor.tip - Math.round((genSec - priceAt + sec) / bt); // for priceAt = genSec, exactly tip - round(sec/bt)
      if (t.migrated && b > lastCurveBlock) return null;
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
      "uniswap-v3": "trades in its Uniswap v3 pool (poolAddress) like any v3 pool; the curve is closed for good. Its price, caps and liquidity come from the pool (see price); volume, trades, candles and lastTradeAt are the curve's and stop at the move, and priceChangePct is null for a window that opens after it",
      note: "venue is as fresh as the index (see freshness). For a coin on its curve, quoteBuy answers live: it reverts with 'graduated' once the curve has closed",
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
    price: `priceSource says where priceUsd and priceWad come from. 'bonding-curve': the curve's spot price, as the index read it. 'uniswap-v3': a migrated coin's pool price, read live from Arc and kept ${CACHE_S} s; when the chain does not answer, the newest earlier read, ours or the index's. priceAt is when that read was made, in unix seconds, and priceChangePct is measured back from it. The caps and supply of a migrated coin come from the same read, and its liquidityUsd is the pool's two balances at that price (null if the pool was never read)`,
    supply: "fdvUsd = price x totalSupply, where totalSupply is 1B minus everything burned: what migration burned, then the pool's token-side fees, which collectPoolFees() burns. marketCapUsd = price x circulatingSupply: before migration the curve's unsold reserve is left out; after it, everything not burned circulates, the Uniswap pool's inventory included. holderCapUsd = price x holderSupply, the tokens in wallets only (circulating less the pool's inventory).",
    untrusted: "name, symbol and metadataURI are whatever the coin's creator wrote on chain: escape them before rendering, and check metadataURI's scheme before following it",
    freshness: {
      // FLOOR_REFRESH_MS in monitor/scan.mjs: the scanner runs every minute, but rebuilds the
      // index at most this often, and publishes it only when a chain event or a coin landed
      publishedEverySec: 1800,
      cachedSec: CACHE_S,
      note: "indexed from chain by our scanner at most every 30 minutes and published only when something changed, so in quiet hours updatedAt can be older than that; updatedAt and blockHeight on every response. Pool prices of migrated coins are read live (see price)",
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
    // pools are read for the list, which sorts on price, and for a migrated coin; one coin on
    // its curve needs none of them
    const needsPools = !one || (floor.tokens || []).some((x) => x.addr === one && x.migrated);
    const all = shape(floor, needsPools ? await livePoolsBounded(floor) : {});
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
