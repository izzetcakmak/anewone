#!/usr/bin/env node
/**
 * ANEWONE "Boarding Pass" snapshot — the transparent passenger list for the
 * mainnet-day raffle (top 33 most active testnet wallets, 90k/60k/30k $NOAH).
 *
 * Counts every TokenCreated (launch) and Trade (buy/sell) on the current Arc
 * testnet platform contract, ranks wallets by total transactions (ties broken
 * by earliest activity), and writes the FULL list to docs/boarding/snapshot.json
 * so anyone can verify their rank on anewone.xyz/boarding/.
 *
 * Team wallets (deployer + second owner) are excluded from ranking but kept in
 * the list for transparency.
 *
 * CLI:    node monitor/snapshot.mjs [--final]
 * Import: runSnapshot({ final, toBlock, log }) -> summary object
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(MON);
const OUT_DIR = path.join(ROOT, "docs", "boarding");
const OUT_FILE = path.join(OUT_DIR, "snapshot.json");

const RPC = "https://rpc.testnet.arc.network";
const PLATFORM = "0x30c941ed26088DED6c5D4F1571a49f74478DCc84";
// keccak of the event signatures (see src/ANewOne.sol)
const TOPIC_TOKEN_CREATED = "0xfe210c99153843bc67efa2e9a61ec1d63c505e379b9dcf05a9520e84e36e6063"; // TokenCreated(address,address,string,string,string)
const TOPIC_TRADE = "0xf7dd8a134438de4c59401760e24ef5c6cc9c74583b2b022085697f3021e59768"; // Trade(address,address,bool,uint256,uint256,uint256)

const TOP_N = 33;
const RPC_GAP_MS = 150; // Arc public RPC rate limit: single calls, spaced out

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topicToAddr = (t) => "0x" + t.slice(26);

// Known team wallets (public addresses) — the .env read below only ADDS to this,
// so a missing .env (fresh clone, another machine) can never rank the team.
const TEAM_FALLBACK = [
  "0xd4f1254c803662c46d9c21f80f4f3c15ff57e2c9", // deployer / platform owner
  "0x61a4490d589e580ec3d8b29eb87064b1bc61b33f", // second owner
];

function teamWallets() {
  const set = new Set(TEAM_FALLBACK);
  try {
    for (const raw of readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = raw.match(/^(DEPLOYER_ADDRESS|SECOND_OWNER)=(0x[0-9a-fA-F]{40})/);
      if (m) set.add(m[2].toLowerCase());
    }
  } catch {}
  return set;
}

const atomicWrite = (file, data) => {
  writeFileSync(file + ".tmp", data);
  renameSync(file + ".tmp", file);
};

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
      await sleep(500 * (i + 1)); // backoff on rate limit / transient failure
    }
  }
}

// Platform deploy block, from broadcast/Deploy.s.sol/5042002/run-latest.json —
// no logs can exist before it (public RPC is not an archive node, so this is
// hardcoded rather than discovered via historical eth_getCode).
const DEPLOY_BLOCK = 52_625_041;

/**
 * getLogs over [fromBlock, toBlock]. Splits a range ONLY on explicit range/size
 * errors; transient failures (rate limits, timeouts) retry the SAME range with
 * growing backoff — splitting on those just multiplies calls and makes rate
 * limiting worse (learned the hard way on the first full scan).
 */
const MAX_RANGE = 9_999n; // Arc public RPC: "eth_getLogs is limited to a 10,000 range"

