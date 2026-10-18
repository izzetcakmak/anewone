// Aave V4 on Arc, straight from this page: supply and withdraw on Earn, a cross-collateral loan
// on Borrow. Both sit on Aave's Main spoke (hub-and-spoke: the Core hub holds the liquidity, the
// spoke keeps the positions). Every action is ONE transaction through Arc's sender-preserving
// batcher (Multicall3From, the one Circle's kit uses for Morpho): each call inside runs with the
// user's own address as msg.sender, so approve + supply + borrow + the interface fee land
// together or not at all. Each batch is simulated (eth_estimateGas) before the wallet is asked.
//
// Addresses: bgd-labs/aave-address-book src/AaveV4Arc.sol, code checked on-chain 18 Oct 2026.
const BATCHER = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
const SPOKE = "0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d"; // Main spoke
const HUB = "0x17288dfc86205301064577b98B02b81017e6F79C"; // Core hub
const USDC = "0x3600000000000000000000000000000000000000";
// only reserves we know are shown; anything else the spoke lists later stays out until reviewed
const TOKENS = {
  [USDC]: { symbol: "USDC", stable: true, dp: 2 },
  "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1": { symbol: "EURC", stable: true, dp: 2 },
  "0x171a4217b86a807a64eb94757db6849fb4bdbaa0": { symbol: "cirBTC", stable: false, dp: 6 },
  "0x128cc466b61f542da60c70e3aa11c10e19b84edb": { symbol: "WETH", stable: false, dp: 5 },
};
// stablecoins under their own filter chip; cirBTC and WETH (near-zero supply rates, few borrowers) under "All"
const EARN_ASSETS = ["USDC", "EURC", "cirBTC", "WETH"];
const LOAN_ASSETS = ["USDC", "EURC"];
const MIN_HF = 1.15;    // a borrow or withdrawal that leaves less is refused here
const MAX_HF = 1.25;    // what MAX sizes to
const WARN_HF = 1.5;
const MAX_UINT = (1n << 256n) - 1n;

const SPOKE_ABI = [
  "function getReserveCount() view returns (uint256)",
  "function getReserve(uint256) view returns (address underlying, address hub, uint256 assetId, uint256 decimals, uint256 collateralRisk, uint256 flags, uint256 dynamicConfigKey)",
  "function getReserveConfig(uint256) view returns (uint256 collateralRisk, bool paused, bool frozen, bool borrowable, bool receiveSharesEnabled)",
  "function getDynamicReserveConfig(uint256, uint32) view returns (uint256 collateralFactor, uint256 maxLiquidationBonus, uint256 liquidationFee)",
  "function getUserSuppliedAssets(uint256, address) view returns (uint256)",
  "function getUserTotalDebt(uint256, address) view returns (uint256)",
  "function getUserReserveStatus(uint256, address) view returns (bool collateral, bool borrowed)",
  "function getUserPosition(uint256, address) view returns (uint256 drawnShares, uint256 premiumShares, int256 premiumOffsetRay, uint256 suppliedShares, uint256 dynamicConfigKey)",
  "function ORACLE() view returns (address)",
  "function supply(uint256 reserveId, uint256 amount, address onBehalfOf)",
  "function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf)",
  "function borrow(uint256 reserveId, uint256 amount, address onBehalfOf)",
  "function repay(uint256 reserveId, uint256 amount, address onBehalfOf)",
  "function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)",
];
const HUB_ABI = [
  "function getAddedAssets(uint256) view returns (uint256)",
  "function getAssetTotalOwed(uint256) view returns (uint256)",
  "function getAssetLiquidity(uint256) view returns (uint256)",
  "function getAssetDrawnRate(uint256) view returns (uint256)",
  "function getAssetConfig(uint256) view returns (address feeReceiver, uint256 liquidityFee, address irStrategy, address reinvestmentController)",
];
const ORACLE_ABI = ["function getReservesPrices(uint256[]) view returns (uint256[])"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address, uint256)", "function transfer(address, uint256)"];
const BATCH_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])"];

