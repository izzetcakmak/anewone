/**
 * Builds docs/data/floor.json — everything the front page needs to draw itself,
 * computed once here instead of once per visitor.
 *
 * Why this exists: the site is a static page that indexes the chain in the
 * browser. A cold visit costs ~80 RPC calls (42 eth_call for the token list and
 * curve state, the rest eth_getLogs for trade history), and every visitor
 * repeats the identical scan. That is fine for ten people and fatal for three
 * thousand — the shared RPC key is metered, so the load ceiling is our quota,
 * not the chain (Arc itself sits at ~7% of its gas limit).
 *
 * The output deliberately mirrors the browser's own localStorage cache format,
 * so the front end can hydrate its existing structures from it and every
 * consumer — charts, trust panel, dev profile, ticker, sorting — keeps working
 * untouched. Prices are still re-read live before anyone trades.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rpc, fetchLogs, atomicWrite, setRpcPool } from "./snapshot.mjs";

const MON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(MON);
const OUT_FILE = path.join(ROOT, "docs", "data", "floor.json");

// Must match STATS_SCHEMA in docs/index.html. A mismatch makes the front end
// ignore the file and fall back to indexing itself, which is the safe direction.
const SCHEMA = 6; // 6: each price point carries the USDC that crossed the curve (chart volume)

const SEL = {
  tokensCount: "0xa64ed8ba",
  allTokens: "0x634282af",
  info: "0x0aae7a6b",
  gradTarget: "0x9a3a8ee1",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  // supply after graduation: what migrate() burned and what sits in the Uniswap pool
  balanceOf: "0x70a08231",
  migrated: "0x4ba0a5ee",
  curveReopened: "0x8812de84",
  v3Factory: "0x7c887c59",
  usdc: "0x3e413bee",
  getPool: "0x1698ee82",
  slot0: "0x3850c7bd",
  // a Uniswap v3 pool's own identity, to tell one holding a coin from a wallet
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  fee: "0xddca3f43",
};
const BURN = "0x000000000000000000000000000000000000dead";
const TOPIC_TRADE = "0xf7dd8a134438de4c59401760e24ef5c6cc9c74583b2b022085697f3021e59768";
const TOPIC_COMMENT = "0x83e5a18f10338a7eb46107a07561cf75d2e07dc4f8d10230f6cfed01cd98b505";
const TOPIC_IMAGE = "0x4fe20d8f61958f75787f29537de90577ad84befe73f9f2c69d2b8a0d95770e16";
// Uniswap v3 Swap(address indexed sender, address indexed recipient, int256 amount0,
// int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
const TOPIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const POOL_FEE_BPS = 100n; // the 1% tier migrate() opens; v3 takes it from a swap's input side
// Migrated(address indexed token, address indexed pool, uint256 positionId, uint256 tokensToPool,
// uint256 usdcToPool, uint128 liquidity, uint256 tokensBurned), the platform's last log in migrate()
const TOPIC_MIGRATED = "0xabd0ad51ae0f062ec47f8d5a093b2ab9378f5778866ec8e77148decd301ca4c8";
// A pool's 24h volume is kept in 5-minute buckets rather than one row per swap: a busy pool
// would otherwise add thousands of rows to a file every visitor downloads. The API reads the
// same bucket size (DAY_BUCKET in api/_basedbot.js).
const DAY_BUCKET = 600;
const MAX_POOL_TAPE = 1000; // the newest swaps kept for the API's trades tape, which serves 1000 at most

/** Where the cards are served from; og:image has to be an absolute URL. */
const SITE = "https://anewone.xyz";
const CARD_DIR = path.join(ROOT, "docs", "t");

// 24h at Arc's ~0.5s blocks. Matches the front end's own window.
const DAY_BLOCKS = 172_800;
const MAX_RECENT = 5000;
const MAX_SERIES = 600;

// The Trade event reports the trader's side of the swap: a buy is quoted before
// the fee is taken out, a sell after. Summing the two raw would overstate
// buys, so both are converted to the amount that actually crossed the curve —
// identical to curveSide() in docs/index.html, and it must stay identical.
const BPS = 10_000n;
// Replaced by the platform's own FEE_BPS() at the start of runFloor, as the page does.
let FEE_BPS = 100n;
const curveSide = (u, isBuy) => (isBuy ? (u * (BPS - FEE_BPS)) / BPS : (u * BPS) / (BPS - FEE_BPS));

// ---------------------------------------------------------------- abi helpers
// Hand-rolled so the scanner keeps its zero-dependency install; only a handful
// of shapes are needed and all of them are fixed.
const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const toBig = (w) => BigInt("0x" + w);
const toAddr = (w) => "0x" + w.slice(24);
const encAddr = (a) => pad(a.toLowerCase());
const encUint = (n) => pad(BigInt(n).toString(16));

function decodeString(data, headWord) {
  // headWord holds a byte offset from the start of the payload
  const off = Number(toBig(word(data, headWord))) * 2;
  const len = Number(BigInt("0x" + data.slice(2 + off, 2 + off + 64)));
  const bytes = data.slice(2 + off + 64, 2 + off + 64 + len * 2);
  return Buffer.from(bytes, "hex").toString("utf8");
}

const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

async function callString(to, selector) {
  const out = await ethCall(to, selector);
  if (!out || out === "0x") return "";
  try { return decodeString(out, 0); } catch { return ""; }
}

