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
import { rpc, fetchLogs, atomicWrite } from "./snapshot.mjs";

const MON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(MON);
const OUT_FILE = path.join(ROOT, "docs", "data", "floor.json");

// Must match STATS_SCHEMA in docs/index.html. A mismatch makes the front end
// ignore the file and fall back to indexing itself, which is the safe direction.
const SCHEMA = 5;

const SEL = {
  tokensCount: "0xa64ed8ba",
  allTokens: "0x634282af",
  info: "0x0aae7a6b",
  gradTarget: "0x9a3a8ee1",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
};
const TOPIC_TRADE = "0xf7dd8a134438de4c59401760e24ef5c6cc9c74583b2b022085697f3021e59768";
const TOPIC_COMMENT = "0x83e5a18f10338a7eb46107a07561cf75d2e07dc4f8d10230f6cfed01cd98b505";
const TOPIC_IMAGE = "0x4fe20d8f61958f75787f29537de90577ad84befe73f9f2c69d2b8a0d95770e16";

/** Where the cards are served from; og:image has to be an absolute URL. */
const SITE = "https://anewone.xyz";
const CARD_DIR = path.join(ROOT, "docs", "t");

// 24h at Arc's ~0.5s blocks. Matches the front end's own window.
const DAY_BLOCKS = 172_800;
const MAX_RECENT = 5000;
const MAX_SERIES = 600;

// The Trade event reports the trader's side of the swap: a buy is quoted before
// the 1% fee is taken out, a sell after. Summing the two raw would overstate
// buys, so both are converted to the amount that actually crossed the curve —
// identical to curveSide() in docs/index.html, and it must stay identical.
const BPS = 10_000n, FEE_BPS = 100n;
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
      series[k] = arr.map((x) => ({ b: x.b, p: BigInt(x.p) }));
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
    ser.push({ b: blockNumber, p: priceWad });

    if (blockNumber >= cutoff) recent.push({ b: blockNumber, tk: token, tr: trader, u: usdc, t: tokens, buy: isBuy });
  }

  // same trimming the browser applies, so the shapes stay interchangeable
  for (const [tk, arr] of Object.entries(series)) {
    arr.sort((x, y) => x.b - y.b);
    const dedup = arr.filter((p, i) => i === 0 || p.b !== arr[i - 1].b || p.p !== arr[i - 1].p);
    series[tk] = dedup.length > MAX_SERIES ? [dedup[0], ...dedup.slice(-(MAX_SERIES - 1))] : dedup;
  }
  // the window slides, so anything that fell out of 24h goes now
  recent = recent.filter((r) => r.b >= cutoff);
  recent.sort((x, y) => x.b - y.b);

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
      .map(([k, arr]) => [k, arr.map((x) => ({ b: x.b, p: x.p.toString() }))])),
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
  return { platform: net.platform, mainnet };
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
      if (j.image && !/\.svg(\?|$)/i.test(j.image)) {
        if (/^https?:\/\//.test(j.image)) return { url: j.image };
        return { url: `${SITE}/${String(j.image).replace(/^\//, "")}` };
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

// ---------------------------------------------------------------- entry point
export async function runFloor({ platform, log = console.log } = {}) {
  if (!platform) throw new Error("runFloor: platform address required");

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

  const tokens = [];
  for (let i = 0; i < count; i++) {
    const addr = toAddr(word(await ethCall(platform, SEL.allTokens + encUint(i)), 0));
    const info = decodeInfo(await ethCall(platform, SEL.info + encAddr(addr)));
    const [name, symbol] = [await callString(addr, SEL.name), await callString(addr, SEL.symbol)];
    tokens.push({ addr, name, symbol, ...info });
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
  // Publishing costs a deployment, so say plainly whether anything actually moved.
  // A launch with no trade yet emits no Trade log, hence the token-count check.
  const changed = logs.length > 0 || !usable || tokens.length !== (prior?.tokenCount ?? -1);
  saveFloorCache({ platform, lo, hi: Number(tip), tokenCount: tokens.length, index });

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
