/**
 * The owner's own Arc mainnet RPC: ARC_MAINNET_RPC in ../.env, optional.
 *
 * Circle hands out private mainnet endpoints before the public launch, and Arc mainnet already
 * runs behind them. So such an endpoint must never decide WHEN to launch: that stays with the
 * public RPCs scan.mjs sweeps, and so does the boarding cutoff. What it does is carry the launch
 * transactions once the public mainnet is up, when the public endpoints are at their busiest.
 * It is used only after it proves to serve the very chain the public RPC serves (same chain id,
 * same block hash a few blocks below both tips, not trailing behind), and it is never written
 * anywhere public: not into config.js, not into a commit, not into a notice.
 *
 * Nothing here throws at the scanner, and every doubt falls back to the public RPC.
 *
 * CLI, read-only, prints no URL:  node monitor/private-rpc.mjs --check
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// How far the own RPC may trail the public one and still carry the launch (~0.5 s blocks).
const MAX_LAG_BLOCKS = 60;

/**
 * Same chain: the two agree on a block a few heights below both tips. Arc's finality is
 * immediate, so a block that far down is final on both if they serve one chain.
 * Returns null when they do, else [reason code, reason].
 */
async function sameChain(rpcCall, pub, own) {
  const [a, b] = await Promise.all([rpcCall(pub, "eth_blockNumber"), rpcCall(own, "eth_blockNumber")]);
  if (!a || !b) return ["tip", "the latest blocks could not be compared"];
  const pubTip = parseInt(a, 16);
  const ownTip = parseInt(b, 16);
  if (pubTip - ownTip > MAX_LAG_BLOCKS) return ["lag", `it trails the public chain by ${pubTip - ownTip} blocks`];
  const n = Math.min(pubTip, ownTip) - 3;
  if (!(n > 0)) return ["young", "the chain is too young to compare"];
  const tag = "0x" + n.toString(16);
  const [x, y] = await Promise.all([
    rpcCall(pub, "eth_getBlockByNumber", [tag, false]),
    rpcCall(own, "eth_getBlockByNumber", [tag, false]),
  ]);
  if (!x?.hash || !y?.hash) return ["block", `block ${n} could not be read from both`];
  if (x.hash !== y.hash) return ["fork", `it serves a different chain (block ${n} differs)`];
  return null;
}

/**
 * The RPC the launch transactions go through: url when it proves itself, else found.url.
 * ctx = { url, found, state, saveState, log, notify, rpcCall, probe }, with scan.mjs's own
 * rpcCall and probe. A reason it is set aside is told once, not every minute.
 */
export async function pickSendRpc(ctx) {
  const { url, found, state, saveState, log, notify, rpcCall, probe } = ctx;
  if (!url || url === found.url) return found.url;
  let why;
  try {
    const own = await probe(url);
    if (!own) why = ["answer", "it does not answer as Arc mainnet"];
    else if (own.chainId !== found.chainId) why = ["chain", `it serves chain ${own.chainId}, not ${found.chainId}`];
    else why = await sameChain(rpcCall, found.url, url);
  } catch {
    why = ["error", "checking it failed"];
  }
  if (!why) {
    log("launch transactions go through ARC_MAINNET_RPC: same chain as the public RPC, block hash verified");
    return url;
  }
  log(`ARC_MAINNET_RPC not used: ${why[1]}; the public RPC carries the launch`);
  if (state.ownRpcNotice !== why[0]) {
    state.ownRpcNotice = why[0];
    saveState(state);
    await notify(`⚠️ Your ARC_MAINNET_RPC is not used for the launch: ${why[1]}. The public RPC carries it instead.`);
  }
  return found.url;
}

// ---------------------------------------------------------------- CLI (read-only)

const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"; // as in scan.mjs
const TESTNET_CHAIN_ID = 5042002;

async function call(url, method, params = []) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return (await res.json())?.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function check() {
  let url = "";
  try {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    for (const raw of readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); // scan.mjs's own loadEnv pattern
      if (m && m[1] === "ARC_MAINNET_RPC") url = m[2];
    }
  } catch {}
  url = url.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  if (!url) return console.log("ARC_MAINNET_RPC is not set: the launch goes through the public RPC.");
  const id = await call(url, "eth_chainId");
  if (!id) return console.log("ARC_MAINNET_RPC does not answer. Check the address.");
  const chainId = parseInt(id, 16);
  if (chainId === TESTNET_CHAIN_ID) {
    return console.log("ARC_MAINNET_RPC answers for Arc TESTNET (chain 5042002), not mainnet.");
  }
  const block = parseInt((await call(url, "eth_blockNumber")) || "0x0", 16);
  const dom = await call(url, "eth_call", [{ to: MESSAGE_TRANSMITTER_V2, data: "0x8d3638f4" }, "latest"]);
  const domain = dom && dom !== "0x" ? BigInt(dom) : null;
  if (!block || domain !== 26n) {
    return console.log(`ARC_MAINNET_RPC answers for chain ${chainId}, but not as Arc mainnet ` +
      `(block ${block}, CCTP domain ${domain ?? "none"}).`);
  }
  console.log(`ARC_MAINNET_RPC works: Arc mainnet (chain ${chainId}), block ${block}, CCTP domain 26. ` +
    "At launch it carries the transactions once it proves to serve the same chain as the public RPC; " +
    "the launch itself still waits for the public mainnet.");
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  if (process.argv.includes("--check")) await check();
  else console.log("usage: node monitor/private-rpc.mjs --check");
}