/** info(address) -> creator, createdBlock, graduated, vUsdc, tReserve, raised, metadataURI */
function decodeInfo(out) {
  return {
    creator: toAddr(word(out, 0)),
    createdBlock: Number(toBig(word(out, 1))),
    graduated: toBig(word(out, 2)) === 1n,
    vUsdc: toBig(word(out, 3)).toString(),
    tReserve: toBig(word(out, 4)).toString(),
    raised: toBig(word(out, 5)).toString(),
    metadataURI: decodeString(out, 6),
  };
}

// ---------------------------------------------------------------- index build
// Mirrors ingestLogs()/rebuildStats() in docs/index.html. Kept deliberately
// close to that code, line for line, because the two must agree: the browser
// tails forward from where this file stops, on top of these same structures.
function buildIndex(logs, lo, hi, prior = null) {
  // A first run walks eight million blocks in ~1000 getLogs calls. Every run
  // after that must only see what is new, so the accumulated totals are carried
  // in and merged rather than recomputed.
  const agg = {}, net = {}, series = {}, comments = {};
  let recent = [];
  const cutoff = hi - DAY_BLOCKS;

  if (prior) {
    for (const [k, v] of Object.entries(prior.agg || {})) {
      agg[k] = { volAll: BigInt(v.volAll), trades: v.trades, lastBlock: v.lastBlock || 0 };
    }
    for (const [k, m] of Object.entries(prior.net || {})) {
      net[k] = Object.fromEntries(Object.entries(m)
        .map(([a, x]) => [a, { t: BigInt(x.t), i: BigInt(x.i), o: BigInt(x.o), f: x.f }]));
    }
    for (const [k, arr] of Object.entries(prior.series || {})) {
      series[k] = arr.map((x) => ({ b: x.b, p: BigInt(x.p), u: BigInt(x.u || 0) }));
    }
    for (const [k, arr] of Object.entries(prior.comments || {})) comments[k] = arr.slice();
    recent = (prior.recent || []).map((r) => ({
      b: r.b, tk: r.tk, tr: r.tr, u: BigInt(r.u), t: BigInt(r.t), buy: r.buy,
    }));
  }

  for (const lg of logs) {
    const token = toAddr(lg.topics[1].slice(2));
    const blockNumber = Number(BigInt(lg.blockNumber));

    if (lg.topics[0] === TOPIC_COMMENT) {
      let text;
      try { text = decodeString(lg.data, 0); } catch { continue; }
      const author = toAddr(lg.topics[2].slice(2));
      const arr = comments[token] || (comments[token] = []);
      const id = blockNumber + ":" + Number(BigInt(lg.logIndex ?? "0x0"));
      if (!arr.some((c) => c.id === id)) arr.push({ id, b: blockNumber, a: author, m: String(text).slice(0, 400) });
      continue;
    }

    // Trade: data = usdc, tokens, priceWad
    let usdc, tokens, priceWad;
    try {
      usdc = toBig(word(lg.data, 0));
      tokens = toBig(word(lg.data, 1));
      priceWad = toBig(word(lg.data, 2));
    } catch { continue; }
    const trader = toAddr(lg.topics[2].slice(2));
    const isBuy = BigInt(lg.topics[3]) === 1n;

    const a = agg[token] || (agg[token] = { volAll: 0n, trades: 0, lastBlock: 0 });
    a.volAll += curveSide(usdc, isBuy);
    a.trades++;
    if (blockNumber > a.lastBlock) a.lastBlock = blockNumber;

    const m = net[token] || (net[token] = {});
    const e = m[trader] || (m[trader] = { t: 0n, i: 0n, o: 0n, f: blockNumber });
    if (isBuy) { e.t += tokens; e.i += usdc; } else { e.t -= tokens; e.o += usdc; }
    if (blockNumber < e.f) e.f = blockNumber;

    const ser = series[token] || (series[token] = []);
    ser.push({ b: blockNumber, p: priceWad, u: curveSide(usdc, isBuy) });

    if (blockNumber >= cutoff) recent.push({ b: blockNumber, tk: token, tr: trader, u: usdc, t: tokens, buy: isBuy });
  }

  // same trimming the browser applies, so the shapes stay interchangeable
  for (const [tk, arr] of Object.entries(series)) {
    arr.sort((x, y) => x.b - y.b);
    const dedup = arr.filter((p, i) => i === 0 || p.b !== arr[i - 1].b || p.p !== arr[i - 1].p || p.u !== arr[i - 1].u);
    series[tk] = dedup.length > MAX_SERIES ? [dedup[0], ...dedup.slice(-(MAX_SERIES - 1))] : dedup;
  }
  // the window slides, so anything that fell out of 24h goes now
  recent = recent.filter((r) => r.b >= cutoff);
  recent.sort((x, y) => x.b - y.b);
  // points from before the volume field carry none; the 24h list fills in what it knows
  const volAt = {};
  for (const r of recent) (volAt[r.tk] || (volAt[r.tk] = {}))[r.b] = ((volAt[r.tk] || {})[r.b] || 0n) + curveSide(r.u, r.buy);
  for (const [tk, arr] of Object.entries(series)) for (const x of arr) if (!x.u && volAt[tk] && volAt[tk][x.b]) x.u = volAt[tk][x.b];

  return {
    lo, hi,
    agg: Object.fromEntries(Object.entries(agg)
      .map(([k, v]) => [k, { volAll: v.volAll.toString(), trades: v.trades, lastBlock: v.lastBlock }])),
    net: Object.fromEntries(Object.entries(net)
      .map(([k, m]) => [k, Object.fromEntries(Object.entries(m)
        .map(([addr, x]) => [addr, { t: x.t.toString(), i: x.i.toString(), o: x.o.toString(), f: x.f }]))])),
    recent: recent.slice(-MAX_RECENT).map((r) => ({
      b: r.b, tk: r.tk, tr: r.tr, u: r.u.toString(), t: r.t.toString(), buy: r.buy,
    })),
    series: Object.fromEntries(Object.entries(series)
      .map(([k, arr]) => [k, arr.map((x) => ({ b: x.b, p: x.p.toString(), u: (x.u || 0n).toString() }))])),
    comments,
  };
}