export function initAave(ctx) {
  const { ethers, fmt, money, pct, esc } = ctx;
  const B = (id) => document.getElementById(id);
  const iSpoke = new ethers.Interface(SPOKE_ABI), iErc = new ethers.Interface(ERC20_ABI), iBatch = new ethers.Interface(BATCH_ABI);
  const call = (to, iface, fn, args) => ({ to, data: iface.encodeFunctionData(fn, args) });

  // The interface fee: a plain USDC/EURC transfer to our wallet inside the same batch. Off unless
  // config.js names a wallet; capped at 1% so a typo cannot charge a user 15%.
  const fc = ctx.cfg || {};
  const feeTo = /^0x[0-9a-fA-F]{40}$/.test(fc.feeTo || "") ? fc.feeTo : null;
  const bps = (x) => Math.max(0, Math.min(100, Math.floor(Number(x) || 0)));
  const BORROW_FEE = feeTo ? bps(fc.borrowFeeBps) : 0, SUPPLY_FEE = feeTo ? bps(fc.supplyFeeBps) : 0;

  let reserves = [], user = {}, gasBal = 0, loaded = false, loadErr = null;
  const bySym = (s) => reserves.find((r) => r.symbol === s);
  const byId = (id) => reserves.find((r) => r.id === id);
  const num = (raw, dec) => Number(ethers.formatUnits(raw, dec));
  const show = (r, x) => `${fmt(x, r.dp)} ${r.symbol}`;

  async function withRead(fn) {
    let last = null;
    for (const p of ctx.readProviders()) { try { return await fn(p); } catch (e) { last = e; } }
    throw last || new Error("no RPC answered");
  }

  // ---- market: rates, liquidity, prices, collateral factors -------------------------------
  async function loadMarket() {
    try {
      reserves = await withRead(async (p) => {
        const sp = new ethers.Contract(SPOKE, SPOKE_ABI, p), hub = new ethers.Contract(HUB, HUB_ABI, p);
        const n = Number(await sp.getReserveCount());
        const rows = (await Promise.all([...Array(n).keys()].map(async (id) => {
          const [r, rc] = await Promise.all([sp.getReserve(id), sp.getReserveConfig(id)]);
          const t = TOKENS[r.underlying.toLowerCase()];
          if (!t || r.hub.toLowerCase() !== HUB.toLowerCase()) return null;
          const a = r.assetId, dec = Number(r.decimals);
          const [dyn, added, owed, liq, rate, ac] = await Promise.all([sp.getDynamicReserveConfig(id, r.dynamicConfigKey),
            hub.getAddedAssets(a), hub.getAssetTotalOwed(a), hub.getAssetLiquidity(a), hub.getAssetDrawnRate(a), hub.getAssetConfig(a)]);
          const addedN = num(added, dec), owedN = num(owed, dec), drawn = Number(rate) / 1e27;
          const util = addedN > 0 ? owedN / addedN : 0;
          return { id, address: r.underlying, ...t, decimals: dec, cf: Number(dyn.collateralFactor), risk: Number(rc.collateralRisk),
            paused: rc.paused, frozen: rc.frozen, borrowable: rc.borrowable, added: addedN, owed: owedN, liquidity: num(liq, dec), util,
            drawn, borrowApy: Math.expm1(drawn), supplyApy: Math.expm1(drawn * util * (1 - Number(ac.liquidityFee) / 1e4)) };
        }))).filter(Boolean);
        const oracle = new ethers.Contract(await sp.ORACLE(), ORACLE_ABI, p);
        const px = await oracle.getReservesPrices(rows.map((r) => r.id));
        rows.forEach((r, i) => { r.price = Number(px[i]) / 1e8; });
        return rows;
      });
      loaded = true; loadErr = null;
    } catch (e) { loadErr = e; console.warn("aave market", e); }
  }

  // ---- the user's position on the spoke, and the wallet balances it needs ------------------
  async function loadUser() {
    const U = ctx.account();
    if (!U || !reserves.length) { user = {}; return; }
    try {
      await withRead(async (p) => {
        const sp = new ethers.Contract(SPOKE, SPOKE_ABI, p);
        const out = {};
        await Promise.all(reserves.map(async (r) => {
          const [sup, debt, st, pos, wal] = await Promise.all([sp.getUserSuppliedAssets(r.id, U), sp.getUserTotalDebt(r.id, U),
            sp.getUserReserveStatus(r.id, U), sp.getUserPosition(r.id, U), new ethers.Contract(r.address, ERC20_ABI, p).balanceOf(U)]);
          // a collateral keeps the factor it was enabled under (its own config key), not today's
          const cf = st.collateral ? Number((await sp.getDynamicReserveConfig(r.id, pos.dynamicConfigKey)).collateralFactor) : r.cf;
          out[r.id] = { supRaw: sup, debtRaw: debt, supplied: num(sup, r.decimals), debt: num(debt, r.decimals), collateral: st.collateral, cf, wallet: num(wal, r.decimals) };
        }));
        gasBal = Number(ethers.formatEther(await p.getBalance(U)));
        user = out;
      });
    } catch (e) { console.warn("aave user", e); }
  }
  const u = (id) => user[id] || { supRaw: 0n, debtRaw: 0n, supplied: 0, debt: 0, collateral: false, cf: 0, wallet: 0 };

  // Health factor the way the spoke counts it: collateral value x collateral factor over debt
  // value, at the oracle's prices. `adj` is a what-if: supply/debt deltas and collateral turned on.
  function health(adj = {}) {
    let S = 0, D = 0, vol = [];
    for (const r of reserves) {
      const p = u(r.id), sup = p.supplied + ((adj.supply || {})[r.id] || 0), on = p.collateral || (adj.enable || []).includes(r.id);
      const cf = p.collateral ? p.cf : r.cf;
      if (on && sup > 0) { S += sup * r.price * cf / 1e4; if (!r.stable) vol.push({ r, sup, cf }); }
      D += Math.max(0, p.debt + ((adj.debt || {})[r.id] || 0)) * r.price;
    }
    const hf = D > 1e-9 ? S / D : Infinity;
    // one volatile collateral against stable debt has a single liquidation price: where HF = 1
    let liq = null;
    if (vol.length === 1 && D > 1e-9) { const v = vol[0], rest = S - v.sup * v.r.price * v.cf / 1e4; liq = (D - rest) / (v.sup * v.cf / 1e4); if (!(liq > 0)) liq = null; }
    return { S, D, hf, liq, liqSym: vol.length === 1 ? vol[0].r.symbol : null };
  }
  const hfText = (h) => (h === Infinity ? "∞" : fmt(h, 2));
  const hasLoan = () => reserves.some((r) => u(r.id).debt > 0 || (u(r.id).collateral && u(r.id).supplied > 0));
  // the borrow rate a loan pays: the hub's drawn rate plus Aave V4's risk premium, which is the
  // collateral's risk weight (0 on every Arc reserve today)
  const borrowApy = (debtR, colR) => Math.expm1(debtR.drawn * (1 + ((colR && colR.risk) || 0) / 1e4));

  // ---- cards ------------------------------------------------------------------------------
  function earnCard(r) {
    const p = u(r.id);
    return `<div class="vault">
      <div class="head"><div><h3>Aave V4 · ${esc(r.symbol)}</h3><div class="curator">Main market · Aave on Arc</div></div>
        <span class="tag ${r.symbol === "USDC" ? "usdc" : ""}">${esc(r.symbol)}</span></div>
      <div class="apy">${pct(r.supplyApy)}<small>SUPPLY APY</small></div>
      <div class="stats"><div>${money(r.added * r.price)}<span>Supplied</span></div><div>${money(r.liquidity * r.price)}<span>Liquidity</span></div><div>${fmt(r.util * 100, 1)}%<span>Utilisation</span></div></div>
      ${r.stable ? "" : `<div class="curator">Few borrow ${esc(r.symbol)}, so supplying it earns close to nothing. Its use is as collateral: borrow USDC against it on the Borrow tab.</div>`}
      ${r.paused || r.frozen ? `<span class="tag warn">⚠ ${r.paused ? "paused" : "frozen"} by Aave governance</span>` : ""}
      <div class="pos ${ctx.account() && p.supplied > 0 ? "show" : ""}">You: ${esc(show(r, p.supplied))}${p.collateral ? " · used as collateral" : ""}</div>
      <button class="btn primary" data-aave-earn="${r.id}">Deposit ${esc(r.symbol)}</button>
    </div>`;
  }
  function renderEarn() {
    const g = B("aaveEarn"); if (!g) return;
    const f = ctx.filter();
    const list = EARN_ASSETS.map(bySym).filter((r) => r && (f === "all" || r.symbol === f));
    B("aaveEarnWrap").hidden = !loaded || !list.length;
    g.innerHTML = list.map(earnCard).join("");
    if (ctx.onChange) ctx.onChange();
  }
  function renderBorrow() {
    const g = B("aaveMarkets"); if (!g) return;
    B("aaveBorrowWrap").hidden = !loaded;
    if (!loaded) return;
    const cols = reserves.filter((r) => !r.stable && r.cf > 0), debts = LOAN_ASSETS.map(bySym).filter((r) => r && r.borrowable);
    const U = ctx.account();
    let pos = "";
    if (U && hasLoan()) {
      const h = health();
      const band = h.hf === Infinity || h.hf >= WARN_HF ? "SAFE" : h.hf >= MIN_HF ? "WARN" : "URGENT";
      const colTxt = reserves.filter((r) => u(r.id).collateral && u(r.id).supplied > 0).map((r) => show(r, u(r.id).supplied)).join(" + ") || "none";
      const debtTxt = reserves.filter((r) => u(r.id).debt > 0).map((r) => show(r, u(r.id).debt)).join(" + ") || "none";
      pos = `<div class="vault">
        <div class="head"><div><div class="pair">Your Aave position</div><div class="curator">Main market · one account, all collateral counts together</div></div>
          <span class="hf ${band}">${band === "SAFE" ? "healthy" : band === "WARN" ? "watch" : "at risk"}</span></div>
        <div class="apy">${hfText(h.hf)}<small>HEALTH FACTOR</small></div>
        <div class="stats"><div>${esc(debtTxt)}<span>Debt</span></div><div>${esc(colTxt)}<span>Collateral</span></div><div>${h.liq ? money(h.liq) : "—"}<span>Liq. price${h.liqSym ? " " + esc(h.liqSym) : ""}</span></div></div>
        <div class="loanacts">
          <button class="btn" data-aave-loan="repay">Repay</button>
          <button class="btn" data-aave-loan="borrow">Borrow more</button>
          <button class="btn" data-aave-loan="add">Add collateral</button>
          <button class="btn" data-aave-loan="wcol">Withdraw</button>
        </div>
      </div>`;
    }
    g.innerHTML = pos + cols.flatMap((c) => debts.map((d) => `<div class="vault">
      <div class="head"><div><div class="pair">${esc(c.symbol)} <span class="arrow">→</span> ${esc(d.symbol)}</div>
        <div class="curator">collateral ${esc(c.symbol)}, borrow ${esc(d.symbol)} · Aave V4 Main</div></div>
        <span class="tag ${d.symbol === "USDC" ? "usdc" : ""}">${esc(d.symbol)}</span></div>
      <div class="apy">${pct(borrowApy(d, c))}<small>BORROW APY</small></div>
      <div class="stats"><div>${money(d.liquidity * d.price)}<span>Available to borrow</span></div><div>${money(d.owed * d.price)}<span>Borrowed</span></div><div>${fmt(c.cf / 100, 0)}%<span>Max LTV</span></div></div>
      ${U && u(c.id).wallet > 0 ? `<div class="pos show">In your wallet: ${esc(show(c, u(c.id).wallet))}</div>` : ""}
      <button class="btn primary" data-aave-col="${c.id}" data-aave-debt="${d.id}">Borrow ${esc(d.symbol)}</button>
    </div>`)).join("");
  }

  // ---- the sheet ----------------------------------------------------------------------------
  // modes: deposit / withdraw (Earn, one asset); borrow / repay / add / wcol (the loan)
  let sh = { mode: "deposit", a1: 0, a2: 0 }, qTimer = null, blocked = false;
  const TABS = { earn: [["deposit", "Deposit"], ["withdraw", "Withdraw"]], loan: [["borrow", "Borrow"], ["repay", "Repay"], ["add", "Add collateral"], ["wcol", "Withdraw"]] };
  const isEarn = () => sh.mode === "deposit" || sh.mode === "withdraw";
  const status = (t, cls) => { const s = B("aaStatus"); s.textContent = t; s.className = "status " + (cls || ""); };
  function choices() {
    if (sh.mode === "borrow") return reserves.filter((r) => !r.stable && r.cf > 0);
    if (sh.mode === "repay") return reserves.filter((r) => u(r.id).debt > 0);
    if (sh.mode === "add") return reserves.filter((r) => r.cf > 0 && (!r.stable || u(r.id).collateral));
    if (sh.mode === "wcol") return reserves.filter((r) => u(r.id).collateral && u(r.id).supplied > 0);
    return [];
  }
  function chips(el, list, sel, key) {
    el.innerHTML = list.map((r) => `<button type="button" data-${key}="${r.id}" class="${r.id === sel ? "on" : ""}">${esc(r.symbol)}</button>`).join("");
  }
  function open(x) {
    if (!loaded) return;
    sh = { ...sh, ...x };
    const kind = isEarn() ? "earn" : "loan";
    B("aaTabs").className = "tabs" + (kind === "loan" ? " four" : "");
    B("aaTabs").innerHTML = TABS[kind].map(([m, t]) => `<button type="button" data-aam="${m}">${t}</button>`).join("");
    B("aaveOverlay").classList.add("open");
    setMode(sh.mode);
  }
  function setMode(m) {
    sh.mode = m;
    B("aaTabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.aam === m));
    if (!isEarn()) {
      const list = choices();
      if (!list.some((r) => r.id === sh.a1)) sh.a1 = list.length ? list[0].id : -1;
      if (m === "borrow" && !LOAN_ASSETS.includes((byId(sh.a2) || {}).symbol)) sh.a2 = bySym("USDC").id;
    }
    const r1 = byId(sh.a1), r2 = byId(sh.a2);
    B("aaName").textContent = isEarn() ? `Aave V4 · ${r1.symbol}` : m === "borrow" ? `Borrow ${r2.symbol} on Aave` : "Your Aave position";
    B("aaSub").textContent = isEarn() ? `${pct(r1.supplyApy)} supply APY · Main market · Aave on Arc` : m === "borrow" && r1 ? `${pct(borrowApy(r2, r1))} borrow APY · max LTV ${fmt(r1.cf / 100, 0)}% · Aave V4 Main` : "Aave V4 Main market";
    const label = { borrow: "Collateral", repay: "Repay", add: "Collateral", wcol: "Withdraw" }[m];
    B("aaPick1").hidden = isEarn(); B("aaPick1L").textContent = label || "";
    if (!isEarn()) chips(B("aaPick1C"), choices(), sh.a1, "aa1");
    const two = m === "borrow";
    B("aaPick2").hidden = !two; B("aaAmt2Row").hidden = !two; B("aaBal2").hidden = !two;
    if (two) chips(B("aaPick2C"), LOAN_ASSETS.map(bySym).filter(Boolean), sh.a2, "aa2");
    B("aaAmt1").value = ""; B("aaAmt2").value = "";
    B("aaAmt1").placeholder = two ? "0.00 (optional)" : "0.00";
    B("aaGo").textContent = { deposit: "Deposit", withdraw: "Withdraw", borrow: "Borrow", repay: "Repay", add: "Add collateral", wcol: "Withdraw collateral" }[m];
    B("aaQuote").hidden = true; status("");
    if (!isEarn() && !r1) { status(m === "repay" ? "No debt to repay." : "No collateral to withdraw.", ""); B("aaGo").disabled = true; } else B("aaGo").disabled = false;
    balances();
  }
  function balances() {
    const r1 = byId(sh.a1), r2 = byId(sh.a2), m = sh.mode;
    if (!ctx.account()) { B("aaBal1L").textContent = "Wallet: connect first"; B("aaBal1R").textContent = ""; return; }
    if (!r1) { B("aaUnit1").textContent = ""; B("aaBal1L").textContent = ""; B("aaBal1R").textContent = ""; return; }
    const p = u(r1.id);
    B("aaUnit1").textContent = r1.symbol;
    B("aaBal1L").textContent = m === "withdraw" || m === "wcol" ? `Supplied: ${show(r1, p.supplied)}` : `Wallet: ${show(r1, p.wallet)}`;
    B("aaBal1R").textContent = m === "repay" ? `Debt: ${show(r1, p.debt)}` : m === "borrow" ? `Collateral in: ${show(r1, p.collateral ? p.supplied : 0)}` : m === "deposit" ? `Supplied: ${show(r1, p.supplied)}` : "";
    if (m === "borrow" && r2) { B("aaUnit2").textContent = r2.symbol; B("aaBal2L").textContent = `Available: ${show(r2, r2.liquidity)}`; B("aaBal2R").textContent = u(r2.id).debt > 0 ? `Debt: ${show(r2, u(r2.id).debt)}` : ""; }
  }
  const floorTo = (x, d) => { const k = 10 ** d; return Math.max(0, Math.floor(x * k) / k); };
  const gasKeep = (r) => (r.address.toLowerCase() === USDC ? ctx.GAS_RESERVE : 0);
  function maxFor(which) {
    const r1 = byId(sh.a1), r2 = byId(sh.a2), m = sh.mode, p = u(r1.id), dp = Math.min(r1.decimals, 6);
    if (which === 2) {
      // the most this collateral (plus what is typed above) can carry at HF 1.25, within the hub's cash
      const add = Number(B("aaAmt1").value) || 0;
      const h = health({ supply: { [r1.id]: add }, enable: [r1.id] });
      return floorTo(Math.min(r2.liquidity, (h.S / MAX_HF - h.D) / r2.price), Math.min(r2.decimals, 6));
    }
    if (m === "deposit" || m === "add" || m === "borrow") return floorTo(p.wallet - gasKeep(r1), dp);
    if (m === "repay") return floorTo(Math.min(p.debt * 1.0005 + 10 ** -dp, p.wallet - gasKeep(r1)), dp);
    // a withdrawal: everything when no debt leans on it, otherwise down to HF 1.25
    const h = health();
    if (!p.collateral || h.D <= 1e-9) return Math.min(p.supplied, r1.liquidity);
    return floorTo(Math.min(p.supplied, r1.liquidity, (h.S - MAX_HF * h.D) / (r1.price * p.cf / 1e4)), dp);
  }
  // what the user typed, as base units; null for nothing or garbage
  function units(v, dec) {
    v = String(v || "").trim().replace(/,/g, "");
    if (!/^\d*\.?\d*$/.test(v) || !(Number(v) > 0)) return null;
    const [i, f = ""] = v.split(".");
    return ethers.parseUnits((i || "0") + (f ? "." + f.slice(0, dec) : ""), dec);
  }

  // the quote: what moves, the fee, and the health factor before and after
  function quote() {
    B("aaQuote").hidden = true; blocked = false; status("");
    const r1 = byId(sh.a1), r2 = byId(sh.a2), m = sh.mode;
    if (!r1) return null;
    const a1 = units(B("aaAmt1").value, r1.decimals), a2 = m === "borrow" ? units(B("aaAmt2").value, r2.decimals) : null;
    const x1 = a1 ? num(a1, r1.decimals) : 0, x2 = a2 ? num(a2, r2.decimals) : 0;
    if (m === "borrow" ? !x2 : !x1) return null;
    const p = u(r1.id), before = health();
    const rows = [], stop = (t) => { status(t, "err"); blocked = true; };
    let after = before, fee = 0n;
    if (m === "deposit") {
      fee = SUPPLY_FEE ? a1 * BigInt(SUPPLY_FEE) / 10000n : 0n;
      rows.push(["You supply", show(r1, x1)], ["Supply APY", pct(r1.supplyApy)]);
      if (x1 + num(fee, r1.decimals) > p.wallet - gasKeep(r1) + 1e-9) stop(`Not enough ${r1.symbol} in the wallet${gasKeep(r1) ? ` (${ctx.GAS_RESERVE} USDC stays back for gas)` : ""}.`);
    } else if (m === "withdraw" || m === "wcol") {
      if (x1 > p.supplied + 1e-9) stop(`You have ${show(r1, p.supplied)} supplied.`);
      else if (x1 > r1.liquidity) stop(`The hub has ${show(r1, r1.liquidity)} free right now; withdraw less, or wait for borrowers to repay.`);
      if (p.collateral) after = health({ supply: { [r1.id]: -x1 } });
      rows.push(["You receive", show(r1, x1)]);
    } else if (m === "add") {
      if (x1 > p.wallet - gasKeep(r1) + 1e-9) stop(`Not enough ${r1.symbol} in the wallet.`);
      after = health({ supply: { [r1.id]: x1 }, enable: [r1.id] });
      rows.push(["Collateral added", show(r1, x1)]);
    } else if (m === "repay") {
      const pay = Math.min(x1, p.debt);
      if (x1 > p.wallet - gasKeep(r1) + 1e-9) stop(`Not enough ${r1.symbol} in the wallet${gasKeep(r1) ? ` (${ctx.GAS_RESERVE} USDC stays back for gas)` : ""}.`);
      after = health({ debt: { [r1.id]: -pay } });
      rows.push(["Repay", show(r1, pay)]);
      if (x1 >= p.debt) rows.push(["Note", "Aave takes only what is owed at the moment the transaction lands; the rest stays in your wallet."]);
    } else if (m === "borrow") {
      if (x1 && x1 > p.wallet - gasKeep(r1) + 1e-9) stop(`Not enough ${r1.symbol} in the wallet.`);
      if (x2 > r2.liquidity) stop(`Only ${show(r2, r2.liquidity)} is free to borrow right now.`);
      fee = BORROW_FEE ? a2 * BigInt(BORROW_FEE) / 10000n : 0n;
      after = health({ supply: { [r1.id]: x1 }, enable: [r1.id], debt: { [r2.id]: x2 } });
      if (x1) rows.push(["Collateral added", show(r1, x1)]);
      rows.push(["Debt added", show(r2, x2)], ["To your wallet", show(r2, x2 - num(fee, r2.decimals))], ["Borrow APY", pct(borrowApy(r2, r1)) + " variable"]);
    }
    if (fee > 0n) { const fr = m === "borrow" ? r2 : r1; rows.push([`Interface fee · ${fmt((m === "borrow" ? BORROW_FEE : SUPPLY_FEE) / 100, 2)}%`, `${fmt(num(fee, fr.decimals), 4)} ${fr.symbol}`]); }
    if (before.D > 1e-9 || after.D > 1e-9) {
      rows.push(["Health factor", `${hfText(before.hf)} → ${hfText(after.hf)}`]);
      if (after.liq) rows.push([`Liquidation price ${after.liqSym}`, money(after.liq)]);
      if (!blocked && after.hf < MIN_HF && after.hf < before.hf) stop(`This would leave the health factor at ${hfText(after.hf)}. Below ${MIN_HF} is refused here: a small price move would liquidate it. Ask for less, or add collateral.`);
      else if (!blocked && after.hf < WARN_HF && after.hf < before.hf) status(`Careful: health factor ${hfText(after.hf)}. At 1.0 Aave liquidates part of the collateral, with a penalty.`, "err");
    }
    B("aaQuote").innerHTML = rows.map(([a, b]) => `<span>${esc(a)}</span><b>${esc(b)}</b>`).join("");
    B("aaQuote").hidden = false;
    return { r1, r2, a1, a2, x1, x2, fee };
  }

  // the batch for the current sheet
  function build(q) {
    const U = ctx.account(), m = sh.mode, { r1, r2, a1, a2, fee } = q, p = u(r1.id), calls = [];
    const approve = (r, amt) => calls.push(call(r.address, iErc, "approve", [SPOKE, amt]));
    const sp = (fn, args) => calls.push(call(SPOKE, iSpoke, fn, args));
    if (m === "deposit") {
      approve(r1, a1); sp("supply", [r1.id, a1, U]);
      if (fee > 0n) calls.push(call(r1.address, iErc, "transfer", [feeTo, fee]));
    } else if (m === "withdraw" || m === "wcol") {
      // all of it when the user asked for (about) all and nothing leans on it: the spoke reads an
      // amount above the balance as "everything", interest to the second included
      const all = q.x1 >= p.supplied * 0.9999 && (!p.collateral || health().D <= 1e-9);
      sp("withdraw", [r1.id, all ? MAX_UINT : a1, U]);
    } else if (m === "add") {
      approve(r1, a1); sp("supply", [r1.id, a1, U]);
      if (!p.collateral) sp("setUsingAsCollateral", [r1.id, true, U]);
    } else if (m === "repay") {
      // the spoke pulls min(amount, debt); the allowance left over is cleared in the same batch
      approve(r1, a1); sp("repay", [r1.id, a1, U]); approve(r1, 0n);
    } else if (m === "borrow") {
      if (a1) { approve(r1, a1); sp("supply", [r1.id, a1, U]); }
      if (!p.collateral) sp("setUsingAsCollateral", [r1.id, true, U]);
      sp("borrow", [r2.id, a2, U]);
      if (fee > 0n) calls.push(call(r2.address, iErc, "transfer", [feeTo, fee]));
    }
    return calls;
  }

  // Simulate, then sign once, then wait for the receipt. A revert in simulation never reaches
  // the wallet, so no gas is spent on a transaction the spoke would refuse.
  const KNOWN = { "0x851aedc1": "Aave refused it: the health factor would fall too low.", "0x82b42900": "Aave refused it: not enough of the token in the wallet, or the position does not allow it." };
  function why(e) {
    const s = (() => { try { return JSON.stringify(e, Object.getOwnPropertyNames(e)); } catch { return String(e && e.message); } })();
    const sel = (s.match(/0x[0-9a-f]{8}(?![0-9a-f])/i) || [])[0];
    if (sel && KNOWN[sel.toLowerCase()]) return KNOWN[sel.toLowerCase()];
    if (/insufficient funds/i.test(s)) return "Not enough USDC for gas.";
    return "Simulation failed, so nothing was sent: Aave would revert this" + (sel ? ` (${sel})` : "") + ". Try a smaller amount.";
  }
  async function send(calls) {
    const U = ctx.account(), prov = ctx.poolProvider();
    const data = iBatch.encodeFunctionData("aggregate3", [calls.map((c) => [c.to, false, c.data])]);
    let gas;
    try { gas = await prov.estimateGas({ from: U, to: BATCHER, data }); } catch (e) { throw new Error(why(e)); }
    status("Confirm in your wallet…");
    const hash = await ctx.wallet().request({ method: "eth_sendTransaction", params: [{ from: U, to: BATCHER, data, value: "0x0", gas: "0x" + (gas * 13n / 10n).toString(16) }] });
    status("Waiting for Arc to confirm…");
    const rc = await prov.waitForTransaction(hash, 1, 180000);
    if (!rc || rc.status !== 1) throw Object.assign(new Error("The transaction reverted on-chain; nothing moved."), { txHash: hash });
    return hash;
  }
  async function go() {
    if (!ctx.account()) { B("aaveOverlay").classList.remove("open"); ctx.openPicker(); return; }
    const q = quote();
    if (!q) { status("Enter an amount.", "err"); return; }
    if (blocked) return;
    if (gasBal < 0.005) { status("You need a little USDC in this wallet for gas on Arc.", "err"); return; }
    if (!(await ctx.ensureAck())) { status("Accept the terms to continue.", "err"); return; }
    B("aaGo").disabled = true;
    try {
      await ctx.ensureArc();
      const hash = await send(build(q));
      const url = ctx.explorer ? `${ctx.explorer.replace(/\/$/, "")}/tx/${hash}` : "";
      const done = { deposit: `Supplied ${show(q.r1, q.x1)}`, withdraw: `Withdrew ${show(q.r1, q.x1)}`, wcol: `Withdrew ${show(q.r1, q.x1)}`, add: `Added ${show(q.r1, q.x1)}`, repay: `Repaid ${q.r1.symbol}`, borrow: `Borrowed ${show(q.r2, q.x2)}` }[sh.mode];
      await refresh();
      setMode(sh.mode);
      B("aaStatus").className = "status ok";
      B("aaStatus").innerHTML = `${esc(done)}. ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">View transaction ↗</a>` : ""}`;
    } catch (e) {
      status(e.code === 4001 || /reject|denied/i.test(e.message || "") ? "Signature refused; nothing was sent." : (e.shortMessage || e.message || String(e)), "err");
    } finally { B("aaGo").disabled = false; }
  }

  // ---- wiring -------------------------------------------------------------------------------
  B("aaveEarn").addEventListener("click", (e) => { const b = e.target.closest("[data-aave-earn]"); if (b) open({ mode: "deposit", a1: Number(b.dataset.aaveEarn) }); });
  B("aaveMarkets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-aave-col]");
    if (b) return open({ mode: "borrow", a1: Number(b.dataset.aaveCol), a2: Number(b.dataset.aaveDebt) });
    const l = e.target.closest("[data-aave-loan]");
    if (l) open({ mode: l.dataset.aaveLoan });
  });
  B("aaTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-aam]"); if (b) setMode(b.dataset.aam); });
  B("aaPick1C").addEventListener("click", (e) => { const b = e.target.closest("[data-aa1]"); if (b) { sh.a1 = Number(b.dataset.aa1); setMode(sh.mode); } });
  B("aaPick2C").addEventListener("click", (e) => { const b = e.target.closest("[data-aa2]"); if (b) { sh.a2 = Number(b.dataset.aa2); setMode(sh.mode); } });
  B("aaMax1").onclick = () => { if (byId(sh.a1)) { B("aaAmt1").value = String(maxFor(1)); quote(); } };
  B("aaMax2").onclick = () => { B("aaAmt2").value = String(Math.max(0, maxFor(2))); quote(); };
  for (const id of ["aaAmt1", "aaAmt2"]) B(id).addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(quote, 300); });
  B("aaGo").onclick = go;
  const close = () => B("aaveOverlay").classList.remove("open");
  B("aaClose").onclick = close;
  B("aaveOverlay").addEventListener("click", (e) => { if (e.target === B("aaveOverlay")) close(); });

  async function refresh() {
    if (!reserves.length) await loadMarket();
    await loadUser();
    renderEarn(); renderBorrow();
  }
  (async () => { await loadMarket(); await loadUser(); renderEarn(); renderBorrow(); })();
  // the rates move by the block; a quiet re-read every two minutes keeps the cards honest
  setInterval(async () => { if (document.hidden) return; await loadMarket(); await loadUser(); renderEarn(); renderBorrow(); }, 120000);

  // what this wallet has supplied, for the page's "Your deposits" list
  const deposits = () => (ctx.account() ? reserves.filter((r) => u(r.id).supplied > 0).map((r) => ({ id: r.id, symbol: r.symbol, supplied: u(r.id).supplied, dp: r.dp, apy: r.supplyApy, collateral: u(r.id).collateral })) : []);
  return { refresh, renderEarn, renderBorrow, deposits, open, get error() { return loadErr; } };
}
