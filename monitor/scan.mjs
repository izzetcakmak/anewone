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
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, unlinkSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bridgeStep } from "./bridge.mjs";
import { runSnapshot } from "./snapshot.mjs";

const TESTNET_RPC = "https://rpc.testnet.arc.network";
// Leaderboard refresh cadence. Daily was too slow once the campaign was being
// promoted ("every trade moves you up the board" has to be visibly true), and a
// run that is still catching up re-runs on the next tick regardless.
const SNAPSHOT_REFRESH_MS = 6 * 60 * 60 * 1000;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MON = path.join(ROOT, "monitor");
const STATE_FILE = path.join(MON, "state.json");
const LOCK_FILE = path.join(MON, "scan.lock");
const LOG_FILE = path.join(MON, "scan.log");
const CONFIG_JS = path.join(ROOT, "docs", "config.js");
const FORGE = "C:/Users/Monster/.foundry/bin/forge.exe";
// Absolute path: the scheduled task runs with a minimal PATH, so a bare
// "vercel" resolves to nothing there.
const VERCEL = "C:/Users/Monster/AppData/Roaming/npm/vercel.cmd";

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

// Hosts we trust to (a) deploy real funds against and (b) write into docs/config.js for every
// visitor's wallet to connect to. Registry discovery (chainid.network) can PROVE mainnet is
// live, but an unknown host is never auto-trusted: the localDomain()==26 probe is answered by
// the RPC itself, so a hostile RPC can fake it. If only a non-allowlisted RPC responds we alert
// and hold — add a host here (or to STATIC_CANDIDATES) if Arc launches on a new domain.
const TRUSTED_RPC_HOST_SUFFIXES = [
  "arc.network",         // rpc.arc.network, mainnet.arc.network, rpc.<provider>.arc.network, …
  "arc.io",              // rpc.arc.io, mainnet.rpc.arc.io
  "drpc.org",            // arc.drpc.org, arc-mainnet.drpc.org
  "publicnode.com",      // arc.publicnode.com, arc-rpc.publicnode.com
  "ankr.com",            // rpc.ankr.com/arc
  "1rpc.io",             // 1rpc.io/arc
  "llamarpc.com",        // arc.llamarpc.com
  "gateway.tenderly.co", // arc.gateway.tenderly.co
];
function isTrustedRpc(u) {
  let host;
  try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
  return TRUSTED_RPC_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

// ---------------------------------------------------------------- helpers

// Mask known secrets (deployer key, bot token) in anything written to the log or pushed to
// Telegram. Matches by VALUE, not by shape, so public tx/block hashes — also 0x+64 hex — are
// never touched; only the real secret is masked, and only if it ever leaks into a cast error
// string or a stack trace. Populated once env is loaded.
let SECRETS = [];
function redact(s) {
  let out = String(s);
  for (const sec of SECRETS) out = out.split(sec).join("[REDACTED]");
  return out;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${redact(msg)}`;
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
// atomic: a crash mid-write must never wipe the bridge nonce record / frozen cutoff
const saveState = (s) => {
  writeFileSync(STATE_FILE + ".tmp", JSON.stringify(s, null, 2));
  renameSync(STATE_FILE + ".tmp", STATE_FILE);
};

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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
  text = redact(text);
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

/** Rewrite the marked mainnet block in docs/config.js. Returns true only when the
 *  new values are verifiably in the file afterwards.
 *
 *  Never throws. This runs immediately after an irreversible deploy, and an
 *  exception escaping here would skip saveState() and let the next tick deploy a
 *  second platform with a second dev buy. A failed rewrite must degrade to "the
 *  site still says testnet", never to "deploy it again".
 *
 *  Marker-delimited rather than regex-matched: the old /mainnet:\s*\{[^}]*\}/ was
 *  non-global and matched the FIRST "mainnet: {" in the file, so any reordering
 *  that floated web3auth.mainnet to the top would have silently overwritten the
 *  Google-login client id on launch day.
 */
function updateFrontendConfig(rpcUrl, chainId, platform, noah) {
  const START = "/* MAINNET_BLOCK_START";
  const END = "/* MAINNET_BLOCK_END */";
  try {
    const src = readFileSync(CONFIG_JS, "utf8");
    const i = src.indexOf(START);
    const j = src.indexOf(END);
    if (i < 0 || j < 0 || j < i) {
      log("config.js: MAINNET_BLOCK markers missing — refusing to guess; set the block by hand");
      return false;
    }
    const head = src.slice(0, src.indexOf("\n", i) + 1);
    const block = [
      "  mainnet: {",
      "    live: true,",
      "    chainId: " + chainId + ",",
      '    chainIdHex: "0x' + chainId.toString(16) + '",',
      '    rpc: "' + rpcUrl + '",',
      "    explorer: null,",
      '    platform: "' + platform + '",',
      '    noah: "' + noah + '",',
      "  },",
      "",
    ].join("\n");
    const next = head + block + "  " + src.slice(j);
    if (!next.includes('platform: "' + platform + '"') || !next.includes("live: true")) {
      log("config.js: rewrite did not take — leaving the file untouched");
      return false;
    }
    writeFileSync(CONFIG_JS, next);
    return true;
  } catch (e) {
    log("config.js: rewrite failed — " + (e && e.message));
    return false;
  }
}

const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 120_000 });

/** Commit + push docs/config.js so GitHub Pages flips anewone.xyz to mainnet. Best-effort. */
function publishConfig() {
  git(["add", "docs/config.js"]);
  git(["commit", "-m", "feat: mainnet is live — flip anewone.xyz to Arc mainnet"]);
  git(["pull", "--rebase", "origin", "main"]); // snapshot pushes may have landed meanwhile
  const push = git(["push", "origin", "main"]);
  if (push.status !== 0) {
    log(`git push failed: ${(push.stderr || "").slice(0, 400)}`);
    return false;
  }
  return true;
}

/**
 * Boarding-list snapshot -> docs/boarding/snapshot.json, then commit+push.
 * Returns true only when the result actually reached origin — FINAL callers key
 * snapshotFinalDone off this, so a failed push is retried next tick (cache is warm).
 * lastSnapshotAt records the ATTEMPT so a persistently failing refresh backs off a
 * full cycle instead of eating every minute's detection window.
 */
/**
 * Publishes docs/ to Vercel, which is what actually serves anewone.xyz.
 * Deploying straight from the working tree means the live leaderboard never
 * depends on GitHub being reachable — the account restriction of 29 Aug took
 * Pages down for days while snapshots kept generating fine.
 */
function deployToVercel() {
  const r = spawnSync(VERCEL, ["deploy", "--prod", "--yes"], {
    cwd: path.join(ROOT, "docs"),
    encoding: "utf8",
    shell: true,
    timeout: 300_000,
  });
  return { ok: r.status === 0, err: ((r.stderr || "") + (r.stdout || "")).slice(-300) };
}

async function snapshotAndPublish(state, env, { final = false, toBlock = null } = {}) {
  state.lastSnapshotAt = Date.now();
  try {
    const snap = await runSnapshot({ final, toBlock, log });
    // a partial run must come back next tick until the cache reaches the tip
    state.snapshotCatchingUp = snap.catchingUp === true;

    // Live site first: the leaderboard people actually read is on Vercel, and
    // it must update even when the git side is broken.
    const dep = deployToVercel();
    if (dep.ok) {
      log(`snapshot: deployed to Vercel @ block ${snap.toBlock}`);
      if (state.deployFailures) {
        if (env) await notify(env, `✅ ANEWONE: leaderboard deploys recovered after ${state.deployFailures} failure(s).`);
        state.deployFailures = 0;
      }
    } else {
      log(`snapshot deploy failed: ${dep.err}`);
      state.deployFailures = (state.deployFailures ?? 0) + 1;
      if (state.deployFailures === 1 && env) {
        await notify(env, `⚠️ ANEWONE: snapshot generated but the Vercel DEPLOY FAILED — the live leaderboard is stale.\n\n${dep.err}`);
      }
    }

    git(["add", "docs/boarding/snapshot.json"]);
    git(["commit", "-m", `chore: boarding snapshot ${final ? "(FINAL) " : ""}@ block ${snap.toBlock}`]);
    git(["pull", "--rebase", "origin", "main"]);
    const push = git(["push", "origin", "main"]);
    if (push.status !== 0) {
      const why = (push.stderr || "").slice(0, 300);
      log(`snapshot push failed: ${why}`);
      // A push that fails silently leaves a fresh snapshot sitting in a local
      // commit while the site keeps serving a stale one — that went unnoticed
      // for weeks once (wrong GitHub account in the credential store). Alert
      // on the first failure of a streak, not on every retry.
      state.pushFailures = (state.pushFailures ?? 0) + 1;
      // The live site is already updated by the Vercel deploy above, so a failed
      // push only means the public git record is behind — worth one alert, not
      // an emergency.
      if (state.pushFailures === 1 && env) {
        await notify(env, `⚠️ ANEWONE: snapshot is live on the site, but the git PUSH failed — the public repo record is behind.\n\n${why}`);
      }
      return dep.ok;
    }
    if (state.pushFailures) {
      if (env) await notify(env, `✅ ANEWONE: git publishing recovered after ${state.pushFailures} failed push(es).`);
      state.pushFailures = 0;
    }
    return true;
  } catch (e) {
    log(`snapshot failed: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------- main

async function main() {
  // prevent overlapping runs
  if (existsSync(LOCK_FILE)) {
    const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
    if (age < 50_000) return;
    // timers can't fire while spawnSync (forge deploy: up to 300s, cast send: 150s)
    // blocks the event loop, so an old lock may still belong to a LIVE process.
    // Overlapping would risk a double deploy / double burn — trust the lock while
    // its PID is alive (hard cap in case the PID got recycled).
    //
    // The cap used to be 20 minutes, which a long catch-up scan outlived: its
    // lock was stolen, and from then on every scheduler tick started another
    // overlapping scanner. They then rate-limited each other on the same RPC and
    // none of them ever finished. Runs are now budget-capped well under this.
    const pid = parseInt(readFileSync(LOCK_FILE, "utf8"), 10);
    if (age < 45 * 60_000 && pid && isProcessAlive(pid)) return;
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  // refresh during async waits (sweep sleeps, RPC polling); spawnSync gaps are
  // covered by the PID-liveness check above
  const lockTimer = setInterval(() => {
    try { writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
  }, 20_000);

  try {
    const env = loadEnv();
    SECRETS = [env.PRIVATE_KEY, (env.PRIVATE_KEY || "").replace(/^0x/i, ""), env.TELEGRAM_BOT_TOKEN]
      .map((s) => (s || "").trim()).filter((s) => s.length >= 8);
    const state = loadState();
    if (state.phase === "deployed") {
      // launch is done; take the pending FINAL boarding snapshot if it hasn't run yet
      if (state.snapshotFinalDone === false) {
        if (await snapshotAndPublish(state, env, { final: true, toBlock: state.snapshotBlock ?? null })) {
          state.snapshotFinalDone = true;
        }
        saveState(state);
      }
      return;
    }

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
      // every few hours, spend this tick refreshing the boarding leaderboard
      // instead of the full sweep window (one quick sweep still runs first).
      // A run that stopped mid-catch-up is due again immediately, so the
      // backlog is worked off tick by tick rather than in one endless run.
      const snapshotDue = state.snapshotFinalDone !== true && // never overwrite a published FINAL
        (state.snapshotCatchingUp === true ||
          Date.now() - (state.lastSnapshotAt ?? 0) > SNAPSHOT_REFRESH_MS);
      // parallel sweeps every ~12s for the rest of this 1-min invocation window,
      // so effective detection latency is seconds, not a full scheduler tick
      const candidates = [...new Set([...STATIC_CANDIDATES, ...(await registryCandidates())])];
      const deadline = Date.now() + 50_000;
      let sweeps = 0;
      for (;;) {
        sweeps++;
        found = await sweep(candidates);
        if (found) break;
        if (snapshotDue) {
          await snapshotAndPublish(state, env, { final: false });
          state.phase = "scanning";
          state.lastScan = new Date().toISOString();
          saveState(state);
          log(`scan: no Arc mainnet RPC yet (leaderboard refreshed)`);
          return;
        }
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

    // Trust gate: sweep() prefers allowlisted static candidates in list order, so a
    // non-allowlisted `found` means every official RPC was unreachable this tick. Registry
    // discovery can say "mainnet is live", but we never deploy funds against — or publish to
    // visitors — a host we can't vouch for. Alert once and hold for an allowlisted RPC.
    if (!isTrustedRpc(found.url)) {
      if (!state.untrustedRpcNotified) {
        state.untrustedRpcNotified = true;
        saveState(state);
        await notify(env,
          `⚠️ A non-allowlisted RPC reports Arc mainnet is live:\n${found.url}\n` +
          `Not deploying or publishing against it until an official RPC confirms. If mainnet ` +
          `genuinely launched on a new host, add it to STATIC_CANDIDATES / TRUSTED_RPC_HOST_SUFFIXES ` +
          `in monitor/scan.mjs.`);
      }
      log(`untrusted-only mainnet signal from ${found.url}; holding for an allowlisted rpc`);
      return;
    }
    state.untrustedRpcNotified = false;
    state.lastScan = new Date().toISOString();

    if (state.phase === "scanning") {
      state.phase = "awaiting_funds";
      state.rpc = found.url;
      state.chainId = found.chainId;
      // freeze the boarding-raffle cutoff ONCE: testnet activity after this block
      // no longer counts (the heavy log scan itself runs post-deploy, off the hot
      // path). Guarded so an RPC flap + re-detection can't move a published cutoff.
      if (!("snapshotBlock" in state)) {
        let tb = null;
        for (let i = 0; i < 3 && !tb; i++) tb = await rpcCall(TESTNET_RPC, "eth_blockNumber");
        state.snapshotBlock = tb ? parseInt(tb, 16) : null; // null -> retried below, else latest at scan time
        state.snapshotFinalDone = false;
      }
      saveState(state);
      await notify(env,
        `🚨 ARC MAINNET DETECTED!\nRPC: ${found.url}\nchainId: ${found.chainId}\nblock: ${found.block}\n` +
        `Boarding snapshot frozen @ testnet block ${state.snapshotBlock ?? "?"}. Checking deployer gas…`);
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
      // NO heavy work here: the deploy can become possible within seconds (CCTP
      // forwarding mints in ~1 min) and must never wait behind a leaderboard job —
      // the FINAL snapshot runs in the deployed phase. Only retry the cheap cutoff
      // freeze if it failed at detection.
      if (state.snapshotFinalDone === false && state.snapshotBlock == null) {
        const tb = await rpcCall(TESTNET_RPC, "eth_blockNumber");
        if (tb) { state.snapshotBlock = parseInt(tb, 16); saveState(state); }
      }
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

    // The deploy is irreversible and real funds have already moved. Persist that
    // fact BEFORE touching config.js or git: if either fails, the next tick must
    // see phase "deployed" and stop, never deploy a second platform.
    state.phase = "deployed";
    state.platform = dep.platform;
    state.noah = dep.noah;
    state.deployedAt = new Date().toISOString();
    saveState(state);

    const wrote = updateFrontendConfig(found.url, found.chainId, dep.platform, dep.noah);
    const published = wrote && publishConfig();
    const devLine = devBuy > 0n
      ? `Dev buy: ${(Number(devBuy) / 1e18).toFixed(2)} USDC` +
        (dep.devTokens ? ` → ${(Number(BigInt(dep.devTokens)) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} $NOAH` : "") + "\n"
      : "";
    await notify(env,
      `🎉 ANEWONE.XYZ IS LIVE ON ARC MAINNET!\nPlatform: ${dep.platform}\n$NOAH: ${dep.noah}\n` + devLine +
      `RPC: ${found.url} (chainId ${found.chainId})\n` +
      (!wrote
        ? "⚠️ docs/config.js could NOT be rewritten — anewone.xyz is STILL ON TESTNET. Set the mainnet block by hand, then push."
        : published
        ? "docs/config.js pushed — anewone.xyz switches to mainnet as soon as Pages rebuilds (~1 min)."
        : "docs/config.js updated locally but git push FAILED — push manually to flip anewone.xyz to mainnet."));
    log(`DEPLOYED platform=${dep.platform} noah=${dep.noah}`);
  } finally {
    clearInterval(lockTimer);
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exit(1); });