/**
 * The platform the site is actually pointed at — mainnet the moment the scanner
 * flips it live, testnet until then.
 *
 * Read from docs/config.js rather than hardcoded, because that file is what the
 * page loads: if the two ever disagree the floor would index one contract while
 * visitors traded on another. config.js is our own source, so it is evaluated
 * rather than pattern-matched.
 */
function liveNetwork() {
  const src = readFileSync(path.join(ROOT, "docs", "config.js"), "utf8");
  const win = {};
  new Function("window", src)(win);
  const c = win.ANEWONE_CONFIG;
  const mainnet = !!(c && c.mainnet && c.mainnet.live);
  const net = mainnet ? c.mainnet : c && c.testnet;
  if (!net || !net.platform) throw new Error("config.js: no live platform address");
  // read pool for this network: the log-capable endpoints first (getLogs is what the floor
  // mostly does), then the rest; keyed/domain-locked entries are objects and are skipped
  const urls = [...(net.logRpcs || []), ...(net.rpcs || []), net.rpc]
    .filter((u) => typeof u === "string").filter((u, i, a) => u && a.indexOf(u) === i);
  return { platform: net.platform, noah: net.noah, mainnet, rpcs: urls };
}
export function livePlatform() { return liveNetwork().platform; }

// ---------------------------------------------------------------- share cards
// A link shared to X shows whatever the URL's og tags say, and the crawler never
// runs our JavaScript nor sees anything after "#". So each coin gets a tiny page
// of its own at /t/<address>/ that carries its title, artwork and market cap, and
// sends a real browser on to the app. pump.fun and pons both work this way.

const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
                   "image/webp": "webp", "image/svg+xml": "svg" };

/** The artwork, as bytes to write or an absolute URL to point at. */
async function tokenArtwork(t) {
  const fromDataUri = (s) => {
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(s || "");
    const mime = m ? m[1].toLowerCase() : "";
    if (!m || !MIME_EXT[mime] || mime === "image/svg+xml") return null;
    return { bytes: Buffer.from(m[2], "base64"), ext: MIME_EXT[m[1].toLowerCase()] };
  };
  // v6+ coins carry the picture in the launch event
  try {
    const logs = await fetchLogs(t.platform, BigInt(t.createdBlock), BigInt(t.createdBlock),
                                 [TOPIC_IMAGE], () => {});
    const mine = logs.find((l) => l.topics[1] && l.topics[1].toLowerCase().endsWith(t.addr.slice(2).toLowerCase()));
    if (mine) {
      const hit = fromDataUri(decodeString(mine.data, 0));
      if (hit) return hit;
    }
  } catch {}
  // older ones keep it in the metadata document
  const meta = String(t.metadataURI || "");
  try {
    if (meta.startsWith("{")) {
      const j = JSON.parse(meta);
      if (j.i) return fromDataUri(j.i) || (/^https:\/\//.test(j.i) ? { url: j.i } : null);
    } else if (/^https:\/\//.test(meta)) {
      const j = await (await fetch(meta)).json();
      // X renders JPG, PNG, WEBP and GIF on a card — never SVG, which would
      // silently come back blank, so vector art falls through to the site icon
      // unless a raster card has already been placed next to the page.
      // Only artwork this site hosts: a card that pointed og:image at somebody else's
      // server would hand that server every crawler and reader of the card.
      if (j.image && !/\.svg(\?|$)/i.test(j.image)) {
        if (String(j.image).startsWith(SITE + "/")) return { url: j.image };
        if (!/^https?:\/\//.test(j.image)) return { url: `${SITE}/${String(j.image).replace(/^\//, "")}` };
      }
    }
  } catch {}
  return null;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const compactUsd = (wei) => {
  const n = Number(wei) / 1e18;
  if (!isFinite(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
};

function cardHtml(t, imageUrl, chainLabel) {
  const title = `$${t.symbol} · ${t.name}`;
  const mcap = compactUsd((BigInt(t.vUsdc) * 10n ** 18n / BigInt(t.tReserve)) * 1_000_000_000n);
  const desc = `${t.graduated ? "Graduated · " : ""}MC ${mcap} · ${chainLabel} · A NEW ONE`;
  const app = `${SITE}/#t=${t.addr}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:url" content="${esc(app)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(imageUrl)}">
<link rel="canonical" href="${esc(app)}">
<link rel="icon" type="image/png" sizes="32x32" href="${SITE}/favicon.png">
</head>
<body style="font-family:system-ui,sans-serif;background:#0d0d10;color:#eee;padding:40px">
<!-- A crawler reads the tags above and stops. A browser is sent straight on;
     the link below is what a reader without JavaScript still gets. -->
<script>location.replace(${JSON.stringify(app)});</script>
<p><a href="${esc(app)}" style="color:#3ee6a0">${esc(title)} — open on A NEW ONE</a></p>
</body>
</html>
`;
}

/**
 * Writes /t/<address>/ for every coin. Artwork is fetched once and then left
 * alone: at any real number of coins, rewriting every card on every run would
 * cost a chain call each and a deploy full of unchanged bytes.
 */
async function writeCards(tokens, platform, chainLabel, log) {
  let made = 0, kept = 0;
  for (const t of tokens) {
    const dir = path.join(CARD_DIR, t.addr.toLowerCase());
    const page = path.join(dir, "index.html");
    let imageUrl = null;
    const existing = ["png", "jpg", "gif", "webp", "svg"]
      .map((e) => path.join(dir, "card." + e)).find((f) => existsSync(f));
    if (existing) {
      imageUrl = `${SITE}/t/${t.addr.toLowerCase()}/card.${existing.split(".").pop()}`;
    } else {
      const art = await tokenArtwork({ ...t, platform });
      if (art && art.bytes) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "card." + art.ext), art.bytes);
        imageUrl = `${SITE}/t/${t.addr.toLowerCase()}/card.${art.ext}`;
      } else if (art && art.url) {
        imageUrl = art.url;
      } else {
        imageUrl = `${SITE}/apple-touch-icon.png`; // launched without artwork
      }
    }
    // the page itself is cheap and carries live numbers, so it is always rewritten
    const html = cardHtml(t, imageUrl, chainLabel);
    mkdirSync(dir, { recursive: true });
    const before = existsSync(page) ? readFileSync(page, "utf8") : "";
    if (before !== html) { writeFileSync(page, html); made++; } else kept++;
  }
  log(`floor: share cards ${made} written, ${kept} unchanged -> docs/t/`);
}

// ---------------------------------------------------------------- cache
// Separate from snapshot-cache.json: that one aggregates wallets across every
// platform deployment for the campaign, this one is per-token state for the floor.
const CACHE_FILE = path.join(MON, "floor-cache.json");
function loadFloorCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (c && typeof c.hi === "number" && typeof c.lo === "number" && c.index) return c;
  } catch {}
  return null;
}
function saveFloorCache(c) {
  try { atomicWrite(CACHE_FILE, JSON.stringify(c)); } catch {}
}

