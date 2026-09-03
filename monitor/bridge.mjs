#!/usr/bin/env node
/**
 * ANEWONE CCTP V2 bridge — Base mainnet -> Arc mainnet via Circle's Forwarding Service.
 *
 * Burns BRIDGE_AMOUNT_USDC (default 10) USDC on Base with depositForBurnWithHook and the
 * "cctp-forward" hook, so Circle broadcasts the mint on Arc itself — the deployer needs
 * NO gas on Arc for the funds to arrive (forward fee ~0.02 USDC comes out of the mint).
 *
 * Driven by scan.mjs once Arc mainnet is detected. Sub-state machine in state.json:
 *   bridge.phase: idle -> burning -> burned -> attested
 * (scan.mjs then sees the native USDC balance on Arc and deploys with the dev buy)
 *
 * Double-burn safety: the burn nonce is fetched and persisted BEFORE broadcasting and the
 * tx is sent with an explicit --nonce, so a crashed or retried run can never burn twice —
 * a second send with the same nonce cannot confirm alongside the first.
 *
 * CLI (read-only, never sends a tx):  node monitor/bridge.mjs --status
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(MON);
const ATTESTATION_FILE = path.join(MON, "bridge-attestation.json");
const CAST = "C:/Users/Monster/.foundry/bin/cast.exe";

// ---- Base mainnet + CCTP V2 constants (Circle docs, verified 2026-07)
const BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
];
const BASE_CHAIN_ID = 8453;
const BASE_DOMAIN = 6;
const ARC_DOMAIN = 26;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // 6 decimals
const TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"; // same on Arc mainnet (uniform EVM addresses)
const IRIS = "https://iris-api.circle.com";
// 32-byte "cctp-forward" magic: tells Circle's Forwarding Service to relay the mint on Arc
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
const FAST_THRESHOLD = 1000; // fast transfer; anything <1000 is treated as 1000 by CCTP
const MAX_FEE_CAP = 200_000n; // 0.20 USDC — abort if protocol+forward fees ever exceed this

const ZERO32 = "0x" + "0".repeat(64);
/** EVM address -> CCTP bytes32 mintRecipient. Strict on purpose: a malformed recipient here
 *  is not a failed transaction, it is USDC minted to an address nobody controls. */
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const b32 = (addr) => {
  if (!ADDR_RE.test(String(addr))) throw new Error(`refusing to bridge to a malformed recipient: ${addr}`);
  return "0x" + "0".repeat(24) + String(addr).slice(2).toLowerCase();
};
const padUint = (n) => n.toString(16).padStart(64, "0");

// ---------------------------------------------------------------- low-level

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result ?? null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function pickBaseRpc() {
  for (const url of BASE_RPCS) {
    const id = await rpcCall(url, "eth_chainId");
    if (id && parseInt(id, 16) === BASE_CHAIN_ID) return url;
  }
  return null;
}

const ethCall = async (rpc, to, data) => rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
const asBig = (hex) => (hex ? BigInt(hex) : 0n);

async function usdcBalance(rpc, addr) {
  return asBig(await ethCall(rpc, USDC_BASE, "0x70a08231" + padUint(BigInt(addr))));
}
async function usdcAllowance(rpc, owner, spender) {
  return asBig(await ethCall(rpc, USDC_BASE, "0xdd62ed3e" + padUint(BigInt(owner)) + padUint(BigInt(spender))));
}
async function remoteMessengerRegistered(rpc) {
  const r = await ethCall(rpc, TOKEN_MESSENGER_V2, "0x82a5e665" + padUint(BigInt(ARC_DOMAIN)));
  return r && r !== ZERO32;
}

