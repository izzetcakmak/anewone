// One-off traction report for the Arc mainnet platform: launches, trades, unique
// wallets, volume and graduations. Read-only.
// Public endpoints have pruned the platform's early history; the archives in .env still
// have it: Alchemy (ALCHEMY_ARC_RPC, Pay As You Go, wide log ranges) first, the older
// private RPC (ARC_MAINNET_RPC, 10k-block ranges) as the fallback. If Alchemy fails for any
// reason (spending limit hit, credits expired, outage), the whole scan reruns on the fallback
// by itself; stderr says which one answered. Both URLs carry a key, so neither is ever printed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, "")])
);
const SOURCES = [
  { name: "Alchemy", url: env.ALCHEMY_ARC_RPC, chunk: 500000, lanes: 6 }, // Pay As You Go takes wide ranges
  // Not Arc's public RPC: it still has the launch-day history, but rate-limits to about one
  // getLogs every two seconds (measured 24 Oct 2026), so a full pass takes 20+ minutes, and
  // the live floor scanner on this machine shares that budget; a traction run must not starve it.
  // the old private archive: 10k ranges, and since late Sep it often fails the TLS handshake
  { name: "ARC_MAINNET_RPC", url: env.ARC_MAINNET_RPC, chunk: 10000, lanes: 6 },
].filter((s) => s.url);
if (!SOURCES.length) throw new Error("ALCHEMY_ARC_RPC or ARC_MAINNET_RPC missing from .env");
const PLATFORM = "0x3DDA5AD5E74c658aff3d082AFe404a71615B1bc5";

const T = {
  created: "0xfe210c99153843bc67efa2e9a61ec1d63c505e379b9dcf05a9520e84e36e6063",
  trade: "0xf7dd8a134438de4c59401760e24ef5c6cc9c74583b2b022085697f3021e59768",
  graduated: "0x3a11b9c0ca38b86101cb9e6e1dd2f752c31467c6eaa353f931b801a338406de6",
  comment: "0x83e5a18f10338a7eb46107a07561cf75d2e07dc4f8d10230f6cfed01cd98b505",
  migrated: "0xabd0ad51ae0f062ec47f8d5a093b2ab9378f5778866ec8e77148decd301ca4c8",
};

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const addr = (topic) => "0x" + topic.slice(26);
const wad = (hex) => Number(BigInt(hex)) / 1e18;

const DEPLOY_BLOCK = 21063125; // platform creation, 2026-09-15T23:13:18Z
// One full pass over the platform's history on one source: its head, then every log.
async function scan({ url, chunk, lanes }) {
  const head = Number(await rpc(url, "eth_blockNumber", []));
  const ranges = [];
  for (let from = DEPLOY_BLOCK; from <= head; from += chunk) {
    ranges.push([from, Math.min(from + chunk - 1, head)]);
  }
  const logs = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < ranges.length) {
        const [from, to] = ranges[next++];
        for (let attempt = 0; ; attempt++) {
          try {
            const part = await rpc(url, "eth_getLogs", [
              { address: PLATFORM, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) },
            ]);
            logs.push(...part);
            break;
          } catch (e) {
            // a rate limit (429) is worth waiting out; anything else gets a few quick retries
            const limited = /429/.test(String(e && e.message));
            if (attempt >= (limited ? 7 : 4)) throw e;
            await new Promise((r) => setTimeout(r, limited ? 1000 * 2 ** Math.min(attempt, 4) : 400 * (attempt + 1)));
          }
        }
      }
    })
  );
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
  return { head, logs };
}

// Alchemy first; any failure there sends the whole scan to the next source, never a mix of two.
let head, logs;
for (const [i, src] of SOURCES.entries()) {
  try {
    ({ head, logs } = await scan(src));
    console.error(`source: ${src.name}`);
    break;
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 160);
    if (i === SOURCES.length - 1) {
      throw new Error(`${src.name} failed: ${reason}. No source left; docs/data/floor.json (the live scanner's index) still has tokens, trades and volume.`);
    }
    console.error(`${src.name} failed (${reason}); falling back to ${SOURCES[i + 1].name}`);
  }
}

const tokens = new Map();
const traders = new Set();
const creators = new Set();
let buys = 0, sells = 0, buyVol = 0, sellVol = 0, comments = 0;
const graduated = [], migrated = [];
let firstBlock = Infinity, lastBlock = 0;

for (const l of logs) {
  const t0 = l.topics[0];
  const bn = Number(l.blockNumber);
  if (bn < firstBlock) firstBlock = bn;
  if (bn > lastBlock) lastBlock = bn;

  if (t0 === T.created) {
    tokens.set(addr(l.topics[1]), { creator: addr(l.topics[2]), block: bn });
    creators.add(addr(l.topics[2]));
  } else if (t0 === T.trade) {
    traders.add(addr(l.topics[2]));
    const isBuy = BigInt(l.topics[3]) === 1n;
    // data = usdcAmount, tokenAmount, newPriceWad
    const usdc = wad("0x" + l.data.slice(2, 66));
    if (isBuy) { buys++; buyVol += usdc; } else { sells++; sellVol += usdc; }
  } else if (t0 === T.graduated) {
    graduated.push(addr(l.topics[1]));
  } else if (t0 === T.migrated) {
    migrated.push(addr(l.topics[1]));
  } else if (t0 === T.comment) {
    comments++;
  }
}

const blocksPerDay = 86400; // Arc ~1s blocks; used only for a rough window label
console.log(JSON.stringify({
  headBlock: head,
  firstEventBlock: firstBlock === Infinity ? null : firstBlock,
  lastEventBlock: lastBlock || null,
  approxDaysCovered: firstBlock === Infinity ? null : +((head - firstBlock) / blocksPerDay).toFixed(1),
  tokensLaunched: tokens.size,
  uniqueCreators: creators.size,
  uniqueTraders: traders.size,
  trades: buys + sells,
  buys,
  sells,
  buyVolumeUsdc: +buyVol.toFixed(2),
  sellVolumeUsdc: +sellVol.toFixed(2),
  totalVolumeUsdc: +(buyVol + sellVol).toFixed(2),
  graduatedTokens: graduated.length,
  migratedTokens: migrated.length,
  onChainComments: comments,
  totalLogs: logs.length,
}, null, 2));
