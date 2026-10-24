// Partner revenue report for AnewOne.Fun: which coins a partner's link launched, and what the
// platform earned on them, read from the chain alone. Read-only.
//
//   node monitor/partner-report.mjs kairo            # every coin tagged "kairo", all time
//   node monitor/partner-report.mjs kairo 2026-11    # one calendar month (UTC)
//   node monitor/partner-report.mjs "*"              # every coin, tagged or not: a check on the math
//
// How a coin is attributed: a launch through fun/?ref=<code> writes {"r":"<code>"} into the coin's
// metadata, and the launch transaction emits that metadata in TokenCreated. Anyone can rerun this
// against any Arc node and get the same list; nothing depends on a database either side keeps.
//
// How the platform's revenue on a coin is counted, from the contract (src/ANewOne.sol):
//   buy:  fee = paid * 150 / 10000          (Trade.usdcAmount is what the trader paid)
//   sell: fee = gross * 150 / 10000, gross = received * 10000 / 9850
//   pool: after graduation, PoolFeesCollected.usdcFees splits the same way
// and of every fee, 50 bps go to the coin's creator and 100 bps (two thirds) to the platform.
// The partner's share is 50% of that platform part. Figures are USDC; rounding is to the wei.
//
// Reads Arc through the archives in .env (ALCHEMY_ARC_RPC, then ARC_MAINNET_RPC), as
// monitor/traction.mjs does; both URLs carry a key and are never printed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder } from "ethers";

const code = (process.argv[2] || "").toLowerCase();
const month = process.argv[3] || null; // "YYYY-MM"
if (code !== "*" && !/^[a-z0-9-]{2,24}$/.test(code)) { console.error("usage: node monitor/partner-report.mjs <code> [YYYY-MM]"); process.exit(1); }
if (month && !/^\d{4}-\d{2}$/.test(month)) { console.error("month must be YYYY-MM"); process.exit(1); }
const SHARE_BPS = 5000n; // the partner gets half of the platform's part

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, "")])
);
const SOURCES = [
  { name: "Alchemy", url: env.ALCHEMY_ARC_RPC, chunk: 500000, lanes: 6 },
  { name: "ARC_MAINNET_RPC", url: env.ARC_MAINNET_RPC, chunk: 10000, lanes: 6 },
].filter((s) => s.url);
if (!SOURCES.length) throw new Error("ALCHEMY_ARC_RPC or ARC_MAINNET_RPC missing from .env");
const PLATFORM = "0x3DDA5AD5E74c658aff3d082AFe404a71615B1bc5";
const DEPLOY_BLOCK = 21063125;
const T = {
  created: "0xfe210c99153843bc67efa2e9a61ec1d63c505e379b9dcf05a9520e84e36e6063",
  trade: "0xf7dd8a134438de4c59401760e24ef5c6cc9c74583b2b022085697f3021e59768",
  poolFees: "0x251551588ab2fefc5204a992ffe52b797e42bee3b0359226b84003bece36a0b6",
};
const FEE_BPS = 150n, PLATFORM_BPS = 100n, BPS = 10000n;

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
// every platform log from launch day on; a range that fails is retried, never skipped
async function scan({ url, chunk, lanes }) {
  const head = Number(await rpc(url, "eth_blockNumber", []));
  const ranges = [];
  for (let from = DEPLOY_BLOCK; from <= head; from += chunk) ranges.push([from, Math.min(from + chunk - 1, head)]);
  const logs = [];
  let next = 0;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < ranges.length) {
      const [from, to] = ranges[next++];
      for (let attempt = 0; ; attempt++) {
        try { logs.push(...(await rpc(url, "eth_getLogs", [{ address: PLATFORM, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]))); break; }
        catch (e) {
          const limited = /429/.test(String(e && e.message));
          if (attempt >= (limited ? 7 : 4)) throw e;
          await new Promise((r) => setTimeout(r, limited ? 1000 * 2 ** Math.min(attempt, 4) : 400 * (attempt + 1)));
        }
      }
    }
  }));
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  return { head, logs, url };
}
let res;
for (const [i, src] of SOURCES.entries()) {
  try { res = await scan(src); console.error(`source: ${src.name}`); break; }
  catch (e) { if (i === SOURCES.length - 1) throw e; console.error(`${src.name} failed (${String(e.message).slice(0, 120)}); trying ${SOURCES[i + 1].name}`); }
}
const { head, logs, url } = res;

// block times, only for the blocks that matter (a month filter needs them)
const blockTime = new Map();
async function timeOf(bn) {
  if (!blockTime.has(bn)) blockTime.set(bn, Number((await rpc(url, "eth_getBlockByNumber", ["0x" + bn.toString(16), false])).timestamp) * 1000);
  return blockTime.get(bn);
}
const inMonth = async (bn) => {
  if (!month) return true;
  const d = new Date(await timeOf(bn));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` === month;
};

const coder = AbiCoder.defaultAbiCoder();
const coins = new Map(); // token -> { symbol, name, creator, launchedAt, volume, platform }
for (const l of logs) {
  if (l.topics[0] !== T.created) continue;
  const [name, symbol, meta] = coder.decode(["string", "string", "string"], l.data);
  let tag = null;
  try { tag = JSON.parse(meta).r; } catch { /* a URL or empty metadata carries no tag */ }
  if (code !== "*" && String(tag || "").toLowerCase() !== code) continue;
  const token = "0x" + l.topics[1].slice(26);
  coins.set(token, { token, name, symbol, creator: "0x" + l.topics[2].slice(26), block: Number(l.blockNumber), tx: l.transactionHash, trades: 0, fees: 0n, platform: 0n });
}
for (const l of logs) {
  const token = l.topics[1] ? "0x" + l.topics[1].slice(26) : null;
  const c = token && coins.get(token);
  if (!c) continue;
  let fee = 0n;
  if (l.topics[0] === T.trade) {
    const isBuy = BigInt(l.topics[3]) === 1n;
    const [usdc] = coder.decode(["uint256", "uint256", "uint256"], l.data);
    fee = isBuy ? (usdc * FEE_BPS) / BPS : ((usdc * BPS) / (BPS - FEE_BPS) * FEE_BPS) / BPS;
  } else if (l.topics[0] === T.poolFees) {
    const [usdcFees] = coder.decode(["uint256", "uint256"], l.data);
    fee = usdcFees;
  } else continue;
  if (!(await inMonth(Number(l.blockNumber)))) continue;
  c.trades += l.topics[0] === T.trade ? 1 : 0;
  c.fees += fee;
  c.platform += (fee * PLATFORM_BPS) / FEE_BPS;
}

const usd = (wei) => (Number(wei) / 1e18).toFixed(6);
let total = 0n;
console.log(`AnewOne.Fun partner report · code "${code}"${month ? ` · ${month} (UTC)` : " · all time"} · Arc block ${head}`);
console.log(`platform ${PLATFORM} · share ${Number(SHARE_BPS) / 100}% of the platform's part of the fee`);
console.log("");
console.log(["token", "symbol", "launched (block)", "trades", "fees USDC", "platform USDC", "partner USDC"].join("\t"));
for (const c of coins.values()) {
  const share = (c.platform * SHARE_BPS) / BPS;
  total += share;
  console.log([c.token, c.symbol, c.block, c.trades, usd(c.fees), usd(c.platform), usd(share)].join("\t"));
}
console.log("");
console.log(`${coins.size} coin(s) launched through "${code}" · partner total ${usd(total)} USDC`);