async function fetchJson(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

/** Live CCTP fees for Base->Arc incl. Forwarding Service. Returns maxFee in USDC minor units. */
async function computeMaxFee(amount) {
  const fees = await fetchJson(`${IRIS}/v2/burn/USDC/fees/${BASE_DOMAIN}/${ARC_DOMAIN}?forward=true`);
  if (!Array.isArray(fees)) return null;
  const fast = fees.find((f) => f.finalityThreshold === FAST_THRESHOLD) ?? fees[0];
  if (!fast) return null;
  const protocolFee = BigInt(Math.ceil(Number(amount) * (fast.minimumFee ?? 0) / 10_000));
  const fw = fast.forwardFee ?? {};
  const forwardFee = BigInt(fw.high ?? fw.med ?? fw.medium ?? fw.low ?? 0);
  if (forwardFee === 0n) return null; // forwarding not offered on this route right now
  return { maxFee: (protocolFee + forwardFee) * 2n, protocolFee, forwardFee }; // 2x headroom
}

function castSend(env, rpc, nonce, to, sig, args, timeoutMs = 150_000) {
  const res = spawnSync(
    CAST,
    ["send", to, sig, ...args, "--rpc-url", rpc, "--private-key", env.PRIVATE_KEY,
     "--nonce", String(nonce), "--timeout", "120", "--json"],
    { encoding: "utf8", timeout: timeoutMs }
  );
  const out = (res.stdout || "") + (res.stderr || "");
  const m = (res.stdout || "").match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, out: out.slice(-800) };
  try {
    const receipt = JSON.parse(m[0]);
    const ok = receipt.status === "0x1" || receipt.status === 1 || receipt.status === "1";
    return { ok, tx: receipt.transactionHash, out: out.slice(-800) };
  } catch { return { ok: false, out: out.slice(-800) }; }
}

async function fetchMessage(burnTx) {
  const j = await fetchJson(`${IRIS}/v2/messages/${BASE_DOMAIN}?transactionHash=${burnTx}`);
  return j?.messages?.[0] ?? null;
}

function saveAttestation(msg, arcRpc) {
  const manualMintCommand =
    `cast send ${MESSAGE_TRANSMITTER_V2} "receiveMessage(bytes,bytes)" ${msg.message} ${msg.attestation} ` +
    `--rpc-url ${arcRpc || "<ARC_MAINNET_RPC>"} --private-key <KEY_WITH_USDC_GAS_ON_ARC>`;
  writeFileSync(ATTESTATION_FILE, JSON.stringify({ ...msg, manualMintCommand }, null, 2));
}

// ---------------------------------------------------------------- state machine

/**
 * One bridge step per scan tick. ctx = { env, state, saveState, log, notify, arcRpc }.
 * Mutates ctx.state.bridge and persists via ctx.saveState.
 */