// ---------------------------------------------------------------- pool swaps
// A migrated coin trades in its Uniswap v3 pool, and the platform logs nothing of that: its
// Trade log ends at the move. So the pool's own Swap logs are indexed here, incrementally like
// the platform's, into index.pool[coin]: all-time volume and count, 24h buckets, the newest
// swaps for the tape and price points. Kept apart from agg/recent/series on purpose: the
// browser tails those from the platform's logs alone and must not change shape (see buildIndex).
//
// Units as the curve's, so the API adds the two: u is the trader's USDC in native 18-decimal
// units (paid on a buy, received on a sell), t the coin amount, p the price after the swap as
// priceWad, and a point's u the USDC that crossed the pool's reserve: v3 takes its fee from the
// input, so a buy less the fee, a sell as paid out.
const Q192 = 1n << 192n;
const E30 = 10n ** 30n; // 1e12 from USDC's 6 decimals up to 18, and 1e18 for the wad
const toInt = (w) => { const x = BigInt("0x" + w); return x >= 1n << 255n ? x - (1n << 256n) : x; };
const abs = (x) => (x < 0n ? -x : x);
const poolSide = (u, isBuy) => (isBuy ? (u * (BPS - POOL_FEE_BPS)) / BPS : u);
const sqrtToWad = (s, zero) => (s === 0n ? 0n : zero ? (s * s * E30) / Q192 : (Q192 * E30) / (s * s));

/**
 * One Swap log as { b, i, u, t, buy, p }, or null when it does not decode or moved nothing (a
 * swap through no liquidity only walks the price, as migrate()'s correction of an empty pool does).
 */
function decodeSwap(lg, zero) {
  try {
    const a0 = toInt(word(lg.data, 0)), a1 = toInt(word(lg.data, 1));
    const s = toBig(word(lg.data, 2));
    const coin = zero ? a0 : a1, usdc = zero ? a1 : a0; // positive: the pool received it
    if (coin === 0n && usdc === 0n) return null;
    return { b: Number(BigInt(lg.blockNumber)), i: Number(BigInt(lg.logIndex ?? "0x0")), u: abs(usdc) * 10n ** 12n, t: abs(coin), buy: coin < 0n, p: sqrtToWad(s, zero) };
  } catch { return null; }
}

/**
 * index.pool for this run: every migrated coin's entry carried from the last one and brought up
 * to the tip. A coin's pool counts from its Migrated log on: swaps in a pool somebody opened
 * before the move are not its market, and neither are migrate()'s own correction and buyback,
 * which come before that log in the same transaction. Until that log is read the coin gets no
 * entry, and a failed read keeps the entry as it was: either way the next run picks up where
 * this one could not.
 *
 * Entry: movedAt { b, i } (the Migrated log), hi (read up to), volAll, trades, lastBlock, day
 * [[bucket start block, volume, swaps]] for the last 24h, recent (the newest MAX_POOL_TAPE
 * swaps of the last 24h), series (the newest MAX_SERIES price points) and trimmed, true once
 * older points were dropped, so a reader knows the series does not reach back to the move.
 */
