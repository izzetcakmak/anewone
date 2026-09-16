#!/usr/bin/env node
/**
 * Finish a CCTP transfer into Arc by hand: fetch Circle's attestation for a source-chain burn
 * and call receiveMessage on Arc's MessageTransmitterV2 from the deployer.
 *
 * For transfers whose relayer is late — Circle's Forwarding Service (hook "cctp-forward") or a
 * third-party route such as LI.FI/Polymer, which bridges over CCTP but mints with its own
 * executor. Anyone may submit an attested message; the USDC always mints to the message's own
 * recipient, so this cannot redirect funds. Refuses to send if Arc already reports the nonce
 * as used (a second receiveMessage would only revert and burn gas).
 *
 *   node monitor/mint-message.mjs <burnTxHash> [--source 6] [--yes]
 *
 * Without --yes it only reports. Needs PRIVATE_KEY + DEPLOYER_ADDRESS in .env and a little
 * native USDC on Arc for gas. Source domain defaults to 6 (Base).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(MON);
const CAST = "C:/Users/Monster/.foundry/bin/cast.exe";
const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const IRIS = "https://iris-api.circle.com";

const args = process.argv.slice(2);
const burnTx = args.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
const yes = args.includes("--yes");
const srcIdx = args.indexOf("--source");
const source = srcIdx >= 0 ? Number(args[srcIdx + 1]) : 6;
if (!burnTx) { console.error("usage: node monitor/mint-message.mjs <burnTxHash> [--source 6] [--yes]"); process.exit(1); }

const env = {};
try {
  for (const raw of readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {}
const rpcArc = env.ARC_MAINNET_RPC || "https://rpc.blockdaemon.mainnet.arc.io";

async function rpc(method, params) {
  const r = await fetch(rpcArc, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const chainId = parseInt(await rpc("eth_chainId", []), 16);
if (chainId !== 5042) { console.error(`Arc RPC ${rpcArc} answered chain ${chainId}, not 5042`); process.exit(1); }

const iris = await (await fetch(`${IRIS}/v2/messages/${source}?transactionHash=${burnTx}`)).json();
const msg = iris && iris.messages && iris.messages[0];
if (!msg) { console.error("Circle has no message for that burn yet (wrong hash or source domain?)"); process.exit(1); }
const body = (msg.decodedMessage && msg.decodedMessage.decodedMessageBody) || {};
console.log(`Circle: status=${msg.status} nonce=${msg.eventNonce} amount=${body.amount} recipient=${body.mintRecipient} forwardState=${msg.forwardState}`);
if (msg.status !== "complete" || !msg.attestation || msg.attestation === "PENDING") {
  console.log("attestation not ready yet — the source chain has not reached finality; try again in a few minutes");
  process.exit(0);
}
const used = await rpc("eth_call", [{ to: MESSAGE_TRANSMITTER_V2, data: "0xfeb61724" + msg.eventNonce.slice(2) }, "latest"]);
if (BigInt(used) === 1n) { console.log("already minted on Arc (nonce used) — nothing to do"); process.exit(0); }
const gas = BigInt(await rpc("eth_getBalance", [env.DEPLOYER_ADDRESS, "latest"]));
console.log(`nonce unused on Arc; deployer gas on Arc: ${(Number(gas) / 1e18).toFixed(4)} USDC`);
if (gas === 0n) { console.error("deployer has no USDC on Arc for gas"); process.exit(1); }
if (!yes) { console.log(`would send receiveMessage from ${env.DEPLOYER_ADDRESS}; add --yes to send`); process.exit(0); }
if (!env.PRIVATE_KEY) { console.error("PRIVATE_KEY missing in .env"); process.exit(1); }

const res = spawnSync(CAST, ["send", MESSAGE_TRANSMITTER_V2, "receiveMessage(bytes,bytes)", msg.message, msg.attestation,
  "--rpc-url", rpcArc, "--private-key", env.PRIVATE_KEY, "--timeout", "120", "--json"], { encoding: "utf8", timeout: 180_000 });
const out = (res.stdout || "") + (res.stderr || "");
const m = (res.stdout || "").match(/\{[\s\S]*\}/);
if (!m) { console.error("cast did not return a receipt:\n" + out.slice(-800)); process.exit(1); }
const rc = JSON.parse(m[0]);
const ok = rc.status === "0x1" || rc.status === 1;
console.log(`receiveMessage ${ok ? "OK" : "REVERTED"}: ${rc.transactionHash}`);
process.exit(ok ? 0 : 1);
