/**
 * The weekly prize board on AnewOne.Fun: USDC volume per wallet for this week and last week.
 *
 * A week runs from Sunday 09:00 UTC, when the draw is held, to the next Sunday 09:00 UTC. Volume is the trade's USDC
 * value, the amount the 1.5% fee is taken from: what a buyer paid, or what a seller got before
 * the fee. The prize pot is the same amount as the $NOAH buy & burn, half of the platform's 1%
 * slice, so 0.5% of the week's volume (team trades included, since they pay the fee too);
 * it is split equally between 3 wallets drawn from the Top 10. Team wallets are not ranked.
 *
 * The state lives in its own cache (week-cache.json) so the floor's cache shape is untouched.
 * floor.mjs hands over the Trade logs it already fetched; this module only fetches on its own
 * to fill a gap (the scanner was down) or to rebuild after a missed week.
 *
 *   node monitor/week.mjs            builds the cache from the chain with ALCHEMY_ARC_RPC and prints the board
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { atomicWrite, teamWallets } from "./snapshot.mjs";

const MON = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(MON, "week-cache.json");
export const TOPIC_TRADE = "0xf7dd8a134438de4c59401760e24ef5c6cc9c74583b2b022085697f3021e59768";
const WEEK = 7 * 86400;
const BPS = 10_000n;
const BUDGET_BPS = 50n; // half of the platform's 100 bps slice
const WINNERS = 3n;

// The draw is every Sunday at 09:00 UTC; that minute closes one week and opens the next.
const DRAW_HOUR = 9;
// the Sunday 09:00 UTC that opened the week holding ts (1970-01-04 was a Sunday)
export const weekStart = (ts) => {
  const d = Math.floor((ts - DRAW_HOUR * 3600) / 86400);
  return (d - ((d + 4) % 7)) * 86400 + DRAW_HOUR * 3600;
};
const weekId = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

function load() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    const w = (x) => x && { ...x, all: BigInt(x.all), vol: Object.fromEntries(Object.entries(x.vol).map(([a, v]) => [a, BigInt(v)])) };
    return { platform: c.platform, hi: c.hi, starts: c.starts || {}, weeks: (c.weeks || []).map(w) };
  } catch { return null; }
}
function save(st) {
  const w = (x) => ({ ...x, all: x.all.toString(), vol: Object.fromEntries(Object.entries(x.vol).map(([a, v]) => [a, v.toString()])) });
  try { atomicWrite(CACHE_FILE, JSON.stringify({ platform: st.platform, hi: st.hi, starts: st.starts, weeks: st.weeks.map(w) })); } catch {}
}

// first block with a timestamp at or after ts
async function blockAt(rpc, ts, tip) {
  const time = async (n) => Number(BigInt((await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp));
  let lo = 0, hi = tip;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await time(mid)) < ts) lo = mid + 1; else hi = mid; }
  return lo;
}

function summary(w, team, final) {
  const ranked = Object.entries(w.vol).filter(([a]) => !team.has(a)).sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const budget = (w.all * BUDGET_BPS) / BPS;
  return {
    id: w.id, start: new Date(w.startTs * 1000).toISOString(), end: new Date((w.startTs + WEEK) * 1000).toISOString(),
    startBlock: w.startBlock, final,
    volume: w.all.toString(), burn: budget.toString(), prize: budget.toString(), each: (budget / WINNERS).toString(),
    trades: w.n, traders: ranked.length,
    // every ranked wallet, not just ten: the page adds the trades it reads live on top of this
    top: ranked.map(([a, v]) => ({ a, v: v.toString() })),
  };
}

/**
 * Brings the two weeks up to `tip` and returns { week, lastWeek, rolled } for floor.json.
 * logs/logsFrom: the Trade (and other) logs the caller already read over [logsFrom, tip].
 * getLogs(from, to): Trade logs over a block range, for gaps.
 */