async function indexPools(platform, tokens, index, prior, tip, log) {
  const out = {};
  let events = 0, usdc = null;
  const cutoff = tip - DAY_BLOCKS;
  for (const t of tokens) {
    const addr = t.addr.toLowerCase();
    if (!t.migrated || !t.pool || /^0x0{40}$/.test(t.pool)) continue;
    const was = prior && prior[addr] && prior[addr].pool === t.pool && prior[addr].movedAt ? prior[addr] : null;
    try {
      usdc = usdc || toAddr(word(await ethCall(platform, SEL.usdc), 0));
      const zero = addr < usdc.toLowerCase();
      let e;
      if (was) {
        e = {
          pool: was.pool, movedAt: was.movedAt, hi: was.hi, volAll: BigInt(was.volAll), trades: was.trades,
          lastBlock: was.lastBlock, trimmed: !!was.trimmed,
          day: new Map((was.day || []).map(([b, v, n]) => [b, { v: BigInt(v), n }])),
          recent: was.recent.map((r) => ({ b: r.b, u: BigInt(r.u), t: BigInt(r.t), buy: r.buy })),
          series: was.series.map((x) => ({ b: x.b, p: BigInt(x.p), u: BigInt(x.u) })),
        };
      } else {
        // the move itself, searched from the coin's last curve trade on, since it comes after
        const from = ((index.agg || {})[addr] || {}).lastBlock || t.createdBlock;
        const moved = (await fetchLogs(platform, BigInt(from), BigInt(tip), TOPIC_MIGRATED, log))
          .find((lg) => lg.topics[1] && toAddr(lg.topics[1].slice(2)) === addr && lg.topics[2] && toAddr(lg.topics[2].slice(2)) === t.pool.toLowerCase());
        if (!moved) { log(`floor: no Migrated log for ${t.symbol || addr} read yet; its pool waits for the next run`); continue; }
        const b = Number(BigInt(moved.blockNumber)), i = Number(BigInt(moved.logIndex ?? "0x0"));
        e = { pool: t.pool, movedAt: { b, i }, hi: b - 1, volAll: 0n, trades: 0, lastBlock: 0, trimmed: false, day: new Map(), recent: [], series: [] };
      }
      if (e.hi < tip) {
        const after = (lg) => {
          const b = Number(BigInt(lg.blockNumber));
          return b > e.movedAt.b || (b === e.movedAt.b && Number(BigInt(lg.logIndex ?? "0x0")) > e.movedAt.i);
        };
        const logs = await fetchLogs(t.pool, BigInt(e.hi + 1), BigInt(tip), TOPIC_SWAP, log);
        const swaps = logs.filter(after).map((lg) => decodeSwap(lg, zero)).filter(Boolean).sort((x, y) => x.b - y.b || x.i - y.i);
        for (const s of swaps) {
          const v = poolSide(s.u, s.buy);
          e.volAll += v;
          e.trades++;
          if (s.b > e.lastBlock) e.lastBlock = s.b;
          const k = Math.floor(s.b / DAY_BUCKET) * DAY_BUCKET;
          const d = e.day.get(k) || { v: 0n, n: 0 };
          d.v += v; d.n++;
          e.day.set(k, d);
          e.recent.push({ b: s.b, u: s.u, t: s.t, buy: s.buy });
          e.series.push({ b: s.b, p: s.p, u: v });
        }
        events += swaps.length;
        e.hi = tip;
      }
      for (const k of [...e.day.keys()]) if (k + DAY_BUCKET <= cutoff) e.day.delete(k);
      e.recent = e.recent.filter((r) => r.b >= cutoff).slice(-MAX_POOL_TAPE);
      if (e.series.length > MAX_SERIES) { e.series = e.series.slice(-MAX_SERIES); e.trimmed = true; }
      out[addr] = {
        pool: e.pool, movedAt: e.movedAt, hi: e.hi, volAll: e.volAll.toString(), trades: e.trades, lastBlock: e.lastBlock,
        day: [...e.day.entries()].sort((x, y) => x[0] - y[0]).map(([b, d]) => [b, d.v.toString(), d.n]),
        recent: e.recent.map((r) => ({ b: r.b, u: r.u.toString(), t: r.t.toString(), buy: r.buy })),
        series: e.series.map((x) => ({ b: x.b, p: x.p.toString(), u: x.u.toString() })),
        trimmed: e.trimmed,
      };
    } catch (err) {
      log(`floor: the pool of ${t.symbol || addr} not read this run: ${(err && err.message) || err}`);
      if (was) out[addr] = was;
    }
  }
  // a coin whose flags could not be read this run keeps the entry it had
  for (const [k, v] of Object.entries(prior || {})) if (!out[k]) out[k] = v;
  return { pool: out, events };
}

// ---------------------------------------------------------------- holders
// Who holds each coin, from the coins' own Transfer logs. Curve trades, pool swaps and plain
// transfers between wallets all move balances, and only Transfer sees all three: the
// platform's Trade log, which `net` is built from, sees the first alone, so a migrated coin's
// holders would stop at the move and a wallet that was sent coins would never count.
//
// The balances live in the floor cache, never in floor.json: the published index carries per
// coin a count and a few figures (the largest balances, the creator's, the curve's, the
// pool's, the burned), no wallet. The history is read once, HOLD_CHUNKS_PER_RUN windows a run
// so no run grows long (a first pass takes a few runs), then only what is new; figures are
// published once every coin is read up to the tip, and until then the API keeps counting from
// `net` as it did.
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HOLD_CHUNKS_PER_RUN = 25; // a full first pass on mainnet ran ~100 s per 40 windows, 240 s at worst
const HOLD_CHUNK = 9_999; // blocks per getLogs, the public RPC's cap
const ZERO = "0x0000000000000000000000000000000000000000";
const TOP_N = 10;

/** Applies Transfer logs, oldest first, to one coin's balances. The zero address is not a holder. */
function applyTransfers(bal, logs) {
  const sorted = logs.slice().sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex ?? "0x0") - BigInt(y.logIndex ?? "0x0")));
  let n = 0;
  for (const lg of sorted) {
    let v;
    try { v = toBig(word(lg.data, 0)); } catch { continue; }
    const from = toAddr(lg.topics[1].slice(2)), to = toAddr(lg.topics[2].slice(2));
    if (from !== ZERO) bal.set(from, (bal.get(from) || 0n) - v);
    if (to !== ZERO) bal.set(to, (bal.get(to) || 0n) + v);
    n++;
  }
  return n;
}

