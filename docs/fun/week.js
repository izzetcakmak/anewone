// The prize race and the $NOAH buyback, in turn (announced 24 Oct 2026, after the community vote
// of 22–24 Oct). Weeks run from Sunday 09:00 UTC to the next Sunday 09:00 UTC and alternate:
//   prize week:   the 10 wallets with the most volume enter a live draw at the close; 3 winners
//                 share 0.5% of the week's AnewOne.Fun volume in USDC, paid within a day;
//   buyback week: 0.5% of that week's volume buys and burns $NOAH at the close (once $NOAH has
//                 graduated, docs.html#noah-burn); there is no race, and the next one starts at 09:00.
// The first prize week is 25 Oct – 1 Nov 2026; the week before it is a warm-up.
// The volume board is data/floor.json's week (monitor/week.mjs, published every 15 minutes at
// most) plus the trades this page has read from the chain since, so it moves with every trade and
// starts from zero at Sunday 09:00 UTC. Winners, payout and buyback links come from
// data/prizes.json, edited by hand after each Sunday. This file draws the banner card, the nav pill
// and the pop-up, and hands the board to the right rail (renderLeaders in fun/index.html).
// Opens from the card, the pill or a link with ?prize=1.
(() => {
  const FIRST_WEEK = "2026-10-25"; // the first prize week; buyback and prize weeks alternate from here
  const DRAW_HOUR = 9, DAY = 864e5, WEEK = 7 * DAY;
  const FIRST_MS = Date.parse(FIRST_WEEK + "T09:00:00Z");
  // the Sunday 09:00 UTC that opened the week holding ms (1970-01-04 was a Sunday)
  const weekStartMs = (ms) => { const d = Math.floor((ms - DRAW_HOUR * 36e5) / DAY); return (d - ((d + 4) % 7)) * DAY + DRAW_HOUR * 36e5; };
  // "warmup" before the first prize week, then "prize" and "burn" in turn
  const kindOf = (startMs) => { const n = Math.round((startMs - FIRST_MS) / WEEK); return n < 0 ? "warmup" : n % 2 === 0 ? "prize" : "burn"; };
  const RULES = "docs.html#weekly-prize";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const track = (event, extra) => { try { window.plausible && window.plausible(event, extra ? { props: extra } : undefined); } catch {} };
  const state = { week: null, lastWeek: null, tip: 0, tipMs: 0, bt: 0.5, prizes: [], loaded: false, burning: false };

  // ---- formatting
  const usd = (wei) => Number(BigInt(wei || "0")) / 1e18;
  const money = (wei) => {
    const n = usd(wei);
    if (n > 0 && n < 0.01) return "<$0.01";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : 2 });
  };
  const day = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const span = (w) => `${day(Date.parse(w.start))} – ${day(Date.parse(w.end) - 1000)}`;
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const explorer = () => { try { return window.ANEWONE_CONFIG.mainnet.explorer || ""; } catch { return ""; } };
  const addrLink = (a) => (explorer() ? `<a href="${esc(explorer())}/address/${esc(a)}" target="_blank" rel="noopener" title="${esc(a)}">${esc(short(a))}</a>` : esc(short(a)));
  const txLink = (tx, label) => (explorer() ? `<a href="${esc(explorer())}/tx/${esc(tx)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label));
  const me = () => { try { return typeof userAddr === "string" ? userAddr.toLowerCase() : ""; } catch { return ""; } };
  function left(ms) {
    if (ms <= 0) return "0m";
    const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  const clockText = () => {
    if (!state.week) return "";
    const now = Date.now(), end = weekStartMs(now) + WEEK, k = kindOf(weekStartMs(now));
    return k === "prize" ? `draw in ${left(end - now)}` : k === "burn" ? `next race in ${left(end - now)}` : `race starts in ${left(end - now)}`;
  };

  // ---- the live board: the published week plus every trade this page has read since its tip
  const BPS = 10_000n;
  const tradeValue = (u, buy) => {
    const fee = typeof FEE_BPS === "bigint" ? FEE_BPS : 150n; // the page reads FEE_BPS() from the platform
    return buy ? u : (u * BPS) / (BPS - fee); // a sell logs what the seller got after the fee
  };
  function liveWeek() {
    const w = state.week;
    if (!w) return null;
    const now = Date.now(), cur = weekStartMs(now);
    const fileStart = Date.parse(w.start);
    // the file still holds the week that just closed: start a fresh one at the boundary block,
    // estimated from the file's tip until the scanner publishes the exact one
    const rolled = fileStart < cur;
    const base = rolled ? null : w;
    const startMs = rolled ? cur : fileStart;
    const startBlock = rolled ? state.tip + Math.max(1, Math.ceil((cur - state.tipMs) / 1000 / (state.bt || 0.5))) : w.startBlock;
    const team = typeof TEAM_WALLETS !== "undefined" ? TEAM_WALLETS : new Set();
    const vol = new Map((base ? base.top : []).map((t) => [t.a.toLowerCase(), BigInt(t.v)]));
    let all = base ? BigInt(base.volume) : 0n, trades = base ? base.trades : 0;
    const recent = (typeof statsIdx !== "undefined" && statsIdx && statsIdx.recent) || [];
    for (const r of recent) {
      if (!(r.b > state.tip) || r.b < startBlock || !r.tr) continue;
      const v = tradeValue(BigInt(r.u), !!r.buy);
      all += v; trades++;
      const a = String(r.tr).toLowerCase();
      if (!team.has(a)) vol.set(a, (vol.get(a) || 0n) + v);
    }
    const top = [...vol.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).map(([a, v]) => ({ a, v: v.toString() }));
    const pot = (all * 50n) / BPS; // half of the platform's 1% slice: the prize in a prize week, the buyback in a buyback week
    const kind = kindOf(startMs);
    const last = rolled ? w : state.lastWeek;
    return {
      id: new Date(startMs).toISOString().slice(0, 10), start: new Date(startMs).toISOString(), end: new Date(startMs + WEEK).toISOString(),
      kind, volume: all.toString(), pot: pot.toString(), each: (pot / 3n).toString(), trades, traders: top.length, top,
      last: last && { ...last, kind: kindOf(Date.parse(last.start)) }, lastPending: rolled,
      railNote: kind === "burn" ? `Buyback week, no race. The next race starts ${day(startMs + WEEK)} at 09:00 UTC.` : "",
    };
  }
  window.anewoneWeekBoard = () => (state.loaded ? liveWeek() : undefined);

  // ---- data
  async function load() {
    try {
      const r = await fetch("data/floor.json", { cache: "no-cache" });
      if (r.ok) {
        const d = await r.json();
        if (d && d.week) {
          state.week = d.week; state.lastWeek = d.lastWeek || null;
          state.tip = Number(d.tip) || 0; state.tipMs = Date.parse(d.generatedAt) || Date.now(); state.bt = Number(d.blockTimeSec) || 0.5;
        }
        // the buyback buys $NOAH in its Uniswap pool, so it runs once $NOAH has graduated (docs.html#noah-burn)
        const noah = (d && d.tokens || []).find((t) => t.symbol === "NOAH");
        state.burning = !!(noah && noah.graduated);
      }
    } catch {}
    try {
      const r = await fetch("data/prizes.json", { cache: "no-cache" });
      if (r.ok) { const p = await r.json(); state.prizes = Array.isArray(p.weeks) ? p.weeks : []; }
    } catch {}
    state.loaded = true;
    paint();
  }

  // ---- the card and the pill
  const clock = () => `<span class="vt-n" data-wk-clock>${esc(clockText())}</span>`;
  function paint() {
    if (typeof renderLeaders === "function") { try { renderLeaders(); } catch {} }
    const card = $("#wkCard"), pill = $("#wkPill");
    const w = liveWeek();
    if (card) {
      card.hidden = !w;
      if (w) {
        const t = $(".vt-card-t", card), s = $(".vt-card-s", card);
        if (w.kind === "prize") {
          t.textContent = `This week's prize: 3 × ${money(w.each)}`;
          s.innerHTML = `The pot grows with every trade. The Top 10 by volume enter Sunday's draw at 09:00 UTC. ${clock()}`;
        } else if (w.kind === "burn") {
          t.textContent = state.burning ? `Buyback week: ${money(w.pot)} for $NOAH` : "Buyback week";
          s.innerHTML = `No race this week: the week's 0.5% goes to the <b>$NOAH buyback</b> on Sunday at 09:00 UTC, and the next prize race starts that minute. ${clock()}`;
        } else {
          t.textContent = "The first USDC prize race starts Sunday, 25 Oct";
          s.innerHTML = `For a week, the 10 wallets with the most trading volume enter a draw for <b>3 equal USDC prizes</b>. The draw is Sunday 1 Nov at 09:00 UTC. ${clock()}`;
        }
      }
    }
    if (pill) pill.hidden = !w;
    if (bg && bg.classList.contains("open")) render();
  }
  function tick() {
    const t = clockText();
    document.querySelectorAll("[data-wk-clock]").forEach((el) => { el.textContent = t; });
  }

  // ---- the pop-up (the vote's shell from vote.css)
  let bg, opener = null;
  function build() {
    if (bg) return;
    bg = document.createElement("div");
    bg.className = "vt-bg";
    bg.innerHTML = `<div class="vt wk" role="dialog" aria-modal="true" aria-labelledby="wkTitle" tabindex="-1">
      <button class="vt-x" type="button" aria-label="Close">✕</button>
      <div class="vt-top"><span class="vt-live"><i></i>Prize race</span><span class="vt-clock" data-wk-clock></span></div>
      <div id="wkBody" aria-live="polite"></div>
    </div>`;
    document.body.appendChild(bg);
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
    $(".vt-x", bg).addEventListener("click", close);
    bg.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && b.dataset.act === "close") close(); });
    bg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      const f = [...bg.querySelectorAll("button, a[href], summary")].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
  }
  function open() {
    build();
    opener = document.activeElement;
    bg.classList.add("open");
    document.documentElement.classList.add("vt-lock");
    render();
    $(".vt-x", bg).focus({ preventScroll: true });
    const w = liveWeek();
    track("prize_open", { prize_week: w ? `${w.id} ${w.kind}` : "none" });
  }
  function close() {
    if (!bg) return;
    bg.classList.remove("open");
    document.documentElement.classList.remove("vt-lock");
    if (opener && opener.focus) opener.focus({ preventScroll: true });
  }

  function boardHtml(w, title) {
    const mine = me();
    const rows = w.top.slice(0, 10);
    const open = Math.max(0, 10 - rows.length);
    const list = rows.map((t, i) => `<div class="wk-row${t.a.toLowerCase() === mine ? " me" : ""}">
        <span class="wk-rk">${i + 1}</span><span class="wk-w">${addrLink(t.a)}${t.a.toLowerCase() === mine ? " <em>you</em>" : ""}</span><span class="wk-v">${money(t.v)}</span></div>`).join("");
    const seats = open ? `<div class="wk-open">${open} of 10 seats still open: any trade takes one</div>` : "";
    return `<div class="vt-res"><h3>${esc(title)} <span>${w.traders} ${w.traders === 1 ? "trader" : "traders"}</span></h3>
      ${rows.length ? list + seats : `<div class="wk-open">No trades this week yet.</div>`}</div>`;
  }
  function potHtml(w, label, value, sub = "") {
    return `<div class="wk-pot">
      <div><span>Trading volume this week</span><b>${money(w.volume)}</b></div>
      <div class="hi"><span>${label}</span><b>${value}${sub ? ` <small>${sub}</small>` : ""}</b></div>
    </div>`;
  }
  // what happened at the close of the week before: the draw after a prize week, the buyback after a buyback week
  function lastHtml(lw) {
    const w = lw.last;
    if (!w || w.kind === "warmup") return "";
    const p = state.prizes.find((x) => x.week === w.id) || {};
    const pending = lw.lastPending ? "The final count for that week is being published. " : "";
    const pot = (BigInt(w.volume) * 50n) / BPS;
    if (w.kind === "prize") {
      const body = Array.isArray(p.winners) && p.winners.length
        ? `${p.winners.map((x) => `<div class="wk-row"><span class="wk-rk">★</span><span class="wk-w">${addrLink(x.a)}</span><span class="wk-v">${x.tx ? txLink(x.tx, "paid " + money((pot / 3n).toString())) : money((pot / 3n).toString())}</span></div>`).join("")}
           ${p.draw ? `<p class="vt-rule"><a href="${esc(p.draw)}" target="_blank" rel="noopener">Watch the draw</a></p>` : ""}`
        : `<p class="vt-rule">${pending}The draw was held on ${day(Date.parse(w.end))} at 09:00 UTC. The 3 winners, the recording and the payout links are posted here within a day.</p>`;
      return `<div class="vt-res"><h3>Last race · ${esc(span(w))} <span>3 × ${money((pot / 3n).toString())}</span></h3>${body}</div>`;
    }
    const body = p.burnTx
      ? `<p class="vt-rule">${txLink(p.burnTx, "The buyback and burn transaction")}${p.burned ? ` · ${esc(p.burned)} $NOAH burned` : ""}</p>`
      : state.burning
        ? `<p class="vt-rule">${pending}The buyback was made on ${day(Date.parse(w.end))} at 09:00 UTC. Its transaction is posted here.</p>`
        : `<p class="vt-rule">${pending}No buyback yet: it starts once $NOAH has graduated.</p>`;
    return `<div class="vt-res"><h3>Last buyback week · ${esc(span(w))} <span>${money(pot.toString())}</span></h3>${body}</div>`;
  }
  const HOW = `<details class="vt-how"><summary>How it works</summary><ol>
      <li><b>Two weeks, in turn.</b> A prize week and a buyback week take turns. Each runs from Sunday 09:00 UTC to the next Sunday 09:00 UTC.</li>
      <li><b>Prize week: trade any coin.</b> Every USDC buy and sell on AnewOne.Fun counts toward your volume. The board starts from zero at 09:00 UTC and updates with every trade. When the week closes, the 10 wallets with the most volume are in. Team wallets are left out; no sign-up, nothing to hold.</li>
      <li><b>Sunday 09:00 UTC: the draw.</b> 3 of the 10 are drawn live, and the draw is recorded. Each winner gets a third of 0.5% of the week's volume in USDC, sent within a day to the wallet that traded. The recording and the payout transactions are posted here.</li>
      <li><b>Buyback week.</b> 0.5% of that week's volume buys and burns $NOAH on the closing Sunday at 09:00 UTC, once $NOAH has graduated, and the transaction is posted here. The next prize race starts that minute.</li>
    </ol></details>`;
  const RULE = `<p class="vt-rule"><b>Prizes are a draw, not a return.</b> $NOAH is a memecoin with no claim on the platform; a smaller supply sets no price. Nothing here is investment advice. <a href="${RULES}">Full rules in the docs</a>.</p>`;
  const CLOSE = `<div class="vt-row"><button class="vt-btn" type="button" data-act="close">Close</button></div>`;

  function render() {
    const body = $("#wkBody", bg);
    const w = liveWeek();
    if (!w) {
      body.innerHTML = `<h2 id="wkTitle">Prize race</h2><p class="vt-lead">${state.loaded ? "This week's board could not be loaded right now. Try again in a minute." : "Loading this week's board…"}</p>`;
      return tick();
    }
    if (w.kind === "prize") {
      body.innerHTML = `<h2 id="wkTitle">3 × ${money(w.each)} in USDC</h2>
        <p class="vt-lead">This week's prize so far. It grows with every trade until the draw on Sunday ${day(Date.parse(w.end))}, 09:00 UTC.</p>
        ${potHtml(w, "USDC prizes (0.5% of volume)", money(w.pot), `= 3 × ${money(w.each)}`)}
        ${boardHtml(w, `Top 10 · ${span(w)}`)}
        ${lastHtml(w)}${HOW}${RULE}${CLOSE}`;
    } else if (w.kind === "burn") {
      body.innerHTML = `<h2 id="wkTitle">Buyback week</h2>
        <p class="vt-lead">No race this week. 0.5% of this week's volume goes to the <b>$NOAH buyback</b> on Sunday ${day(Date.parse(w.end))} at 09:00 UTC, and the next prize race starts that minute.</p>
        ${potHtml(w, "$NOAH buyback (0.5% of volume)", state.burning ? money(w.pot) : "once $NOAH graduates")}
        ${lastHtml(w)}${HOW}${RULE}${CLOSE}`;
    } else {
      body.innerHTML = `<h2 id="wkTitle">The first prize race starts Sunday, 25 Oct</h2>
        <p class="vt-lead">From Sunday 25 Oct, 09:00 UTC, a <b>prize week</b> and a <b>$NOAH buyback week</b> take turns. In a prize week, 3 traders drawn from the week's Top 10 by volume share <b>0.5% of the week's volume</b> in USDC. The first draw is Sunday 1 Nov at 09:00 UTC.</p>
        ${boardHtml(w, "This week · warm-up, no prize")}
        ${HOW}${RULE}${CLOSE}`;
    }
    tick();
  }

  // ---- wire up
  function init() {
    const card = $("#wkCard"), pill = $("#wkPill");
    if (card) $("button", card).addEventListener("click", () => open());
    if (pill) pill.addEventListener("click", () => open());
    setInterval(tick, 30_000);
    setInterval(paint, 15_000); // the trades the page reads every 15 s, and the turn at Sunday 09:00 UTC
    setInterval(load, 5 * 60_000); // the scanner publishes every 15 minutes at most
    load().then(() => { if (new URLSearchParams(location.search).get("prize") === "1") open(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
