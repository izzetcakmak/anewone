#!/usr/bin/env node
/**
 * ANEWONE (anewone.xyz) mainnet scanner — runs once per invocation (scheduled every minute).
 *
 * Phase machine (monitor/state.json):
 *   scanning        -> probe candidate RPCs + chainid.network registry for Arc mainnet
 *   awaiting_funds  -> mainnet found; auto-bridge 10 USDC from Base via CCTP (bridge.mjs),
 *                      then wait until the deployer wallet has gas + dev-buy funds (USDC)
 *   deployed        -> platform + $NOAH live (incl. same-tx dev buy); config.js updated
 *
 * On every phase transition it notifies via Telegram (creds in ../.env) and scan.log.
 */
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bridgeStep } from "./bridge.mjs";

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
  // provider pattern from testnet docs: rpc.<provider>.testnet.arc.network -> mainnet analog
  "https://rpc.blockdaemon.arc.network",
  "https://rpc.drpc.arc.network",
  "https://rpc.quicknode.arc.network",
  "https://rpc.arc.io",
  "https://mainnet.rpc.arc.io",
  "https://arc.drpc.org",
  "https://arc-mainnet.drpc.org",
  "https://rpc.ankr.com/arc",
  "https://arc-rpc.publicnode.com",
  "https://arc.publicnode.com",
  "https://1rpc.io/arc",
  "https://arc.llamarpc.com",
  "https://arc.gateway.tenderly.co",
];

// CCTP V2 MessageTransmitterV2 — uniform mainnet address on every EVM chain.
// On the real Arc mainnet localDomain() MUST return 26; any other chain a candidate
// URL might secretly serve (Ethereum=0, Base=6, ...) fails this check, and it also
// guarantees CCTP is live on Arc before we burn anything on Base.
const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const ARC_CCTP_DOMAIN = 26n;

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

/** "9" or "9.5" -> native USDC wei on Arc (18 decimals) as BigInt */
function parseUnits18(s) {
  const [i, f = ""] = String(s).trim().split(".");
  return BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
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
  // decisive check: only Arc mainnet's CCTP MessageTransmitterV2 answers localDomain()==26
  const dom = await rpcCall(url, "eth_call",
    [{ to: MESSAGE_TRANSMITTER_V2, data: "0x8d3638f4" }, "latest"]);
  if (!dom || dom === "0x" || BigInt(dom) !== ARC_CCTP_DOMAIN) return null;
  return { url, chainId, block: parseInt(blockHex, 16) };
}

/** Probe every candidate in parallel; return the first hit in list-priority order. */
async function sweep(candidates) {
  const results = await Promise.all(candidates.map((u) => probe(u).catch(() => null)));
  return results.find(Boolean) ?? null;
}

// ---------------------------------------------------------------- deploy

