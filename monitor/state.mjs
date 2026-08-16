#!/usr/bin/env node
/**
 * ANEWONE read-cache builder — writes docs/data/state.json, the snapshot the frontend paints
 * from so thousands of visitors load WITHOUT each hammering the RPC. One periodic server-side
 * client does the reads once; browsers fetch a CDN-cached JSON and only touch the RPC for the
 * viewer's own balance and for submitting transactions.
 *
 * Fast by design: the token list comes from eth_call (tokensCount/allTokens/info/name/symbol),
 * NOT a multi-million-block getLogs walk; only the recent trade feed uses a small bounded
 * getLogs window. Immutable token fields (name/symbol) are cached; reserves are refetched each
 * run. Incremental: the feed scans only new blocks after the first pass.
 *
 * CLI:    node monitor/state.mjs
 * Import: buildState({ log }) -> summary   (scan.mjs runs it and pushes docs/data/state.json)
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(MON);
const OUT_DIR = path.join(ROOT, "docs", "data");
const OUT_FILE = path.join(OUT_DIR, "state.json");
const CACHE_FILE = path.join(MON, "state-cache.json");

const RPC = "https://rpc.testnet.arc.network";
const PLATFORM = "0x99Bd23c2DD814055a4A2438912C6b4eD2Ae9Ebcf"; // v6 current
const CHAIN = "Arc Testnet (chainId 5042002)";

const TOPIC_TRADE = "0xf7dd8a134438de4c59401760e24ef5c6cc9c74583b2b022085697f3021e59768";
const SEL = {
  tokensCount: "0xa64ed8ba", // tokensCount()
  allTokens: "0x634282af",   // allTokens(uint256)
  info: "0x0aae7a6b",        // info(address)
  name: "0x06fdde03",        // ERC20 name()
  symbol: "0x95d89b41",      // ERC20 symbol()
};

const MAX_RANGE = 9_999n;      // public RPC caps eth_getLogs at 10k blocks
const FEED_WINDOW = 60_000;    // cold-start feed lookback (incremental thereafter)
const RECENT_TRADES = 300;
const RPC_GAP_MS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topicToAddr = (t) => "0x" + t.slice(26).toLowerCase();
const pad = (n) => n.toString(16).padStart(64, "0");
const atomicWrite = (file, data) => { writeFileSync(file + ".tmp", data); renameSync(file + ".tmp", file); };

let rpcId = 0;
async function rpc(method, params, { retries = 5 } = {}) {
  for (let i = 0; ; i++) {
    await sleep(RPC_GAP_MS);
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++rpcId }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(500 * (i + 1));
    }
  }
}
const ethCall = (data) => rpc("eth_call", [{ to: PLATFORM, data }, "latest"]);
const callTo = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

/** Decode `count` consecutive ABI dynamic strings from returndata/eventdata (no deps). */
function decodeStrings(hex, count) {
  const d = (hex || "0x").replace(/^0x/, "");
  const out = [];
  for (let s = 0; s < count; s++) {
    const offBytes = parseInt(d.slice(s * 64, s * 64 + 64), 16);
    const p = offBytes * 2;
    const lenBytes = parseInt(d.slice(p, p + 64), 16);
    out.push(Buffer.from(d.slice(p + 64, p + 64 + lenBytes * 2), "hex").toString("utf8"));
  }
  return out;
}

async function tokenInfo(addr) {
  const raw = await ethCall(SEL.info + pad(BigInt(addr)));
  const d = raw.replace(/^0x/, "");
  const w = (i) => d.slice(i * 64, (i + 1) * 64);
  const vUsdc = BigInt("0x" + w(3)), tReserve = BigInt("0x" + w(4)), raised = BigInt("0x" + w(5));
  // the 6 fixed words are followed by metadataURI (dynamic string) at the offset in word 6
  const off = parseInt(w(6), 16) * 2;
  const len = parseInt(d.slice(off, off + 64), 16) * 2;
  const metadataURI = Buffer.from(d.slice(off + 64, off + 64 + len), "hex").toString("utf8");
  return {
    creator: "0x" + w(0).slice(24),
    createdBlock: parseInt(w(1), 16),
    graduated: BigInt("0x" + w(2)) === 1n,
    vUsdc: vUsdc.toString(),
    tReserve: tReserve.toString(),
    raised: raised.toString(),
    priceWad: (tReserve > 0n ? (vUsdc * (10n ** 18n)) / tReserve : 0n).toString(),
    metadataURI,
  };
}