/**
 * Whether `a`, holding `coin`, is a Uniswap v3 pool of that coin on the platform's own factory:
 * a contract whose token0/token1 include the coin and which the factory returns for its pair and
 * fee. Such a pool is liquidity, not a holder: the one migrate() fills, and any somebody else
 * opens, before the move or on another tier. Answers are kept per coin and address (a wallet stays
 * a wallet, a pool a pool); a read that fails is not kept, so the address is asked again next run.
 */
async function isCoinPool(kind, coin, a, factory) {
  const k = coin + ":" + a;
  if (kind[k]) return kind[k] === "pool";
  let pool = false;
  try {
    const code = await rpc("eth_getCode", [a, "latest"]);
    if (code && code !== "0x") {
      const out = await Promise.all([SEL.token0, SEL.token1, SEL.fee].map((s) => ethCall(a, s).catch(() => "0x")));
      if (out.every((x) => typeof x === "string" && x.length >= 66)) {
        const t0 = toAddr(word(out[0], 0)), t1 = toAddr(word(out[1], 0)), fee = toBig(word(out[2], 0));
        if (t0 === coin || t1 === coin) {
          pool = toAddr(word(await ethCall(factory, SEL.getPool + encAddr(t0) + encAddr(t1) + encUint(fee)), 0)) === a;
        }
      }
    }
  } catch { return false; }
  kind[k] = pool ? "pool" : "other";
  return pool;
}

/**
 * Brings every coin's balances forward: a coin that joined behind the others (created before the
 * blocks already read, or not read that far yet) catches up on its own, then the coins that are
 * level are read together, one getLogs per window. A failed window stops the run where it is; the
 * next run carries on from there. Returns the state for the cache, the per-coin figures when every
 * coin is read to the tip (else the last complete ones), and how many transfers were applied.
 * A coin created after the tip (its creation seen while this run read the token list) waits for
 * the next run rather than be counted with none of its transfers.
 */
async function indexHolders(platform, tokens, prior, tip, log) {
  const h = prior && typeof prior.hi === "number" && prior.coins
    ? {
        hi: prior.hi, stats: prior.stats || null, kind: { ...(prior.kind || {}) },
        coins: Object.fromEntries(Object.entries(prior.coins).map(([k, c]) => [k, { cur: c.cur, bal: new Map(Object.entries(c.bal).map(([a, v]) => [a, BigInt(v)])) }])),
      }
    : { hi: Math.min(...tokens.map((t) => t.createdBlock)) - 1, stats: null, kind: {}, coins: {} };
  tokens = tokens.filter((t) => t.createdBlock <= tip);
  for (const t of tokens) {
    const a = t.addr.toLowerCase();
    if (!h.coins[a]) h.coins[a] = { cur: Math.min(t.createdBlock - 1, h.hi), bal: new Map() };
  }
  let budget = HOLD_CHUNKS_PER_RUN, events = 0;
  try {
    for (const [a, c] of Object.entries(h.coins)) {
      while (c.cur < h.hi && budget > 0) {
        const to = Math.min(h.hi, c.cur + HOLD_CHUNK);
        events += applyTransfers(c.bal, await fetchLogs(a, BigInt(c.cur + 1), BigInt(to), TOPIC_TRANSFER, log));
        c.cur = to; budget--;
      }
    }
    const level = Object.keys(h.coins).filter((a) => h.coins[a].cur === h.hi);
    while (h.hi < tip && budget > 0 && level.length) {
      const to = Math.min(tip, h.hi + HOLD_CHUNK);
      const logs = await fetchLogs(level, BigInt(h.hi + 1), BigInt(to), TOPIC_TRANSFER, log);
      for (const a of level) events += applyTransfers(h.coins[a].bal, logs.filter((lg) => String(lg.address).toLowerCase() === a));
      for (const a of level) h.coins[a].cur = to;
      h.hi = to; budget--;
    }
  } catch (e) {
    log(`floor: holders read stopped at block ${h.hi}: ${(e && e.message) || e}`);
  }
  const behind = tokens.filter((t) => h.coins[t.addr.toLowerCase()].cur < tip).length;
  if (behind) log(`floor: holders read to block ${h.hi} of ${tip} (${behind} coins behind); figures wait until every coin is read`);
  // A failure working out the figures keeps the last ones; the balances read this run are kept.
  if (!behind) try {
    // not holders: nobody (mint and burn ends), the curve, burned coins, and the coin's pools
    const fixed = new Set([ZERO, platform.toLowerCase(), BURN]);
    const factory = toAddr(word(await ethCall(platform, SEL.v3Factory), 0));
    const stats = { hi: tip, coins: {} };
    for (const t of tokens) {
      const coin = t.addr.toLowerCase(), bal = h.coins[coin].bal;
      const held = [];
      let inPools = 0n;
      for (const [a, v] of bal.entries()) {
        if (v <= 0n || fixed.has(a)) continue;
        if (a === String(t.pool || "").toLowerCase() || (await isCoinPool(h.kind, coin, a, factory))) inPools += v;
        else held.push(v);
      }
      held.sort((x, y) => (y > x ? 1 : y < x ? -1 : 0));
      const of = (a) => (bal.get(String(a || "").toLowerCase()) || 0n).toString();
      stats.coins[coin] = {
        holders: held.length, top: held.slice(0, TOP_N).map(String),
        creator: of(t.creator), curve: of(platform), pool: inPools.toString(), burned: of(BURN),
      };
    }
    h.stats = stats;
  } catch (e) {
    log(`floor: holder figures not worked out this run, the last ones stay: ${(e && e.message) || e}`);
  }
  const state = {
    hi: h.hi, stats: h.stats, kind: h.kind,
    coins: Object.fromEntries(Object.entries(h.coins).map(([k, c]) => [k, {
      cur: c.cur, bal: Object.fromEntries([...c.bal.entries()].filter(([, v]) => v !== 0n).map(([a, v]) => [a, v.toString()])),
    }])),
  };
  return { state, stats: h.stats, events };
}

