#!/usr/bin/env node
/**
 * ANEWONE (anewone.xyz) mainnet scanner — runs once per invocation (scheduled every minute).
 *
 * Phase machine (monitor/state.json):
 *   scanning        -> probe candidate RPCs + chainid.network registry for Arc mainnet
 *   awaiting_funds  -> mainnet found; wait until the deployer wallet has gas (USDC)
 *   deployed        -> platform + $NOAH live; config.js updated; nothing left to do
 *
 * On every phase transition it notifies via Telegram (creds in ../.env) and scan.log.
 */
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MON = path.join(ROOT, "monitor");
const STATE_FILE = path.join(MON, "state.json");
const LOCK_FILE = path.join(MON, "scan.lock");
const LOG_FILE = path.join(MON, "scan.log");
const CONFIG_JS = path.join(ROOT, "docs", "config.js");
const FORGE = "C:/Users/Monster/.foundry/bin/forge.exe";

const TESTNET_CHAIN_ID = 5042002; // 0x4cef52 — never treat as mainnet
const KNOWN_FOREIGN_CHAINS = new Set([1243, 1244]); // legacy "ARC" chains unrelated to Circle

const STATIC_CANDIDATES = [
  "https://rpc.arc.network",
  "https://rpc.mainnet.arc.network",
  "https://mainnet.arc.network",
  "https://mainnet-rpc.arc.network",
  "https://rpc-mainnet.arc.network",
  "https://rpc.arc.io",
  "https://mainnet.rpc.arc.io",
  "https://arc.drpc.org",
  "https://arc-mainnet.drpc.org",
  "https://rpc.ankr.com/arc",
];

// ---------------------------------------------------------------- helpers

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) {
      writeFileSync(LOG_FILE, "(truncated)\n");
    }
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function loadEnv() {
  const env = {};
  try {
    for (const raw of readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {}
  return env;
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { phase: "scanning" }; }
}
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

async function rpcCall(url, method, params = [], timeoutMs = 6000) {
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

async function notify(env, text) {
  log(`NOTIFY: ${text.replace(/\n/g, " | ")}`);
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = env;
  if (!tok || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `🕹 ANEWONE\n${text}` }),
    });
  } catch (e) { log(`telegram failed: ${e.message}`); }
}

// ---------------------------------------------------------------- discovery

async function registryCandidates() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch("https://chainid.network/chains.json", { signal: ctl.signal });
    clearTimeout(t);
    const chains = await res.json();
    const urls = [];
    for (const c of chains) {
      if (!/\barc\b/i.test(c.name || "")) continue;
      if ((c.nativeCurrency?.symbol || "").toUpperCase() !== "USDC") continue;
      if (c.chainId === TESTNET_CHAIN_ID || KNOWN_FOREIGN_CHAINS.has(c.chainId)) continue;
      for (const u of c.rpc || []) {
        if (u.startsWith("https://") && !u.includes("${")) urls.push(u);
      }
    }
    return urls;
  } catch { return []; }
}

async function probe(url) {
  const idHex = await rpcCall(url, "eth_chainId");
  if (!idHex) return null;
  const chainId = parseInt(idHex, 16);
  if (!chainId || chainId === TESTNET_CHAIN_ID || KNOWN_FOREIGN_CHAINS.has(chainId)) return null;
  const blockHex = await rpcCall(url, "eth_blockNumber");
  if (!blockHex || parseInt(blockHex, 16) === 0) return null;
  return { url, chainId, block: parseInt(blockHex, 16) };
}

// ---------------------------------------------------------------- deploy

function runDeploy(env, rpcUrl) {
  const res = spawnSync(
    FORGE,
    ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "-vv"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300_000,
      env: {
        ...process.env,
        PRIVATE_KEY: env.PRIVATE_KEY,
        ...(env.VIRTUAL_USDC0 ? { VIRTUAL_USDC0: env.VIRTUAL_USDC0 } : {}),
        ...(env.GRAD_TARGET ? { GRAD_TARGET: env.GRAD_TARGET } : {}),
      },
    }
  );
  const out = (res.stdout || "") + (res.stderr || "");
  const platform = out.match(/ANEWONE_PLATFORM:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  const noah = out.match(/NOAH_TOKEN:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  return { ok: !!(platform && noah), platform, noah, out: out.slice(-2500) };
}

function updateFrontendConfig(rpcUrl, chainId, platform, noah) {
  const src = readFileSync(CONFIG_JS, "utf8");
  const block =
`mainnet: {
    live: true,
    chainId: ${chainId},
    chainIdHex: "0x${chainId.toString(16)}",
    rpc: "${rpcUrl}",
    explorer: null,
    platform: "${platform}",
    noah: "${noah}",
  }`;
  writeFileSync(CONFIG_JS, src.replace(/mainnet:\s*\{[^}]*\}/, block));
}