/** getLogs over [from,to], pre-chunked at the 10k cap, bisecting only on range/size errors. */
async function fetchTrades(fromBlock, toBlock, log) {
  const out = [];
  const stack = [];
  for (let a = toBlock; a >= fromBlock; ) {
    const lo = a - MAX_RANGE < fromBlock ? fromBlock : a - MAX_RANGE;
    stack.push([lo, a, 0]);
    a = lo - 1n;
  }
  let calls = 0;
  while (stack.length) {
    const [a, b, tries] = stack.pop();
    try {
      calls++;
      const chunk = await rpc("eth_getLogs", [{
        address: PLATFORM, topics: [TOPIC_TRADE],
        fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16),
      }], { retries: 0 });
      out.push(...chunk);
      if (calls % 20 === 0) log?.(`state: ${calls} getLogs, ${out.length} trades, at ${b}`);
    } catch (e) {
      const msg = String(e.message || "").toLowerCase();
      // rate limits must BACK OFF (retry same range), not bisect — only a genuine
      // response-SIZE error (too many logs in one window) is fixed by splitting.
      const sizeErr = /response size|returned more than|too many results|more than \d+ results|limited to \d+ results/.test(msg);
      if (sizeErr && a < b) { const mid = (a + b) >> 1n; stack.push([a, mid, 0], [mid + 1n, b, 0]); }
      else if (tries < 8) { await sleep(Math.min(1000 * 2 ** tries, 20_000)); stack.push([a, b, tries + 1]); }
      else if (a < b) { const mid = (a + b) >> 1n; stack.push([a, mid, 0], [mid + 1n, b, 0]); }
      else throw new Error(`unfetchable block ${a}: ${e.message}`);
    }
  }
  return out;
}

function loadCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (c.v === 2 && c.platform?.toLowerCase() === PLATFORM.toLowerCase()) return c;
  } catch {}
  return { v: 2, platform: PLATFORM, feedToBlock: null, meta: {}, recent: [] };
}

export async function buildState({ log = console.log } = {}) {
  const cache = loadCache();
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);

  // ---- token list from eth_call (no historical getLogs)
  const count = parseInt(await ethCall(SEL.tokensCount), 16);
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const addr = ("0x" + (await ethCall(SEL.allTokens + pad(BigInt(i)))).slice(26)).toLowerCase();
    let m = cache.meta[addr];
    if (!m) { // immutable fields fetched once, then cached
      const [name, symbol] = [decodeStrings(await callTo(addr, SEL.name), 1)[0], decodeStrings(await callTo(addr, SEL.symbol), 1)[0]];
      m = cache.meta[addr] = { addr, name, symbol };
    }
    try {
      const info = await tokenInfo(addr);
      tokens.push({ addr, name: m.name, symbol: m.symbol, ...info });
    } catch (e) { tokens.push({ addr, name: m.name, symbol: m.symbol, infoError: true }); log(`state: info(${addr}) failed: ${e.message}`); }
  }
  tokens.sort((a, b) => (b.createdBlock || 0) - (a.createdBlock || 0));

  // ---- recent trade feed via a bounded, incremental getLogs window
  const from = cache.feedToBlock != null ? cache.feedToBlock + 1 : Math.max(0, latest - FEED_WINDOW);
  if (latest >= from) {
    log(`state: feed scan ${from} -> ${latest}`);
    const logs = await fetchTrades(BigInt(from), BigInt(latest), log);
    for (const l of logs) {
      const d = l.data.replace(/^0x/, "");
      cache.recent.push({
        token: topicToAddr(l.topics[1]),
        trader: topicToAddr(l.topics[2]),
        isBuy: BigInt(l.topics[3]) === 1n,
        usdc: BigInt("0x" + d.slice(0, 64)).toString(),
        tokens: BigInt("0x" + d.slice(64, 128)).toString(),
        priceWad: BigInt("0x" + d.slice(128, 192)).toString(),
        block: parseInt(l.blockNumber, 16),
      });
    }
    cache.recent.sort((x, y) => x.block - y.block);
    if (cache.recent.length > RECENT_TRADES) cache.recent = cache.recent.slice(-RECENT_TRADES);
    cache.feedToBlock = latest;
    atomicWrite(CACHE_FILE, JSON.stringify(cache));
  }

  // ---- per-token volume/trade counts over the cached feed window
  const stats = {};
  for (const t of cache.recent) {
    const s = stats[t.token] ?? (stats[t.token] = { vol: "0", trades: 0 });
    s.vol = (BigInt(s.vol) + BigInt(t.usdc)).toString();
    s.trades++;
  }

  const state = {
    v: 1,
    network: CHAIN,
    platform: PLATFORM,
    generatedAt: new Date().toISOString(),
    block: latest,
    feedWindowStats: true, // vol/trades are over the recent feed window, not all-time
    tokens,
    trades: [...cache.recent].reverse(), // newest first
    stats,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  atomicWrite(OUT_FILE, JSON.stringify(state));
  log(`state: ${tokens.length} tokens, ${cache.recent.length} feed trades -> docs/data/state.json (${(JSON.stringify(state).length / 1024).toFixed(1)} KB)`);
  return { tokens: tokens.length, trades: cache.recent.length, block: latest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildState({});
}
