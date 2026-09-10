/**
 * Graduations into Uniswap v3, carried out by the scanner once an owner has opened migrations.
 *
 * migrate(token) is permissionless and nothing in the contract calls it on its own: a coin that
 * graduated keeps trading on its curve until somebody moves it. This makes sure somebody always
 * does. On each tick of the deployed phase it looks for curves that graduated, asks the node
 * whether their migration would go through (eth_call runs Arc's real USDC precompile, which no
 * local fork can), and only then sends it, with the deployer paying the gas.
 *
 * It also opens migrations, once: as soon as Uniswap v3 on Arc checks out (see checkUniswap).
 * If an owner closes them again later, that is a person's decision and it stays closed.
 *
 * It never runs before the mainnet deploy, and scan.mjs loads it on demand inside a try/catch:
 * nothing in here can reach the launch path.
 *
 * CLI, read-only, never sends a tx:
 *   node monitor/migrate.mjs --rpc <url> --platform <address> [--from <address>]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CAST = "C:/Users/Monster/.foundry/bin/cast.exe";

// selectors, from `cast sig`
const SEL = {
  tokensCount: "0xa64ed8ba",
  allTokens: "0x634282af",
  info: "0x0aae7a6b",
  gradTarget: "0x9a3a8ee1",
  migrationsOpen: "0xa7cd3a7f",
  migrated: "0x4ba0a5ee",
  v3Factory: "0x7c887c59",
  usdc: "0x3e413bee",
  getPool: "0x1698ee82",
  symbol: "0x95d89b41",
  positionManager: "0x791b98bc",
  factory: "0xc45a0155",
  feeAmountTickSpacing: "0x22afcccb",
  WETH9: "0x4aa4a4fc",
};
// curves checked for graduation per tick; the rest take their turn a minute later
const SCAN_PER_TICK = 40;
// token addresses read per tick while catching up with a long list
const DISCOVER_PER_TICK = 100;
// migrations sent per tick: a graduation is rare, and a tick should stay short
const SENDS_PER_TICK = 2;
// a migration costs about 5.3M gas; below this the deployer might not cover one
const MIN_GAS_WEI = 300_000_000_000_000_000n; // 0.3 USDC
// a problem that persists is repeated at most this often
const REMIND_MS = 6 * 60 * 60 * 1000;
// The factory's runtime code, with the one immutable that holds its own address masked out,
// must hash to the build Uniswap published to npm (v3-core 1.0.1, test/fixtures/uniswap-v3).
const CANONICAL_FACTORY_CODE_HASH = "0xc66c27d7d60725224552811cfb0e8148a15e914e0e31720daed102e61a0118af";
// opening migrations is one small owner transaction; below this the deployer waits for a top-up
const MIN_OPEN_GAS_WEI = 50_000_000_000_000_000n; // 0.05 USDC

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
const word = (hex, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1));
const asAddr = (w) => "0x" + w.slice(24);
const call = (rpc, to, data) => rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
const readUint = async (rpc, to, data) => BigInt(await call(rpc, to, data));
const readBool = async (rpc, to, data) => (await readUint(rpc, to, data)) !== 0n;
const usdc = (wei) => (Number(wei) / 1e18).toFixed(2);

/** graduated and raised out of info(); the tuple's string tail is never needed */
async function readInfo(rpc, platform, token) {
  const r = await call(rpc, platform, SEL.info + pad(token));
  return { graduated: BigInt("0x" + word(r, 2)) !== 0n, raised: BigInt("0x" + word(r, 5)) };
}

/** Anyone can launch a coin with any symbol, and it ends up in a Telegram message: letters
 *  and digits only, and short. */
async function readSymbol(rpc, token) {
  try {
    const r = await call(rpc, token, SEL.symbol);
    const off = Number(BigInt("0x" + word(r, 0))) * 2;
    const len = Number(BigInt("0x" + r.slice(2 + off, 2 + off + 64)));
    const raw = Buffer.from(r.slice(2 + off + 64, 2 + off + 64 + len * 2), "hex").toString("utf8");
    return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "?";
  } catch {
    return "?";
  }
}