/** index.hold of the last floor.json written, or null. */
function readPublishedHold() {
  try { return JSON.parse(readFileSync(OUT_FILE, "utf8")).index.hold || null; } catch { return null; }
}

/** The coins of the last floor.json written, by lowercase address; empty when there is none. */
function readPublished() {
  try {
    const d = JSON.parse(readFileSync(OUT_FILE, "utf8"));
    return new Map((d.tokens || []).map((t) => [String(t.addr).toLowerCase(), t]));
  } catch { return new Map(); }
}
// Where a coin trades turns on these three flags (the API's venue reads them), and migrate()
// and reopenCurve() emit no Trade log, so a change in any of them has to publish on its own.
const venueState = (t) => (t ? [t.graduated, t.migrated, t.reopened].map((x) => (x ? 1 : 0)).join("") : "");
// What a graduated coin carries beyond info(); kept from the last file when a read fails.
const GRADUATED_FIELDS = ["migrated", "reopened", "burned", "inPool", "pool", "poolSqrtPriceX96", "poolUsdc", "poolReadAt"];

// ---------------------------------------------------------------- entry point
export async function runFloor({ platform, log = console.log } = {}) {
  if (!platform) throw new Error("runFloor: platform address required");
  // index the chain the site is actually on: mainnet pool from config.js once live,
  // the shared testnet pool otherwise
  const net = liveNetwork();
  if (net.mainnet && net.rpcs.length) { setRpcPool(net.rpcs); log(`floor: mainnet pool ${net.rpcs.join(", ")}`); }
  // FEE_BPS(): the fee this platform was built with. curveSide() has to match it exactly.
  try { FEE_BPS = BigInt(await ethCall(platform, "0xbf333f2c")); } catch {}

  const tipHex = await rpc("eth_blockNumber", []);
  const tip = BigInt(tipHex);

  // The page needs seconds-per-block to say "3h ago" and to know whether its
  // window really covers 24h. It used to derive that from two getBlock calls of
  // its own; measuring it here once means every visitor gets it for free.
  const [bNow, bOld] = await Promise.all([
    rpc("eth_getBlockByNumber", [tipHex, false]),
    rpc("eth_getBlockByNumber", ["0x" + (tip - 5000n).toString(16), false]),
  ]);
  const blockTimeSec = bNow && bOld
    ? (Number(BigInt(bNow.timestamp)) - Number(BigInt(bOld.timestamp))) / 5000
    : 0;

  const count = Number(toBig(word(await ethCall(platform, SEL.tokensCount), 0)));
  const gradTarget = toBig(word(await ethCall(platform, SEL.gradTarget), 0)).toString();
  log(`floor: ${count} tokens @ block ${tip}`);

  const before = readPublished();
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const addr = toAddr(word(await ethCall(platform, SEL.allTokens + encUint(i)), 0));
    const info = decodeInfo(await ethCall(platform, SEL.info + encAddr(addr)));
    let [name, symbol] = [await callString(addr, SEL.name), await callString(addr, SEL.symbol)];
    // A graduated coin's supply is no longer 1B in anyone's hands: migrate() burns the part of
    // the curve's reserve the raised USDC cannot pair with, and the rest sits in the pool. Read
    // both, so the API can give a real circulating supply instead of assuming the launch one.
    // And where it trades: its curve closed at graduation, so it is in its Uniswap pool once
    // migrated, back on its curve while an owner has reopened it (reopened counts only until
    // the move, as the contract's _curveOpen does), and nowhere in between.
    let supply = {};
    if (info.graduated) {
      try {
        const migrated = toBig(word(await ethCall(platform, SEL.migrated + encAddr(addr)), 0)) === 1n;
        const reopened = !migrated && toBig(word(await ethCall(platform, SEL.curveReopened + encAddr(addr)), 0)) === 1n;
        const burned = toBig(word(await ethCall(addr, SEL.balanceOf + encAddr(BURN)), 0));
        let inPool = 0n, pool = null, poolState = {};
        if (migrated) {
          const factory = toAddr(word(await ethCall(platform, SEL.v3Factory), 0));
          const usdc = toAddr(word(await ethCall(platform, SEL.usdc), 0));
          const p = toAddr(word(await ethCall(factory, SEL.getPool + encAddr(addr) + encAddr(usdc) + encUint(10000)), 0));
          if (!/^0x0{40}$/.test(p)) {
            pool = p;
            inPool = toBig(word(await ethCall(addr, SEL.balanceOf + encAddr(p)), 0));
            // The API reads a migrated coin's pool live; this is what it falls back on when the
            // chain does not answer it, dated by poolReadAt, which a failed read carries over
            // with the rest so an old read never passes for a new one. Not a reason to publish:
            // the pool moves with every swap. Its own try: a failure here must not cost the
            // coin its fresh migrated and pool, which decide its venue.
            try {
              poolState = {
                poolSqrtPriceX96: toBig(word(await ethCall(p, SEL.slot0), 0)).toString(),
                poolUsdc: toBig(word(await ethCall(usdc, SEL.balanceOf + encAddr(p)), 0)).toString(),
                poolReadAt: Math.floor(Date.now() / 1000),
              };
            } catch {
              const was = before.get(addr.toLowerCase()) || {};
              if (was.pool === p) for (const k of ["poolSqrtPriceX96", "poolUsdc", "poolReadAt"]) if (k in was) poolState[k] = was[k];
            }
          }
        }
        supply = { migrated, reopened, burned: burned.toString(), inPool: inPool.toString(), ...(pool ? { pool, ...poolState } : {}) };
      } catch {
        // A failed read publishes what the last file knew rather than less: dropping these
        // would flip a coin's venue and supply until the next run, and publish the flip.
        const was = before.get(addr.toLowerCase()) || {};
        for (const k of GRADUATED_FIELDS) if (k in was) supply[k] = was[k];
      }
    }
    // $NOAH is Noah's Ark; its on-chain name reads "Noah's Arc" on purpose, for the chain it
    // was the first coin to launch on, and cannot be edited. The index and the cards show the ark.
    if (net.noah && addr.toLowerCase() === net.noah.toLowerCase()) name = "Noah's Ark";
    tokens.push({ addr, name, symbol, ...info, ...supply });
  }

  const earliest = tokens.length ? Math.min(...tokens.map((t) => t.createdBlock)) : Number(tip);
  // Resume from the cache when it covers the same platform and starts no later
  // than the oldest token; otherwise (new deployment, older token discovered)
  // fall back to a full walk, which is correct if slow.
  const prior = loadFloorCache();
  const usable = prior && prior.platform === platform && prior.lo <= earliest && prior.hi < Number(tip);
  const from = BigInt(usable ? prior.hi + 1 : earliest);
  const lo = usable ? prior.lo : earliest;

  const logs = from <= tip ? await fetchLogs(platform, from, tip, [TOPIC_TRADE, TOPIC_COMMENT], log) : [];
  log(`floor: ${logs.length} new events from block ${from}${usable ? " (incremental)" : " (full scan)"}`);

  const index = buildIndex(logs, lo, Number(tip), usable ? prior.index : null);
  // The pools of migrated coins, next to the curve's index. A failure here keeps the pools as
  // the last run left them and costs the rest of the run nothing.
  let poolEvents = 0;
  try {
    const r = await indexPools(platform, tokens, index, usable ? prior.index.pool : null, Number(tip), log);
    if (Object.keys(r.pool).length) index.pool = r.pool;
    poolEvents = r.events;
    if (poolEvents) log(`floor: ${poolEvents} new swaps in the pools of migrated coins`);
  } catch (e) {
    log(`floor: pool index failed: ${(e && e.message) || e}`);
    if (usable && prior.index.pool) index.pool = prior.index.pool;
  }
  // Holders from the coins' Transfer logs (see indexHolders); their state goes to the cache and
  // only the per-coin figures to the index. Anything failing here keeps the last state.
  const priorHold = prior && prior.platform === platform ? prior.hold || null : null;
  let holdState = priorHold;
  try {
    const r = await indexHolders(platform, tokens, priorHold, Number(tip), log);
    holdState = r.state;
    if (r.stats) index.hold = r.stats;
  } catch (e) {
    log(`floor: holders index failed: ${(e && e.message) || e}`);
    if (priorHold && priorHold.stats) index.hold = priorHold.stats;
  }
  const holdMoved = JSON.stringify((index.hold || {}).coins || null) !== JSON.stringify((readPublishedHold() || {}).coins || null);
  if (holdMoved && index.hold) log("floor: holder figures changed");
  // Publishing costs a deployment, so say plainly whether anything actually moved.
  // A launch with no trade yet emits no Trade log, hence the token-count check.
  // A new schema is published once even on a quiet chain: the page refuses a file
  // in the old shape and would fall back to scanning the chain for itself.
  // A coin that graduated, moved into Uniswap or was reopened since the last file publishes
  // too: only the graduating buy leaves a Trade log.
  const moved = tokens.filter((t) => venueState(t) !== venueState(before.get(t.addr.toLowerCase())));
  if (moved.length) log(`floor: venue state moved for ${moved.map((t) => t.symbol || t.addr).join(", ")}`);
  const changed = logs.length > 0 || poolEvents > 0 || holdMoved || !usable || tokens.length !== (prior?.tokenCount ?? -1) || prior.schema !== SCHEMA || moved.length > 0;
  saveFloorCache({ schema: SCHEMA, platform, lo, hi: Number(tip), tokenCount: tokens.length, index, hold: holdState });

  const payload = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    platform,
    tip: Number(tip),
    blockTimeSec,
    gradTarget,
    tokens,
    index,
  };
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  atomicWrite(OUT_FILE, JSON.stringify(payload));

  // one shareable page per coin, so a link posted to X shows the coin
  const chainLabel = liveNetwork().mainnet ? "Arc Network" : "Arc Testnet";
  await writeCards(tokens, platform, chainLabel, log);
  const kb = Math.round(JSON.stringify(payload).length / 1024);
  log(`floor: ${tokens.length} tokens, ${index.recent.length} recent trades, ${kb} KB` +
      `${changed ? "" : " (unchanged)"} -> docs/data/floor.json`);
  return { tokens: tokens.length, events: logs.length, tip: Number(tip), kb, changed };
}

// allow a direct run for testing: node monitor/floor.mjs 0x<platform>
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = process.argv[2] || livePlatform();
  if (!arg) { console.error("platform address not found"); process.exit(1); }
  await runFloor({ platform: arg });
}