export async function indexWeek({ platform, rpc, getLogs, tip, tipTs, logs = [], logsFrom = tip + 1, feeBps, log = () => {} }) {
  const team = teamWallets();
  const fee = BigInt(feeBps);
  const curTs = weekStart(tipTs), prevTs = curTs - WEEK;
  const cached = load();
  // another deployment (testnet, a redeploy) starts the board over
  const st = cached && String(cached.platform).toLowerCase() === String(platform).toLowerCase()
    ? cached : { platform, hi: -1, starts: {}, weeks: [] };
  for (const ts of [prevTs, curTs]) if (st.starts[ts] == null) st.starts[ts] = await blockAt(rpc, ts, tip);
  for (const k of Object.keys(st.starts)) if (Number(k) < prevTs) delete st.starts[k];

  // keep a week from the cache only when it was read up to st.hi with nothing missing
  const fresh = (ts) => ({ id: weekId(ts), startTs: ts, startBlock: st.starts[ts], all: 0n, n: 0, vol: {} });
  const pick = (ts) => st.weeks.find((w) => w.startTs === ts) || (st.starts[ts] > st.hi ? fresh(ts) : null);
  let weeks = [pick(prevTs), pick(curTs)];
  let from = st.hi + 1;
  if (weeks.some((w) => !w) || st.hi < st.starts[prevTs] - 1) {
    log(`week: rebuilding from block ${st.starts[prevTs]}`);
    weeks = [fresh(prevTs), fresh(curTs)];
    from = st.starts[prevTs];
  }
  const rolled = !st.weeks.some((w) => w.startTs === curTs);

  // whatever the caller did not read: a gap after the cache, or the whole rebuild
  let trades = logs.filter((l) => l.topics[0] === TOPIC_TRADE);
  if (from < logsFrom) {
    const gap = await getLogs(from, Math.min(logsFrom - 1, tip));
    log(`week: read ${gap.length} trades from block ${from} to ${Math.min(logsFrom - 1, tip)}`);
    trades = gap.concat(trades);
  }
  let applied = 0;
  for (const l of trades) {
    const bn = Number(BigInt(l.blockNumber));
    if (bn < from || bn > tip) continue;
    const w = bn >= weeks[1].startBlock ? weeks[1] : bn >= weeks[0].startBlock ? weeks[0] : null;
    if (!w) continue;
    const trader = "0x" + l.topics[2].slice(26).toLowerCase();
    const isBuy = BigInt(l.topics[3]) === 1n;
    const usdc = BigInt("0x" + l.data.slice(2, 66));
    const value = isBuy ? usdc : (usdc * BPS) / (BPS - fee); // a sell logs what the seller got after the fee
    w.all += value; w.n++;
    w.vol[trader] = (w.vol[trader] || 0n) + value;
    applied++;
  }
  st.hi = tip;
  st.weeks = weeks;
  save(st);
  if (applied) log(`week: ${applied} trades applied, week of ${weeks[1].id}`);
  return { week: summary(weeks[1], team, false), lastWeek: summary(weeks[0], team, true), rolled };
}

// standalone: build the cache with Alchemy's wide log ranges and print the board
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const env = Object.fromEntries(readFileSync(path.join(MON, "..", ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, "")]));
  const URL_ = env.ALCHEMY_ARC_RPC;
  if (!URL_) { console.error("ALCHEMY_ARC_RPC missing from .env"); process.exit(1); }
  const rpc = async (method, params) => {
    const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
  };
  const platform = process.argv[2] || "0x3DDA5AD5E74c658aff3d082AFe404a71615B1bc5";
  const getLogs = async (a, b) => {
    const out = [];
    for (let x = a; x <= b; x += 500_000) {
      out.push(...await rpc("eth_getLogs", [{ address: platform, topics: [TOPIC_TRADE], fromBlock: "0x" + x.toString(16), toBlock: "0x" + Math.min(b, x + 499_999).toString(16) }]));
    }
    return out;
  };
  const tip = Number(BigInt(await rpc("eth_blockNumber", [])));
  const tipTs = Number(BigInt((await rpc("eth_getBlockByNumber", ["0x" + tip.toString(16), false])).timestamp));
  const feeBps = Number(BigInt(await rpc("eth_call", [{ to: platform, data: "0xbf333f2c" }, "latest"])));
  const r = await indexWeek({ platform, rpc, getLogs, tip, tipTs, feeBps, log: console.log });
  const usd = (w) => (Number(BigInt(w)) / 1e18).toFixed(2);
  for (const [name, w] of [["last week", r.lastWeek], ["this week", r.week]]) {
    console.log(`\n${name} ${w.id} (block ${w.startBlock}): ${w.trades} trades, ${w.traders} traders, volume ${usd(w.volume)}, prize ${usd(w.prize)} = 3 x ${usd(w.each)}`);
    w.top.slice(0, 10).forEach((t, i) => console.log(`  ${i + 1}. ${t.a} ${usd(t.v)}`));
  }
}