/** Commit + push docs/config.js so GitHub Pages flips anewone.xyz to mainnet. Best-effort. */
function publishConfig() {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  git(["add", "docs/config.js"]);
  git(["commit", "-m", "feat: mainnet is live — flip anewone.xyz to Arc mainnet\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"]);
  const push = git(["push", "origin", "main"]);
  if (push.status !== 0) {
    log(`git push failed: ${(push.stderr || "").slice(0, 400)}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- main

async function main() {
  // prevent overlapping runs
  if (existsSync(LOCK_FILE)) {
    const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
    if (age < 50_000) return;
  }
  writeFileSync(LOCK_FILE, String(process.pid));

  try {
    const env = loadEnv();
    const state = loadState();
    if (state.phase === "deployed") return;

    // ---- find / re-verify mainnet RPC
    let found = null;
    if (state.phase === "awaiting_funds" && state.rpc) {
      found = await probe(state.rpc);
      if (!found) {
        log(`stored rpc ${state.rpc} stopped responding, back to scanning`);
        state.phase = "scanning";
        state.rpc = null;
      }
    }
    if (!found) {
      const candidates = [...new Set([...STATIC_CANDIDATES, ...(await registryCandidates())])];
      for (const url of candidates) {
        found = await probe(url);
        if (found) break;
      }
    }
    if (!found) {
      state.phase = "scanning";
      state.lastScan = new Date().toISOString();
      saveState(state);
      log("scan: no Arc mainnet RPC yet");
      return;
    }
    state.lastScan = new Date().toISOString();

    if (state.phase === "scanning") {
      state.phase = "awaiting_funds";
      state.rpc = found.url;
      state.chainId = found.chainId;
      saveState(state);
      await notify(env,
        `🚨 ARC MAINNET DETECTED!\nRPC: ${found.url}\nchainId: ${found.chainId}\nblock: ${found.block}\nChecking deployer gas…`);
    }

    // ---- funds check
    const deployer = env.DEPLOYER_ADDRESS;
    const balHex = await rpcCall(found.url, "eth_getBalance", [deployer, "latest"]);
    const bal = balHex ? BigInt(balHex) : 0n;
    const gasPriceHex = await rpcCall(found.url, "eth_gasPrice");
    const gasPrice = gasPriceHex ? BigInt(gasPriceHex) : 0n;
    const need = gasPrice > 0n ? gasPrice * 4_500_000n * 2n : 10n ** 17n; // ~2x deploy estimate

    if (bal < need) {
      if (!state.fundsNotified) {
        state.fundsNotified = true;
        saveState(state);
        await notify(env,
          `⛽ Deployer ${deployer} has ${bal} wei on Arc mainnet — needs ~${need}.\nFund it with USDC (bridge/CCTP) and I deploy automatically on the next scan.`);
      }
      log(`awaiting funds: bal=${bal} need=${need}`);
      return;
    }

    // ---- deploy!
    log(`deploying to ${found.url} (chainId ${found.chainId})…`);
    const dep = runDeploy(env, found.url);
    if (!dep.ok) {
      log(`DEPLOY FAILED:\n${dep.out}`);
      if (!state.deployFailNotified) {
        state.deployFailNotified = true;
        saveState(state);
        await notify(env, `❌ Mainnet deploy attempt failed — check monitor/scan.log. Will keep retrying every minute.`);
      }
      return;
    }

    updateFrontendConfig(found.url, found.chainId, dep.platform, dep.noah);
    const published = publishConfig();
    state.phase = "deployed";
    state.platform = dep.platform;
    state.noah = dep.noah;
    state.deployedAt = new Date().toISOString();
    saveState(state);
    await notify(env,
      `🎉 ANEWONE.XYZ IS LIVE ON ARC MAINNET!\nPlatform: ${dep.platform}\n$NOAH: ${dep.noah}\nRPC: ${found.url} (chainId ${found.chainId})\n` +
      (published
        ? "docs/config.js pushed — anewone.xyz switches to mainnet as soon as Pages rebuilds (~1 min)."
        : "docs/config.js updated locally but git push FAILED — push manually to flip anewone.xyz to mainnet."));
    log(`DEPLOYED platform=${dep.platform} noah=${dep.noah}`);
  } finally {
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exit(1); });