async function fetchLogs(fromBlock, toBlock, topic, log) {
  const out = [];
  // pre-chunk at the known range cap — no doomed oversized calls; the bisect
  // below only kicks in for result-size errors within a window
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
        address: PLATFORM,
        topics: [topic],
        fromBlock: "0x" + a.toString(16),
        toBlock: "0x" + b.toString(16),
      }], { retries: 0 });
      out.push(...chunk);
      if (calls % 50 === 0) log?.(`snapshot: ${calls} calls, ${out.length} logs, at block ${b}`);
    } catch (e) {
      const msg = String(e.message || "").toLowerCase();
      const rangeErr = /range|limit exceed|too many|more than|response size|query returned|results/.test(msg);
      if (rangeErr && a < b) {
        const mid = (a + b) >> 1n;
        stack.push([a, mid, 0], [mid + 1n, b, 0]);
      } else if (tries < 6) {
        await sleep(Math.min(2000 * 2 ** tries, 30_000)); // transient: same range, backoff
        stack.push([a, b, tries + 1]);
      } else if (a < b) {
        const mid = (a + b) >> 1n; // last resort before giving up
        stack.push([a, mid, 0], [mid + 1n, b, 0]);
      } else {
        throw new Error(`unfetchable block ${a}: ${e.message}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- incremental cache
// Full history lives here so each run only scans NEW blocks — the final
// mainnet-day snapshot completes in seconds instead of re-walking a million blocks.
const CACHE_FILE = path.join(MON, "snapshot-cache.json");

function loadCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (c.platform === PLATFORM && Number.isInteger(c.toBlock)) return c;
  } catch {}
  return { platform: PLATFORM, toBlock: DEPLOY_BLOCK - 1, wallets: {} };
}

export async function runSnapshot({ final = false, toBlock = null, log = console.log } = {}) {
  const cache = loadCache();
  // when the cache already covers the requested cutoff, no RPC is needed at all —
  // the FINAL snapshot still works even if the testnet RPC is down at cutover
  let latest;
  if (toBlock != null && cache.toBlock >= toBlock) {
    latest = toBlock; // note: served from cache; cache never runs past the freeze in normal flow
  } else {
    latest = toBlock ?? parseInt(await rpc("eth_blockNumber", []), 16);
  }
  const from = cache.toBlock + 1;
  log(`snapshot: cache at block ${cache.toBlock}, scanning ${from} -> ${latest}`);

  if (latest >= from) {
    const [created, trades] = [
      await fetchLogs(BigInt(from), BigInt(latest), TOPIC_TOKEN_CREATED, log),
      await fetchLogs(BigInt(from), BigInt(latest), TOPIC_TRADE, log),
    ];
    const bump = (addr, kind, blockHex) => {
      const block = parseInt(blockHex, 16);
      const w = cache.wallets[addr] ?? { launches: 0, trades: 0, firstBlock: block };
      w[kind]++;
      if (block < w.firstBlock) w.firstBlock = block;
      cache.wallets[addr] = w;
    };
    for (const l of created) bump(topicToAddr(l.topics[2]), "launches", l.blockNumber);
    for (const l of trades) bump(topicToAddr(l.topics[2]), "trades", l.blockNumber);
    cache.toBlock = latest;
    atomicWrite(CACHE_FILE, JSON.stringify(cache));
    log(`snapshot: +${created.length} launches, +${trades.length} trades merged into cache`);
  }

  const team = teamWallets();
  const ranked = [...Object.entries(cache.wallets)]
    .map(([address, w]) => ({
      address,
      launches: w.launches,
      trades: w.trades,
      total: w.launches + w.trades,
      firstBlock: w.firstBlock,
      team: team.has(address),
    }))
    .sort((x, y) => (y.total - x.total) || (x.firstBlock - y.firstBlock));

  let rank = 0;
  for (const w of ranked) {
    w.rank = w.team ? null : ++rank; // team wallets are listed but not ranked
    w.boarding = w.rank !== null && w.rank <= TOP_N;
  }

  const snapshot = {
    campaign: "ANEWONE Boarding Pass — mainnet-day raffle",
    network: "Arc Testnet (chainId 5042002)",
    platform: PLATFORM,
    criteria:
      `Every launch (TokenCreated) and trade (Trade) on the platform contract counts as 1 tx. ` +
      `Wallets ranked by total tx; ties broken by earliest activity. Team wallets excluded from ranking. ` +
      `Top ${TOP_N} wallets enter the raffle: 90,000 / 60,000 / 30,000 $NOAH.`,
    final,
    generatedAt: new Date().toISOString(),
    fromBlock: DEPLOY_BLOCK,
    toBlock: cache.toBlock,
    totalWallets: ranked.filter((w) => !w.team).length,
    totalTxs: ranked.filter((w) => !w.team).reduce((s, w) => s + w.total, 0),
    wallets: ranked,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  atomicWrite(OUT_FILE, JSON.stringify(snapshot, null, 1));
  log(`snapshot: ${snapshot.totalWallets} wallets, ${snapshot.totalTxs} txs -> docs/boarding/snapshot.json${final ? " (FINAL)" : ""}`);
  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runSnapshot({ final: process.argv.includes("--final") });
}