async function poolOf(rpc, platform, token, st) {
  if (!st.dex) {
    st.dex = {
      factory: asAddr(word(await call(rpc, platform, SEL.v3Factory), 0)),
      usdc: asAddr(word(await call(rpc, platform, SEL.usdc), 0)),
    };
  }
  const r = await call(rpc, st.dex.factory, SEL.getPool + pad(token) + pad(st.dex.usdc) + pad(10_000));
  return asAddr(word(r, 0));
}

/** The migration, run by the node without being sent. Nothing is signed. */
function dryRun(rpc, platform, token, from) {
  const res = spawnSync(CAST, ["call", platform, "migrate(address)", token, "--from", from, "--rpc-url", rpc],
    { encoding: "utf8", timeout: 60_000 });
  if (res.status === 0) return { ok: true };
  const out = ((res.stderr || "") + (res.stdout || "")).trim();
  const m = out.match(/execution reverted:?\s*([^,\n"]*)/i);
  return { ok: false, reason: (m && m[1].trim()) || out.split("\n").pop().slice(0, 160) || "unknown" };
}

/** A transaction from the deployer. The key only ever goes to cast, never to a log. */
function sendTx(env, rpc, to, sig, args) {
  const res = spawnSync(CAST, ["send", to, sig, ...args, "--rpc-url", rpc,
    "--private-key", env.PRIVATE_KEY, "--timeout", "120", "--json"], { encoding: "utf8", timeout: 150_000 });
  const m = (res.stdout || "").match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, out: ((res.stderr || "") + (res.stdout || "")).trim().slice(-300) };
  try {
    const r = JSON.parse(m[0]);
    const ok = r.status === "0x1" || r.status === 1 || r.status === "1";
    return { ok, tx: r.transactionHash, gas: r.gasUsed ? Number(BigInt(r.gasUsed)) : null, out: ok ? "" : "reverted on chain" };
  } catch (e) {
    return { ok: false, out: String(e).slice(0, 200) };
  }
}

function keccak(hex) {
  const r = spawnSync(CAST, ["keccak"], { input: hex, encoding: "utf8", timeout: 30_000 });
  return (r.stdout || "").trim().toLowerCase();
}

/** Is Uniswap v3 live at the platform's fixed addresses, and is it the Uniswap v3 expected?
 *  setMigrationsOpen repeats the contract's own checks; this adds the bytecode comparison and
 *  the WETH9 question on top. */
async function checkUniswap(rpc, platform) {
  const factory = asAddr(word(await call(rpc, platform, SEL.v3Factory), 0));
  const pm = asAddr(word(await call(rpc, platform, SEL.positionManager), 0));
  const usdcFace = asAddr(word(await call(rpc, platform, SEL.usdc), 0));
  const code = String(await rpcCall(rpc, "eth_getCode", [factory, "latest"])).toLowerCase();
  const pmCode = String(await rpcCall(rpc, "eth_getCode", [pm, "latest"]));
  if (code === "0x" || pmCode === "0x") {
    return { ok: false, reason: "Uniswap v3 is not live at the platform's addresses yet" };
  }
  if (BigInt(await call(rpc, factory, SEL.feeAmountTickSpacing + pad(10_000))) !== 200n) {
    return { ok: false, reason: "the factory has no 1% fee tier with tick spacing 200" };
  }
  if (asAddr(word(await call(rpc, pm, SEL.factory), 0)) !== factory) {
    return { ok: false, reason: "the position manager does not belong to that factory" };
  }
  if (keccak(code.split(factory.slice(2)).join("0".repeat(40))) !== CANONICAL_FACTORY_CODE_HASH) {
    return { ok: false, reason: "the factory's code is not the Uniswap v3 build published to npm" };
  }
  if (asAddr(word(await call(rpc, pm, SEL.WETH9), 0)) === usdcFace) {
    return { ok: false, reason: "the position manager's WETH9 is the USDC face itself, which wants a person's look first" };
  }
  return { ok: true, factory, pm };
}

/** Opens migrations from the deployer, an owner, once Uniswap v3 checks out. */
async function autoOpen(ctx, flag, save, st) {
  const { env, rpc, platform, log, notify } = ctx;
  let check;
  try {
    check = await checkUniswap(rpc, platform);
  } catch (e) {
    check = { ok: false, reason: "a check could not be read: " + String((e && e.message) || e).slice(0, 120) };
  }
  if (!check.ok) {
    log(`migrate: not opening migrations: ${check.reason}`);
    await flag("autoopen:" + check.reason,
      `⏸ Migrations stay closed: ${check.reason}. They open by themselves once this checks out, or from the owner console.`);
    return false;
  }
  const gas = BigInt(await rpcCall(rpc, "eth_getBalance", [env.DEPLOYER_ADDRESS, "latest"]));
  if (gas < MIN_OPEN_GAS_WEI) {
    await flag("autoopen:gas",
      `⛽ Uniswap v3 checks out on Arc, but the deployer has only ${usdc(gas)} USDC for the gas to open migrations. ` +
      `Top it up, or open them from the owner console.`);
    return false;
  }
  const r = sendTx(env, rpc, platform, "setMigrationsOpen(bool)", ["true"]);
  if (!r.ok) {
    log(`migrate: opening migrations failed: ${r.out}`);
    await flag("autoopen:send", `❌ Opening migrations failed: ${r.out}. The scanner retries every minute; the owner console can open them too.`);
    return false;
  }
  st.flags.openNotified = Date.now(); // this message is the announcement
  save();
  log(`migrate: opened migrations, tx ${r.tx}`);
  await notify(`🔓 Uniswap v3 is live on Arc and checks out (its factory is byte for byte the build Uniswap published), ` +
    `so the scanner opened migrations. Tx ${r.tx}. Coins that graduate now move into their pools by themselves.`);
  return true;
}

/**
 * One tick. Mutates ctx.state.migrate and persists it through ctx.saveState.
 * ctx: { env, state, saveState, log, notify(text), rpc, platform }
 */
export async function migrateStep(ctx) {
  const { env, state, saveState, log, notify, rpc, platform } = ctx;
  if (!rpc || !platform || !env.DEPLOYER_ADDRESS || !env.PRIVATE_KEY) return;
  const st = (state.migrate ??= { addrs: [], cursor: 0, pending: [], done: {}, flags: {} });
  const save = () => { state.migrate = st; saveState(state); };
  // a problem is told once, then at most every REMIND_MS while it lasts
  const flag = async (key, text) => {
    if (Date.now() - (st.flags[key] || 0) < REMIND_MS) return;
    st.flags[key] = Date.now();
    save();
    await notify(text);
  };

  if (!(await readBool(rpc, platform, SEL.migrationsOpen))) {
    // Closed again after having been open: an owner decided that, and the scanner does not
    // overrule a person. Opening them again is for the owner console.
    if (st.flags.everOpen) {
      if (!st.flags.heldNotified) {
        st.flags.heldNotified = Date.now();
        save();
        await notify(`⏸ An owner closed migrations on ${platform}. The scanner will not open them again by itself; ` +
          `reopen them from the owner console when ready.`);
      }
      return;
    }
    // never opened yet: open them as soon as Uniswap v3 on Arc checks out
    if (!(await autoOpen(ctx, flag, save, st))) return;
  }
  st.flags.everOpen = 1;
  st.flags.heldNotified = 0;
  if (!st.flags.openNotified) {
    st.flags.openNotified = Date.now();
    save();
    await notify(`🔓 Migrations are open on ${platform}. The scanner now moves every coin that graduates into its Uniswap v3 pool.`);
  }

  // allTokens is append-only, so each address is read once and kept
  const count = Number(await readUint(rpc, platform, SEL.tokensCount));
  const upto = Math.min(count, st.addrs.length + DISCOVER_PER_TICK);
  for (let i = st.addrs.length; i < upto; i++) {
    st.addrs.push(asAddr(word(await call(rpc, platform, SEL.allTokens + pad(i)), 0)));
  }

  // round robin over the curves, so a long list is covered in a few ticks, not every tick
  const n = st.addrs.length;
  for (let k = 0; k < Math.min(SCAN_PER_TICK, n); k++) {
    const token = st.addrs[st.cursor % n];
    st.cursor = (st.cursor + 1) % n;
    if (st.done[token] || st.pending.includes(token)) continue;
    if ((await readInfo(rpc, platform, token)).graduated) st.pending.push(token);
  }
  save();
  if (!st.pending.length) return;

  const grad = await readUint(rpc, platform, SEL.gradTarget);
  let sends = 0;
  for (const token of [...st.pending]) {
    if (sends >= SENDS_PER_TICK) break;
    const drop = () => { st.pending = st.pending.filter((a) => a !== token); };

    if (await readBool(rpc, platform, SEL.migrated + pad(token))) {
      st.done[token] = st.done[token] || "moved by somebody else";
      drop();
      save();
      log(`migrate: ${token} is already on Uniswap`);
      continue;
    }
    // sells can take a graduated curve back under the target; it waits for buys, quietly
    if ((await readInfo(rpc, platform, token)).raised < grad) continue;

    const sym = await readSymbol(rpc, token);
    const dry = dryRun(rpc, platform, token, env.DEPLOYER_ADDRESS);
    if (!dry.ok) {
      log(`migrate: dry run for ${token} reverts: ${dry.reason}`);
      await flag(`dry:${token}:${dry.reason}`,
        `⚠️ $${sym} graduated, but moving it into Uniswap would revert right now: "${dry.reason}". ` +
        `Nothing was sent; the scanner retries every minute.`);
      continue;
    }
    const gas = BigInt(await rpcCall(rpc, "eth_getBalance", [env.DEPLOYER_ADDRESS, "latest"]));
    if (gas < MIN_GAS_WEI) {
      await flag("gas",
        `⛽ $${sym} is ready to move into Uniswap, but the deployer ${env.DEPLOYER_ADDRESS} has only ` +
        `${usdc(gas)} USDC on Arc for gas. Top it up and the scanner carries on by itself.`);
      return;
    }

    sends++;
    const r = sendTx(env, rpc, platform, "migrate(address)", [token]);
    if (!r.ok) {
      log(`migrate: send for ${token} failed: ${r.out}`);
      await flag(`send:${token}`, `❌ Sending the migration of $${sym} failed: ${r.out}. The scanner retries every minute.`);
      continue;
    }
    st.done[token] = r.tx;
    drop();
    save();
    const pool = await poolOf(rpc, platform, token, st).catch(() => null);
    save();
    log(`migrate: ${token} moved, tx ${r.tx}, gas ${r.gas}`);
    await notify(`🦄 $${sym} moved into Uniswap v3.\nToken: ${token}\nPool: ${pool || "?"}\nTx: ${r.tx} (gas ${r.gas ?? "?"})`);
  }
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const rpc = arg("--rpc");
  const platform = arg("--platform");
  const from = arg("--from");
  if (!rpc || !platform) {
    console.log("usage: node monitor/migrate.mjs --rpc <url> --platform <address> [--from <address>]");
    process.exit(1);
  }
  console.log("== ANEWONE migration check (read-only, never sends a tx) ==");
  const open = await readBool(rpc, platform, SEL.migrationsOpen);
  const count = Number(await readUint(rpc, platform, SEL.tokensCount));
  const grad = await readUint(rpc, platform, SEL.gradTarget);
  console.log(`platform ${platform}: migrations ${open ? "OPEN" : "closed"}, ${count} tokens, graduation at ${usdc(grad)} USDC`);
  const uni = await checkUniswap(rpc, platform).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
  console.log(`Uniswap v3: ${uni.ok ? "checks out, migrations may open" : "not ready: " + uni.reason}`);
  for (let i = 0; i < count; i++) {
    const token = asAddr(word(await call(rpc, platform, SEL.allTokens + pad(i)), 0));
    const inf = await readInfo(rpc, platform, token);
    const moved = await readBool(rpc, platform, SEL.migrated + pad(token));
    let line = `  ${token} $${await readSymbol(rpc, token)}: `;
    if (moved) line += "already on Uniswap";
    else if (!inf.graduated) line += `on the curve, ${usdc(inf.raised)} USDC raised`;
    else if (inf.raised < grad) line += "graduated, but back under the target: waits for buys";
    else if (!from) line += "graduated and ready (add --from <address> to dry-run it)";
    else {
      const d = dryRun(rpc, platform, token, from);
      line += d.ok ? "graduated: dry run OK, the scanner would move it" : `graduated: dry run reverts "${d.reason}"`;
    }
    console.log(line);
  }
}
