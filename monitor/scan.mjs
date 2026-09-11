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
 * An optional ARC_MAINNET_RPC in ../.env, the owner's own endpoint, carries the launch
 * transactions once the public mainnet is found (private-rpc.mjs); it is never published.
 */
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, unlinkSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bridgeStep } from "./bridge.mjs";
import { runSnapshot } from "./snapshot.mjs";
import { runFloor, livePlatform } from "./floor.mjs";

const TESTNET_RPC = "https://rpc.testnet.arc.network";
// Leaderboard refresh cadence. Daily was too slow once the campaign was being
// promoted ("every trade moves you up the board" has to be visibly true), and a
// run that is still catching up re-runs on the next tick regardless.
const SNAPSHOT_REFRESH_MS = 6 * 60 * 60 * 1000;
/** The floor index is cheap to rebuild but each publish is a deployment. */
const FLOOR_REFRESH_MS = 30 * 60 * 1000;
/**
 * Each publish is a commit, a push and a Vercel build, so this only fires when a
 * trade actually landed — quiet hours cost nothing. At half-hourly that is at
 * most ~48 builds a day on top of the four snapshot ones; widen the interval if
 * the project ever bumps into a deployment cap.
 */
const FLOOR_AUTOPUBLISH = true;

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

// The owner's own Arc mainnet RPC, ARC_MAINNET_RPC in ../.env (optional; see private-rpc.mjs).
// It may carry an API key, so it is masked like one in everything logged or sent: the whole
// URL, and its path and query on their own.
function ownRpc(env) {
  return String(env.ARC_MAINNET_RPC || "").trim().replace(/^(['"])(.*)\1$/, "$2").trim();
}
function ownRpcSecrets(env) {
  const u = ownRpc(env);
  if (!u) return [];
  try {
    const p = new URL(u);
    return [u, p.pathname + p.search];
  } catch {
    return [u];
  }
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

/**
 * Probe every candidate in parallel; return the first hit in list-priority order.
 *
 * Every endpoint that answered correctly is kept, not just the winner: the site
 * reads through a pool, and on launch day there is nobody to assemble one by
 * hand. One endpoint is a single point of failure and, as this week showed, also
 * what decides how many visitors can be served at once.
 */
let verifiedRpcs = [];
async function sweep(candidates) {
  const results = await Promise.all(candidates.map((u) => probe(u).catch(() => null)));
  const ok = results.filter(Boolean);
  if (ok.length) verifiedRpcs = ok.map((r) => r.url);
  return ok[0] ?? null;
}

// ---------------------------------------------------------------- deploy

function runDeploy(env, rpcUrl, devBuy) {
  const res = spawnSync(
    FORGE,
    // --slow: one transaction at a time, each confirmed before the next is sent, so a failed
    // send never leaves later transactions of the same deploy in flight
    ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "-vv"],
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
        // Uniswap v3 for graduation. Deploy.s.sol already defaults these to Uniswap's official
        // Arc mainnet deployment; set them in ../.env only to override that, e.g. all three to
        // the zero address to launch on purpose without migration if Uniswap were not live.
        ...(env.DEX_FACTORY ? { DEX_FACTORY: env.DEX_FACTORY } : {}),
        ...(env.DEX_POSITION_MANAGER ? { DEX_POSITION_MANAGER: env.DEX_POSITION_MANAGER } : {}),
        ...(env.USDC_ERC20 ? { USDC_ERC20: env.USDC_ERC20 } : {}),
      },
    }
  );
  const out = (res.stdout || "") + (res.stderr || "");
  const platform = out.match(/ANEWONE_PLATFORM:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  const noah = out.match(/NOAH_TOKEN:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  const devTokens = out.match(/DEV_BUY_TOKENS:\s*(\d+)/)?.[1];
  // These come from forge's local simulation, printed before a single transaction is sent: they
  // say where the platform and $NOAH WOULD be, not that they are there. landed() decides that.
  return { platform, noah, devTokens, status: res.status, out: out.slice(-2500) };
}

/** Code at addr per the first RPC that answers: true or false, or null if none answered. */
async function codeAt(rpcs, addr) {
  for (const u of [...new Set(rpcs)]) {
    const code = await rpcCall(u, "eth_getCode", [addr, "latest"]);
    if (typeof code === "string") return code !== "0x";
  }
  return null;
}

/**
 * Did a deploy land? Both the platform and $NOAH must have code where forge named them. True,
 * false, or null when no RPC answered. With tries > 1 it looks again every 2 s, for
 * transactions that were sent but not yet included.
 */
async function landed(rpcs, { platform, noah }, tries = 1) {
  let verdict = null;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    const p = await codeAt(rpcs, platform);
    const n = await codeAt(rpcs, noah);
    if (p === true && n === true) return true;
    verdict = p === null || n === null ? null : false;
  }
  return verdict;
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
    // the winner leads, then every other endpoint that verified on the same chain
    const pool = [rpcUrl, ...verifiedRpcs.filter((u) => u !== rpcUrl)];
    const block = [
      "  mainnet: {",
      "    live: true,",
      "    chainId: " + chainId + ",",
      '    chainIdHex: "0x' + chainId.toString(16) + '",',
      '    rpc: "' + rpcUrl + '",',
      // Read pools, seeded with everything that verified. Reorder by hand once
      // each endpoint's limits AND history retention are measured: for logs the
      // deciding property is history — a pruning node serves no token artwork.
      "    rpcs: [" + pool.map((u) => '"' + u + '"').join(", ") + "],",
      "    logRpcs: [" + pool.map((u) => '"' + u + '"').join(", ") + "],",
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
// vercel.cmd is a cmd.exe wrapper that re-launches node off PATH. Under the
// scheduled task that indirection has failed every time since 1 Sep with "the
// system cannot find the path specified", while the CLI itself runs fine in that
// same environment (verified: whoami and --version both succeed through wscript,
// console-less, same cwd, same shell:true). The wrapper is the only layer that
// misbehaves, so try the CLI entry point directly with the node binary already
// running this file, and keep the wrapper as a fallback.
const VC_JS = path.join(path.dirname(VERCEL), "node_modules", "vercel", "dist", "vc.js");

// Candidate entry points, most direct first. The .cmd wrapper is last because it
// re-launches node off PATH, and the scheduled task's PATH does not necessarily
// contain node — which is exactly what "the system cannot find the path specified"
// meant on the runs that failed silently for 15 hours.
const VC_CANDIDATES = [
  VC_JS,
  path.join(process.env.APPDATA || "", "npm", "node_modules", "vercel", "dist", "vc.js"),
  path.join(path.dirname(process.execPath), "node_modules", "vercel", "dist", "vc.js"),
];

function deployToVercel() {
  const cwd = path.join(ROOT, "docs");
  // never depend on the caller's PATH: give the child the node we are already running
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)};${process.env.PATH || ""}` };
  const attempts = [];
  const seen = new Set();
  for (const p of VC_CANDIDATES) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (existsSync(p)) attempts.push([`node ${path.basename(path.dirname(path.dirname(p)))}/vc.js`,
                                      process.execPath, [p, "deploy", "--prod", "--yes"], false]);
  }
  attempts.push(["vercel.cmd", VERCEL, ["deploy", "--prod", "--yes"], true]);
  if (attempts.length === 1) {
    // leave a trail that says which paths were checked, so the next failure
    // does not need another afternoon of guessing
    log(`vercel deploy: no vc.js found; checked ${VC_CANDIDATES.filter(Boolean).join(" | ")}`);
  }
  let err = "no attempt ran";
  if (!existsSync(cwd)) return { ok: false, err: `deploy cwd missing: ${cwd}` };
  for (const [label, cmd, args, shell] of attempts) {
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", shell, timeout: 300_000 });
    if (r.status === 0) return { ok: true, err: "" };
    err = (((r.stderr || "") + (r.stdout || "")).trim() || (r.error ? r.error.code : "status " + r.status)).slice(-300);
    log(`vercel deploy attempt via ${label} failed: ${err}`);
  }
  return { ok: false, err };
}
/**
 * Rebuilds docs/data/floor.json — the prebuilt index the front page hydrates from,
 * so a visitor makes one static fetch instead of ~80 chain calls.
 *
 * Half an hour of staleness costs the browser one extra getLogs to catch up, so
 * the cadence is set by what a deployment costs rather than by freshness. Nothing
 * is published when no trade landed: quiet hours should not burn deployments.
 */
async function refreshFloor(state, env) {
  state.lastFloorAt = Date.now();
  try {
    // whatever config.js currently points the site at — mainnet once it flips
    const r = await runFloor({ platform: livePlatform(), log });
    if (!r.changed) { log("floor: nothing new, nothing to publish"); return; }
    const ok = await publishViaGit(state, env, `chore: floor index @ block ${r.tip}`,
                                   ["docs/data/floor.json"]);
    if (ok) log(`floor: published @ block ${r.tip}`);
  } catch (e) {
    log(`floor refresh failed: ${(e && e.message) || e}`);
  }
}

/**
 * Commits the given paths and pushes; Vercel deploys from the push.
 *
 * A push that fails silently leaves fresh data sitting in a local commit while
 * the site keeps serving a stale one — that went unnoticed for days once, when
 * the credential store handed back a different GitHub account. So a failure is
 * alerted on, and re-alerted every ALERT_REPEAT_MS while it persists rather than
 * only on the first one of a streak.
 */
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;
async function publishViaGit(state, env, message, paths) {
  git(["add", ...paths]);
  const commit = git(["commit", "-m", message]);
  // "nothing to commit" is not a failure: the data simply did not move
  if (commit.status !== 0 && !/nothing to commit/i.test((commit.stdout || "") + (commit.stderr || ""))) {
    log(`publish: commit failed: ${((commit.stderr || "") + (commit.stdout || "")).slice(0, 200)}`);
  }
  git(["pull", "--rebase", "origin", "main"]);
  const push = git(["push", "origin", "main"]);
  if (push.status !== 0) {
    const why = ((push.stderr || "") + (push.stdout || "")).slice(0, 300);
    log(`publish: push failed: ${why}`);
    state.pushFailures = (state.pushFailures ?? 0) + 1;
    const due = Date.now() - (state.lastPushAlertAt ?? 0) > ALERT_REPEAT_MS;
    if ((state.pushFailures === 1 || due) && env) {
      state.lastPushAlertAt = Date.now();
      await notify(env, `⚠️ ANEWONE: data is fresh locally but the PUSH FAILED, so the site is stale ` +
        `(${state.pushFailures} in a row).\n\n${why}`);
    }
    return false;
  }
  if (state.pushFailures) {
    if (env) await notify(env, `✅ ANEWONE: publishing recovered after ${state.pushFailures} failed push(es).`);
    state.pushFailures = 0;
    state.lastPushAlertAt = 0;
  }
  return true;
}

async function snapshotAndPublish(state, env, { final = false, toBlock = null } = {}) {
  state.lastSnapshotAt = Date.now();
  try {
    const snap = await runSnapshot({ final, toBlock, log });
    // a partial run must come back next tick until the cache reaches the tip
    state.snapshotCatchingUp = snap.catchingUp === true;

    // The push IS the deploy: the Vercel project builds from this repo, so one
    // mechanism publishes both the site and the public record. The CLI is no
    // longer involved — it lives inside a virtualised AppData that the scheduled
    // task cannot see at all, which is why deploys failed silently for days.
    return publishViaGit(state, env,
      `chore: boarding snapshot ${final ? "(FINAL) " : ""}@ block ${snap.toBlock}`,
      ["docs/boarding/snapshot.json", "docs/data/floor.json"]);
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
    SECRETS = [env.PRIVATE_KEY, (env.PRIVATE_KEY || "").replace(/^0x/i, ""), env.TELEGRAM_BOT_TOKEN,
      ...ownRpcSecrets(env)]
      .map((s) => (s || "").trim()).filter((s) => s.length >= 8);
    const state = loadState();
    if (state.phase === "deployed") {
      // One missed attempt would leave anewone.xyz on testnet with mainnet contracts live, so
      // the flip is retried every tick until it ships. A push is the deploy; the CLI is only
      // the fallback for a push that fails.
      if (state.configShipped === false) {
        const retry = publishConfig() ? { ok: true, err: "" } : deployToVercel();
        if (retry.ok) {
          state.configShipped = true;
          saveState(state);
          await notify(env, "✅ The mainnet config.js is shipped (retry succeeded); anewone.xyz flips within a minute or two.");
        } else if (!state.shipRetryNotified) {
          state.shipRetryNotified = true;
          saveState(state);
          await notify(env,
            `🚨 anewone.xyz is STILL ON TESTNET — neither the git push nor the Vercel CLI works.\n` +
            `Run by hand: cd "${ROOT}" && git push origin main\n${retry.err}`);
        }
      }
      // launch is done; take the pending FINAL boarding snapshot if it hasn't run yet
      if (state.snapshotFinalDone === false) {
        if (await snapshotAndPublish(state, env, { final: true, toBlock: state.snapshotBlock ?? null })) {
          state.snapshotFinalDone = true;
        }
        saveState(state);
      }
      // Graduations into Uniswap v3, once an owner opens migrations. Loaded on demand and
      // fenced off with its own catch: nothing in migrate.mjs can reach the launch, which is
      // over by the time this phase runs.
      try {
        const { migrateStep } = await import("./migrate.mjs");
        await migrateStep({
          env, state, saveState, log,
          notify: (text) => notify(env, text),
          rpc: state.rpc,
          platform: state.platform,
        });
      } catch (e) {
        log(`migrate step error: ${(e && e.stack) || e}`);
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
      const floorDue = FLOOR_AUTOPUBLISH && !snapshotDue &&
        Date.now() - (state.lastFloorAt ?? 0) > FLOOR_REFRESH_MS;
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
        if (floorDue) {
          await refreshFloor(state, env);
          state.phase = "scanning";
          state.lastScan = new Date().toISOString();
          saveState(state);
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

    // ---- the RPC the launch transactions go through
    // The owner's own Arc mainnet RPC (ARC_MAINNET_RPC in ../.env) when it is set and proves to
    // serve the very chain the public RPC serves; otherwise the public RPC. It never decides
    // WHEN to launch (the public sweep above did, and froze the cutoff), and it is never
    // published: config.js below still gets found.url.
    let sendRpc = found.url;
    if (ownRpc(env) && !state.ownRpcFailed) {
      try {
        const { pickSendRpc } = await import("./private-rpc.mjs");
        sendRpc = await pickSendRpc({
          url: ownRpc(env), found, state, saveState, log,
          notify: (text) => notify(env, text),
          rpcCall, probe,
        });
      } catch (e) {
        sendRpc = found.url;
        log(`own rpc step error: ${(e && e.stack) || e}`);
      }
    }
    const viaOwn = sendRpc !== found.url;
    // reads that decide the launch fall back to the public RPC if the own one stops answering
    const read = async (method, params) =>
      (await rpcCall(sendRpc, method, params)) ?? (viaOwn ? await rpcCall(found.url, method, params) : null);

    let dep = null;
    let devBuy = 0n;
    // ---- an earlier attempt whose transactions landed after it was judged failed: adopt it
    // rather than deploy a second platform and a second $NOAH over it
    for (const a of [...(state.attempts ?? [])].reverse()) {
      const seen = await landed([sendRpc, found.url], a);
      if (seen === null) {
        log(`cannot check an earlier deploy attempt (platform ${a.platform}) yet; waiting`);
        return;
      }
      if (seen) {
        log(`an earlier deploy attempt landed after all (platform ${a.platform}); adopting it`);
        dep = a;
        devBuy = BigInt(a.devBuy ?? "0");
        break;
      }
    }

    if (!dep) {
      // ---- funds check: deploy gas + the same-tx dev buy
      const deployer = env.DEPLOYER_ADDRESS;
      const balHex = await read("eth_getBalance", [deployer, "latest"]);
      const bal = balHex ? BigInt(balHex) : 0n;
      const gasPriceHex = await read("eth_gasPrice", []);
      const gasPrice = gasPriceHex ? BigInt(gasPriceHex) : 0n;
      const need = gasPrice > 0n ? gasPrice * 4_500_000n * 2n : 10n ** 17n; // ~2x deploy estimate

      const devTarget = parseUnits18(env.DEV_BUY_USDC ?? "9");
      const bridgePending = !env.BRIDGE_DISABLE &&
        ["idle", "burning", "burned", "attested"].includes(state.bridge?.phase ?? "idle");
      const burnAgeMin = state.bridge?.burnAt
        ? (Date.now() - Date.parse(state.bridge.burnAt)) / 60_000 : 0;

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
      log(`deploying to ${viaOwn ? "ARC_MAINNET_RPC" : found.url} (chainId ${found.chainId}) devBuy=${devBuy}…`);
      const run = runDeploy(env, sendRpc, devBuy);
      if (run.platform && run.noah) {
        // kept before the chain is asked: if these transactions land late, the next tick adopts
        // them above instead of deploying again
        state.attempts = [...(state.attempts ?? []), {
          platform: run.platform, noah: run.noah, devTokens: run.devTokens ?? null,
          devBuy: devBuy.toString(), via: viaOwn ? "own" : "public", at: new Date().toISOString(),
        }].slice(-5);
        saveState(state);
      }
      // The chain decides, not forge's output: forge prints the addresses from its local
      // simulation, before a single transaction is sent, so a broadcast that failed still names
      // a platform. Both contracts must have code where it said.
      const seen = run.platform && run.noah ? await landed([sendRpc, found.url], run, 10) : false;
      if (seen !== true) {
        log(`DEPLOY FAILED (${seen === null ? "no RPC could confirm it" : "not on chain"}, forge exit ${run.status}):\n${run.out}`);
        if (viaOwn) {
          state.ownRpcFailed = true; // the next attempts go through the public RPC
          saveState(state);
        }
        if (!state.deployFailNotified) {
          state.deployFailNotified = true;
          saveState(state);
          // the constructor's own refusals name themselves ("dex: ..."): pass the reason along
          const reason = (run.out.match(/dex: [a-z0-9% ]+/i) || [])[0];
          const why = reason ? ` Reason: "${reason}".` : "";
          await notify(env, `❌ Mainnet deploy attempt did not land on chain. Check monitor/scan.log.${why}` +
            (viaOwn ? " It went through ARC_MAINNET_RPC; the next attempts use the public RPC." : "") +
            " Will keep retrying every minute.");
        }
        return;
      }
      dep = { ...run, via: viaOwn ? "own" : "public" };
    }

    // The deploy is irreversible and real funds have already moved. Persist that
    // fact BEFORE touching config.js or git: if either fails, the next tick must
    // see phase "deployed" and stop, never deploy a second platform.
    state.phase = "deployed";
    state.platform = dep.platform;
    state.noah = dep.noah;
    state.deployedAt = new Date().toISOString();
    delete state.attempts; // settled: nothing left to adopt
    saveState(state);

    const wrote = updateFrontendConfig(found.url, found.chainId, dep.platform, dep.noah);
    // The push IS the deploy: the Vercel project builds from this repo (verified 10 Sep
    // 2026; snapshots have shipped that way since). The CLI stays only as the fallback for a
    // push that fails, because under the scheduled task it cannot find its own install.
    const published = wrote && publishConfig();
    const shipped = !wrote ? { ok: false, err: "config.js was not rewritten" }
      : published ? { ok: true, err: "" }
      : deployToVercel();
    if (wrote && !shipped.ok) log(`MAINNET CONFIG NOT SHIPPED: ${shipped.err}`);
    state.configShipped = shipped.ok;
    const devLine = devBuy > 0n
      ? `Dev buy: ${(Number(devBuy) / 1e18).toFixed(2)} USDC` +
        (dep.devTokens ? ` → ${(Number(BigInt(dep.devTokens)) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} $NOAH` : "") + "\n"
      : "";
    await notify(env,
      `🎉 ANEWONE.XYZ IS LIVE ON ARC MAINNET!\nPlatform: ${dep.platform}\n$NOAH: ${dep.noah}\n` + devLine +
      `RPC: ${found.url} (chainId ${found.chainId})\n` +
      (dep.via === "own" ? "The launch transactions went through your ARC_MAINNET_RPC.\n" : "") +
      (!wrote
        ? "⚠️ docs/config.js could NOT be rewritten — anewone.xyz is STILL ON TESTNET. Set the mainnet block by hand, then push."
        : !shipped.ok
        ? `🚨 config.js is correct but neither the git push nor the Vercel CLI shipped it — anewone.xyz is STILL ON TESTNET.\n` +
          `Fix by hand: cd "${ROOT}" && git push origin main\n${shipped.err}`
        : published
        ? "config.js is pushed and Vercel deploys it from the push: anewone.xyz serves the mainnet config within a minute or two."
        : "The git push failed but the Vercel CLI deployed config.js: anewone.xyz is on mainnet, only the public repo record is behind."));
    log(`DEPLOYED platform=${dep.platform} noah=${dep.noah}`);
  } finally {
    clearInterval(lockTimer);
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exit(1); });