function runDeploy(env, rpcUrl, devBuy) {
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
        DEV_BUY_VALUE: (devBuy ?? 0n).toString(),
        ...(env.VIRTUAL_USDC0 ? { VIRTUAL_USDC0: env.VIRTUAL_USDC0 } : {}),
        ...(env.GRAD_TARGET ? { GRAD_TARGET: env.GRAD_TARGET } : {}),
        ...(env.SECOND_OWNER ? { SECOND_OWNER: env.SECOND_OWNER } : {}),
        ...(env.SKIP_FIRST_TOKEN ? { SKIP_FIRST_TOKEN: env.SKIP_FIRST_TOKEN } : {}),
      },
    }
  );
  const out = (res.stdout || "") + (res.stderr || "");
  const platform = out.match(/ANEWONE_PLATFORM:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  const noah = out.match(/NOAH_TOKEN:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  const devTokens = out.match(/DEV_BUY_TOKENS:\s*(\d+)/)?.[1];
  return { ok: !!(platform && noah), platform, noah, devTokens, out: out.slice(-2500) };
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
  // long runs (bridge wait, 5-min forge deploy) must keep the lock fresh so the
  // next minute's invocation doesn't overlap and double-broadcast
  const lockTimer = setInterval(() => {
    try { writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
  }, 20_000);

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
      // parallel sweeps every ~12s for the rest of this 1-min invocation window,
      // so effective detection latency is seconds, not a full scheduler tick
      const candidates = [...new Set([...STATIC_CANDIDATES, ...(await registryCandidates())])];
      const deadline = Date.now() + 50_000;
      let sweeps = 0;
      for (;;) {
        sweeps++;
        found = await sweep(candidates);
        if (found) break;
        const remaining = deadline - Date.now();
        if (remaining < 12_000) {
          state.phase = "scanning";
          state.lastScan = new Date().toISOString();
          saveState(state);
          log(`scan: no Arc mainnet RPC yet (${sweeps} sweeps, ${candidates.length} candidates)`);
          return;
        }
        await new Promise((r) => setTimeout(r, 12_000));
      }
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

    // ---- auto-bridge 10 USDC from Base via CCTP (Forwarding Service mints on Arc)
    if (!env.BRIDGE_DISABLE) {
      try {
        await bridgeStep({
          env, state, saveState, log,
          notify: (text) => notify(env, text),
          arcRpc: found.url,
        });
      } catch (e) { log(`bridge step error: ${e.stack || e}`); }
    }

    // ---- funds check: deploy gas + the same-tx dev buy
    const deployer = env.DEPLOYER_ADDRESS;
    const balHex = await rpcCall(found.url, "eth_getBalance", [deployer, "latest"]);
    const bal = balHex ? BigInt(balHex) : 0n;
    const gasPriceHex = await rpcCall(found.url, "eth_gasPrice");
    const gasPrice = gasPriceHex ? BigInt(gasPriceHex) : 0n;
    const need = gasPrice > 0n ? gasPrice * 4_500_000n * 2n : 10n ** 17n; // ~2x deploy estimate

    const devTarget = parseUnits18(env.DEV_BUY_USDC ?? "9");
    const bridgePending = !env.BRIDGE_DISABLE &&
      ["idle", "burning", "burned", "attested"].includes(state.bridge?.phase ?? "idle");
    const burnAgeMin = state.bridge?.burnAt
      ? (Date.now() - Date.parse(state.bridge.burnAt)) / 60_000 : 0;

    let devBuy = 0n;
    if (bal >= need + devTarget) {
      devBuy = devTarget; // full 9 USDC dev buy
    } else if (bal >= need && (!bridgePending || burnAgeMin > 45)) {
      // bridge finished short / disabled / stuck for 45 min — launch with what we have
      devBuy = bal - need;
      if (devBuy > devTarget) devBuy = devTarget;
    } else {
      if (!state.fundsNotified) {
        state.fundsNotified = true;
        saveState(state);
        await notify(env,
          `⛽ Deployer ${deployer} has ${bal} wei on Arc mainnet — waiting for ~${(need + devTarget)} ` +
          `(gas + ${env.DEV_BUY_USDC ?? "9"} USDC dev buy). Bridge phase: ${state.bridge?.phase ?? "n/a"}.`);
      }
      log(`awaiting funds: bal=${bal} need=${need} devTarget=${devTarget} bridge=${state.bridge?.phase ?? "n/a"}`);
      return;
    }

    // ---- deploy!
    log(`deploying to ${found.url} (chainId ${found.chainId}) devBuy=${devBuy}…`);
    const dep = runDeploy(env, found.url, devBuy);
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
    const devLine = devBuy > 0n
      ? `Dev buy: ${(Number(devBuy) / 1e18).toFixed(2)} USDC` +
        (dep.devTokens ? ` → ${(Number(BigInt(dep.devTokens)) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} $NOAH` : "") + "\n"
      : "";
    await notify(env,
      `🎉 ANEWONE.XYZ IS LIVE ON ARC MAINNET!\nPlatform: ${dep.platform}\n$NOAH: ${dep.noah}\n` + devLine +
      `RPC: ${found.url} (chainId ${found.chainId})\n` +
      (published
        ? "docs/config.js pushed — anewone.xyz switches to mainnet as soon as Pages rebuilds (~1 min)."
        : "docs/config.js updated locally but git push FAILED — push manually to flip anewone.xyz to mainnet."));
    log(`DEPLOYED platform=${dep.platform} noah=${dep.noah}`);
  } finally {
    clearInterval(lockTimer);
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exit(1); });