export async function bridgeStep(ctx) {
  const { env, state, saveState, log, notify, arcRpc } = ctx;
  const br = (state.bridge ??= { phase: "idle" });
  const save = () => { state.bridge = br; saveState(state); };

  const amount = parseUsdc6(env.BRIDGE_AMOUNT_USDC || "10");
  const recipient = env.MINT_RECIPIENT || env.DEPLOYER_ADDRESS;

  if (br.phase === "idle") {
    // ---- preflight (all read-only; abort quietly and retry next tick on any miss)
    const fail = async (why, permanent = false) => {
      br.preflightFails = (br.preflightFails || 0) + 1;
      if (br.preflightFails === 1 || br.preflightFails % 30 === 0) {
        await notify(`🌉 Bridge preflight blocked: ${why}${permanent ? "" : " — retrying every scan."}`);
      }
      log(`bridge preflight: ${why}`);
      save();
    };

    if (!env.PRIVATE_KEY || !recipient) return fail("PRIVATE_KEY / DEPLOYER_ADDRESS missing in .env", true);
    // Checked before any broadcast: the funds are minted on Arc to whatever this says, and a
    // typo that is still 40 hex characters would be an unrecoverable send to a dead address.
    if (!ADDR_RE.test(recipient)) {
      return fail(`MINT_RECIPIENT/DEPLOYER_ADDRESS is not a 20-byte hex address: ${recipient}`, true);
    }
    const rpc = await pickBaseRpc();
    if (!rpc) return fail("no healthy Base RPC");
    if (!(await remoteMessengerRegistered(rpc))) return fail("Arc domain 26 not registered on Base TokenMessengerV2 yet");
    const fee = await computeMaxFee(amount);
    if (!fee) return fail("CCTP fees API has no forward-enabled Base->Arc quote yet");
    if (fee.maxFee > MAX_FEE_CAP) return fail(`fee too high: maxFee=${fee.maxFee} minor units (cap ${MAX_FEE_CAP})`);
    const bal = await usdcBalance(rpc, env.DEPLOYER_ADDRESS);
    if (bal < amount) return fail(`USDC balance on Base is ${bal} minor units, need ${amount}`);
    const ethBal = asBig(await rpcCall(rpc, "eth_getBalance", [env.DEPLOYER_ADDRESS, "latest"]));
    if (ethBal < 30_000_000_000_000n) return fail(`ETH gas on Base too low: ${ethBal} wei`); // 0.00003 ETH

    // ---- reserve nonces, persist BEFORE any broadcast
    const nonceHex = await rpcCall(rpc, "eth_getTransactionCount", [env.DEPLOYER_ADDRESS, "latest"]);
    if (nonceHex == null) return fail("could not read nonce");
    let nonce = Number(BigInt(nonceHex));

    const allowance = await usdcAllowance(rpc, env.DEPLOYER_ADDRESS, TOKEN_MESSENGER_V2);
    const needsApprove = allowance < amount;
    br.phase = "burning";
    br.rpc = rpc;
    br.amount = String(amount);
    br.maxFee = String(fee.maxFee);
    br.approveNonce = needsApprove ? nonce : null;
    br.burnNonce = needsApprove ? nonce + 1 : nonce;
    save();

    if (needsApprove) {
      const ap = castSend(env, rpc, nonce, USDC_BASE, "approve(address,uint256)",
        [TOKEN_MESSENGER_V2, String(amount)]);
      if (!ap.ok) { br.phase = "idle"; save(); return fail(`approve failed: ${ap.out.slice(-200)}`); }
      log(`bridge: approved ${amount} USDC to TokenMessengerV2 (${ap.tx})`);
    }

    const burn = castSend(env, rpc, br.burnNonce, TOKEN_MESSENGER_V2,
      "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
      [String(amount), String(ARC_DOMAIN), b32(recipient), USDC_BASE, ZERO32,
       String(fee.maxFee), String(FAST_THRESHOLD), FORWARD_HOOK]);
    if (!burn.ok) {
      // explicit nonce means a retry can never double-burn; safe to go back to idle
      br.phase = "idle";
      save();
      return fail(`burn tx failed: ${burn.out.slice(-300)}`);
    }
    br.phase = "burned";
    br.burnTx = burn.tx;
    br.burnAt = new Date().toISOString();
    save();
    await notify(
      `🔥 ${fmtUsdc6(amount)} USDC burned on Base → CCTP fast transfer to Arc (domain 26).\n` +
      `Recipient: ${recipient}\nTx: https://basescan.org/tx/${burn.tx}\n` +
      `Circle's Forwarding Service will mint on Arc — no gas needed on our side.`);
    // fall through to attestation polling right away
  }

  if (br.phase === "burning") {
    // crashed mid-broadcast last run — nonce comparison tells us if anything landed
    const rpc = br.rpc || (await pickBaseRpc());
    const countHex = rpc && (await rpcCall(rpc, "eth_getTransactionCount", [env.DEPLOYER_ADDRESS, "latest"]));
    if (countHex == null) { log("bridge: recovery check failed, will retry"); return; }
    if (Number(BigInt(countHex)) > br.burnNonce) {
      br.phase = "burned_unknown_tx";
      save();
      await notify(
        `⚠️ Bridge burn tx likely landed but its hash was lost in a crash.\n` +
        `Check https://basescan.org/address/${env.DEPLOYER_ADDRESS} — if the burn is there, ` +
        `funds will still arrive via the Forwarding Service. Auto-bridge is paused.`);
    } else {
      log("bridge: interrupted before broadcast, resetting to idle");
      br.phase = "idle";
      save();
    }
    return;
  }

  if (br.phase === "burned") {
    // fast-transfer attestations usually land in 8-20s; poll briefly each tick
    for (let i = 0; i < 4; i++) {
      const msg = await fetchMessage(br.burnTx);
      if (msg?.status === "complete" && msg.attestation && msg.attestation !== "PENDING") {
        saveAttestation(msg, arcRpc);
        br.phase = "attested";
        br.attestedAt = new Date().toISOString();
        br.forwardState = msg.forwardState ?? null;
        save();
        log(`bridge: attested (forwardState=${br.forwardState}); waiting for mint on Arc`);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    const ageMin = (Date.now() - Date.parse(br.burnAt)) / 60_000;
    if (ageMin > 45 && !br.slowNotified) {
      br.slowNotified = true;
      save();
      await notify(`⏳ CCTP attestation still pending ${Math.round(ageMin)} min after burn ${br.burnTx}. Will keep polling.`);
    }
    return;
  }

  if (br.phase === "attested") {
    // scan.mjs watches the Arc balance and deploys; here we only watchdog the forwarder
    const ageMin = (Date.now() - Date.parse(br.attestedAt)) / 60_000;
    if (ageMin > 10 && !br.manualNotified) {
      const msg = await fetchMessage(br.burnTx);
      if (msg) { saveAttestation(msg, arcRpc); br.forwardState = msg.forwardState ?? null; }
      if (br.forwardState !== "completed") {
        br.manualNotified = true;
        save();
        await notify(
          `⚠️ ${Math.round(ageMin)} min since attestation and the Forwarding Service hasn't minted on Arc yet ` +
          `(forwardState=${br.forwardState}).\nMessage+attestation saved to monitor/bridge-attestation.json — ` +
          `USDC is NOT lost; it can be minted any time by calling receiveMessage on Arc (command in that file).`);
      } else { save(); }
    }
    return;
  }
  // burned_unknown_tx: paused for manual review; nothing to do
}

// ---------------------------------------------------------------- units

/** "10" or "10.5" -> USDC minor units (6 decimals) as BigInt */
export function parseUsdc6(s) {
  const [i, f = ""] = String(s).trim().split(".");
  return BigInt(i || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}
export const fmtUsdc6 = (n) => (Number(n) / 1e6).toFixed(2);

// ---------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const env = {};
  try {
    for (const raw of readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {}
  const amount = parseUsdc6(env.BRIDGE_AMOUNT_USDC || "10");
  console.log("== ANEWONE CCTP bridge preflight (read-only) ==");
  const rpc = await pickBaseRpc();
  console.log("Base RPC:", rpc);
  if (!rpc) process.exit(1);
  console.log("Deployer:", env.DEPLOYER_ADDRESS);
  console.log("Mint recipient:", env.MINT_RECIPIENT || env.DEPLOYER_ADDRESS);
  console.log("Bridge amount:", fmtUsdc6(amount), "USDC");
  console.log("USDC balance on Base:", fmtUsdc6(await usdcBalance(rpc, env.DEPLOYER_ADDRESS)), "USDC");
  console.log("ETH on Base:", asBig(await rpcCall(rpc, "eth_getBalance", [env.DEPLOYER_ADDRESS, "latest"])).toString(), "wei");
  console.log("Allowance to TokenMessengerV2:", (await usdcAllowance(rpc, env.DEPLOYER_ADDRESS, TOKEN_MESSENGER_V2)).toString());
  console.log("Arc domain 26 registered on Base:", await remoteMessengerRegistered(rpc));
  const fee = await computeMaxFee(amount);
  console.log("Fee quote:", fee
    ? `protocol=${fee.protocolFee} forward=${fee.forwardFee} -> maxFee=${fee.maxFee} minor units (${fmtUsdc6(fee.maxFee)} USDC)`
    : "UNAVAILABLE (forwarding not quoted for 6->26 yet)");
}
