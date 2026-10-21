// Community vote on how the Ecosystem Budget is spent: a two-step pop-up, walletless and
// gas-free. Step 1 asks whether to launch weekly USDC prizes; step 2 (only after a Yes)
// picks one of three models. Votes go to /api/vote (api/_vote.js), one per browser,
// changeable until the window closes. Opens from the banner, the nav pill, a link with
// ?vote=1, or once on a first visit. Every string the visitor reads is in this file.
(() => {
  const API = "/api/vote";
  const SHARE_URL = "https://anewone.xyz/fun/?vote=1";
  const $ = (s, r = document) => r.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const track = (event, extra) => { try { (window.dataLayer = window.dataLayer || []).push({ event, ...extra }); } catch {} };

  // ---- the three models, as the visitor reads them
  const MODELS = {
    alternating: {
      name: "Alternating", tag: "Burn week, then prize week",
      text: "One week the whole budget buys and burns $NOAH. The next week the whole budget is paid out in USDC, split equally between 3 wallets drawn from the Top 10 by trading volume. Then it repeats.",
      tl: ["b", "p", "b", "p", "b", "p"],
    },
    hybrid: {
      name: "Hybrid", tag: "Burn and prizes, every week",
      text: "Every week the budget is split. One part keeps buying and burning $NOAH, the other is paid in USDC to 3 wallets drawn from the Top 10 by trading volume. The exact split is announced before the first draw.",
      tl: ["h", "h", "h", "h", "h", "h"],
    },
    classic: {
      name: "Classic", tag: "Keep it as it is",
      text: "The whole Ecosystem Budget stays on the weekly $NOAH buy-and-burn. No cash prizes, nothing new to run.",
      tl: ["b", "b", "b", "b", "b", "b"],
    },
  };
  const ORDER = ["alternating", "hybrid", "classic"];

  const ICON = {
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  };

  const state = { poll: null, view: "intro", pick: null, mine: store.get("anewone_vote_mine"), busy: false, error: "", opener: null, loadFailed: false };
  const voterId = () => {
    let v = store.get("anewone_voter");
    if (!/^[a-f0-9]{32}$/.test(v || "")) {
      v = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      store.set("anewone_voter", v);
    }
    return v;
  };

  // ---- poll data
  async function load() {
    try {
      const r = await fetch(API, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(r.status);
      state.poll = await r.json();
      // the vote I remember belongs to one poll; a new poll starts clean
      const stored = store.get("anewone_vote_poll");
      if (stored && stored !== state.poll.poll) { state.mine = null; store.set("anewone_vote_mine", ""); }
      state.loadFailed = false;
    } catch { state.loadFailed = true; }
    paintEntries();
  }
  // a preview deployment runs its own poll (api/_vote.js); say so, so nobody mistakes a rehearsal for the real vote
  const isTest = () => !!state.poll && /-draft$/.test(state.poll.poll);
  const closesMs = () => (state.poll ? Date.parse(state.poll.closesAt) : 0);
  const opensMs = () => (state.poll ? Date.parse(state.poll.opensAt) : 0);
  const isUpcoming = () => !!state.poll && Date.now() < opensMs();
  const isOpen = () => !!state.poll && !isUpcoming() && Date.now() < closesMs();
  const nf = (n) => Number(n).toLocaleString("en-US");
  const votes = (n) => `${nf(n)} ${n === 1 ? "vote" : "votes"}`;
  function clockText() {
    if (!state.poll) return "";
    const soon = isUpcoming();
    let s = Math.floor(((soon ? opensMs() : closesMs()) - Date.now()) / 1000);
    if (s <= 0) return soon ? "Opening now" : "Voting closed";
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const p = (x) => String(x).padStart(2, "0");
    return `${soon ? "Opens" : "Closes"} in ${d ? d + "d " : ""}${p(h)}h ${p(m)}m${d ? "" : " " + p(s) + "s"}`;
  }
  const when = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
  const closesLabel = () => when(closesMs());

  // ---- entry points: banner, nav pill
  function paintEntries() {
    const card = $("#vtCard"), pill = $("#vtPill");
    const done = !!state.mine, open = isOpen();
    if (card) {
      if (!state.poll || isUpcoming()) { card.hidden = true; }
      else {
        card.hidden = false;
        card.classList.toggle("is-done", done && open);
        card.classList.toggle("is-closed", !open);
        $(".vt-card-t", card).textContent = !open ? "Community vote closed" : done ? "Your vote is in" : "Should trading on AnewOne.Fun earn weekly USDC?";
        $(".vt-card-s", card).innerHTML = !open
          ? `Final count: <span class="vt-n">${votes(state.poll.total)}</span>.`
          : done
            ? `Thank you. <span class="vt-n">${votes(state.poll.total)}</span> so far. You can change yours until it closes.`
            : `You decide how the Ecosystem Budget is spent. 30 seconds, <b>no wallet, no gas</b>.${state.poll.total ? ` <span class="vt-n">${votes(state.poll.total)}</span> so far.` : ""}`;
        if (isTest()) $(".vt-card-s", card).innerHTML += ` <b class="vt-testtag">Test version: votes here do not count.</b>`;
        $("button", card).textContent = !open ? "See results" : done ? "View results" : "Cast your vote";
      }
    }
    if (pill) {
      pill.hidden = !state.poll || isUpcoming();
      pill.classList.toggle("is-done", done && open);
      pill.classList.toggle("is-closed", !open);
      $(".vt-pill-t", pill).textContent = !open ? "Results" : done ? "Voted" : "Vote";
    }
  }
  function tick() {
    const t = clockText();
    document.querySelectorAll("[data-vt-clock]").forEach((el) => { el.textContent = t; });
  }

  // ---- the pop-up shell
  let bg;
  function build() {
    if (bg) return;
    bg = document.createElement("div");
    bg.className = "vt-bg";
    bg.innerHTML = `<div class="vt" role="dialog" aria-modal="true" aria-labelledby="vtTitle" tabindex="-1">
      <button class="vt-x" type="button" aria-label="Close">✕</button>
      <div class="vt-top"><span class="vt-live"><i></i>Community vote</span><span class="vt-clock" data-vt-clock></span></div>
      <div class="vt-test" id="vtTest" hidden><b>Test version.</b> Votes cast here do not count. The real vote is on anewone.xyz/fun.</div>
      <div class="vt-prog" aria-hidden="true"><span></span><span></span><span></span></div>
      <div id="vtBody" aria-live="polite"></div>
    </div>`;
    document.body.appendChild(bg);
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
    $(".vt-x", bg).addEventListener("click", close);
    bg.addEventListener("click", onClick);
    bg.addEventListener("keydown", onKey);
  }
  function open(view) {
    build();
    state.opener = document.activeElement;
    state.error = ""; state.busy = false; state.pick = null;
    state.view = isUpcoming() ? "soon" : !isOpen() || state.mine ? "result" : view || "intro";
    if (state.loadFailed) state.view = "down";
    bg.classList.add("open");
    document.documentElement.classList.add("vt-lock");
    render();
    tick();
    track("vote_open", { vote_view: state.view });
    load().then(render); // refresh counts behind the first paint
  }
  function close() {
    if (!bg) return;
    bg.classList.remove("open");
    document.documentElement.classList.remove("vt-lock");
    try { const u = new URL(location.href); if (u.searchParams.has("vote")) { u.searchParams.delete("vote"); history.replaceState(null, "", u); } } catch {}
    if (state.opener && state.opener.focus) state.opener.focus();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...bg.querySelectorAll("button:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ---- views
  const prog = (n) => [...bg.querySelectorAll(".vt-prog span")].forEach((s, i) => s.classList.toggle("on", i < n));
  const pct = (n, of) => (of > 0 ? Math.round((n / of) * 100) : 0);

  function resultsHtml() {
    const c = (state.poll && state.poll.counts) || { no: 0, alternating: 0, hybrid: 0, classic: 0 };
    const yes = c.alternating + c.hybrid + c.classic, total = yes + c.no;
    if (!total) return `<div class="vt-res"><h3>Live results <span>0 votes</span></h3><div class="vt-foot" style="margin:0;text-align:left">No votes yet. Yours could be the first.</div></div>`;
    const bar = (label, n, of, cls) => `<div class="vt-bar ${cls || ""}"><span>${label}</span><span class="vt-trk"><span class="vt-fill" data-w="${pct(n, of)}"></span></span><span class="vt-pc">${pct(n, of)}%</span></div>`;
    const lead = yes ? ORDER.reduce((a, b) => (c[b] > c[a] ? b : a)) : null;
    const mineKey = state.mine;
    return `<div class="vt-res"><h3>Launch the program? <span>${votes(total)}</span></h3>
        ${bar("Yes", yes, total, yes > c.no ? "lead" : "")}${bar("No", c.no, total, c.no >= yes && c.no ? "lead" : "")}</div>
      <div class="vt-res"><h3>Preferred model <span>${nf(yes)} yes</span></h3>
        ${ORDER.map((k) => bar(MODELS[k].name, c[k], yes, (k === lead && c[k] ? "lead " : "") + (k === mineKey ? "mine" : ""))).join("")}</div>`;
  }
  const RULE = `<p class="vt-rule"><b>How it is decided.</b> The program goes ahead only if more than half of all votes are Yes. The model with the most votes then wins; if that is Classic, nothing changes. The final count is published here and in the docs, and any change is announced before it starts.</p>`;

  function render() {
    if (!bg) return;
    const body = $("#vtBody", bg);
    $("#vtTest", bg).hidden = !isTest();
    const v = state.view;
    let h = "";
    if (v === "intro") {
      prog(1);
      h = `<h2 id="vtTitle">Should we launch the new community incentive program?</h2>
        <p class="vt-lead">Today the <b>Ecosystem Budget</b>, the share of platform fees we set aside, has one job: buying <b>$NOAH</b> every week and burning it. You decide whether part of it should also go back to the people who trade here, as <b>weekly USDC prizes</b>.</p>
        <div class="vt-acts">
          <button class="vt-btn pri" type="button" data-act="yes">Yes, launch it</button>
          <button class="vt-btn" type="button" data-act="no">No, keep things as they are</button>
        </div>
        ${state.error ? `<p class="vt-err" role="alert">${state.error}</p>` : ""}
        <p class="vt-foot"><b>${state.poll ? votes(state.poll.total) : "–"}</b> so far · closes ${closesLabel()}</p>`;
    } else if (v === "pick") {
      prog(2);
      h = `<h2 id="vtTitle">How should the Ecosystem Budget work?</h2>
        <p class="vt-lead">Pick one model. Prizes are drawn from the <b>weekly Top 10 by trading volume</b>, and every draw can be checked by anyone.</p>
        <div class="vt-opts" role="radiogroup" aria-label="Ecosystem Budget model">
          ${ORDER.map((k) => { const m = MODELS[k]; return `<button type="button" class="vt-opt" role="radio" aria-checked="${state.pick === k}" data-pick="${k}">
            <span class="vt-radio"></span>
            <span class="vt-nm">${m.name}<em>${m.tag}</em></span>
            <p>${m.text}</p>
            <span class="vt-tl" aria-hidden="true">${m.tl.map((x) => `<i class="${x}"></i>`).join("")}</span>
          </button>`; }).join("")}
        </div>
        <div class="vt-key" aria-hidden="true"><span><i></i>Buy &amp; burn $NOAH</span><span><i class="p"></i>USDC prizes</span><span>Six weeks shown</span></div>
        <details class="vt-how"><summary>How the weekly draw stays fair</summary>
          <ol>
            <li><b>Snapshot.</b> Each week runs Monday 00:00 to Sunday 23:59 UTC. Volume is every USDC buy and sell on AnewOne.Fun, read straight from Arc.</li>
            <li><b>Top 10.</b> The ten wallets with the most volume qualify. Team wallets are left out, and wallets that only trade against themselves do not count.</li>
            <li><b>Random draw.</b> 3 of the 10 are picked using the hash of a block on Arc that does not exist yet when the week closes. Nobody, including us, can know it in advance.</li>
            <li><b>Proof.</b> We publish the snapshot, the block and the winners with their payout transactions. Anyone can recompute the draw.</li>
          </ol>
        </details>
        ${state.error ? `<p class="vt-err" role="alert">${state.error}</p>` : ""}
        <p class="vt-foot">No wallet, no gas. Voting is open to everyone: one vote per browser, and you can change it until ${closesLabel()}.</p>
        <div class="vt-row stick">
          <button class="vt-btn back" type="button" data-act="back">Back</button>
          <button class="vt-btn pri" type="button" data-act="cast" ${state.pick && !state.busy ? "" : "disabled"}>${state.busy ? "Counting…" : "Cast my vote"}</button>
        </div>`;
    } else if (v === "result") {
      const open_ = isOpen(), mine = state.mine;
      prog(3);
      const headline = !open_ ? "Voting is closed" : mine === "no" ? "Thank you for voting" : mine ? "Your vote is in" : "Live results";
      const sub = !open_ ? "Thank you to everyone who took part. This is the final count."
        : mine === "no" ? "Nothing changes for now: the Ecosystem Budget keeps buying and burning $NOAH every week unless the community decides otherwise."
        : mine ? `You chose <b>${MODELS[mine].name}</b>. Share it, and every vote counts: more voices make a stronger signal.`
        : "Here is where the community stands right now.";
      h = `<div class="vt-done">${mine ? `<div class="vt-tick">${ICON.tick}</div>` : ""}
        <h2 id="vtTitle">${headline}</h2><p class="vt-lead">${sub}</p></div>
        ${resultsHtml()}${RULE}
        ${open_ && mine ? `<div class="vt-share"><button class="vt-btn pri" type="button" data-act="share">Share on X</button><button class="vt-btn" type="button" data-act="copy">Copy link</button></div>
          <div style="text-align:center"><button class="vt-link" type="button" data-act="change">Change my vote</button></div>`
          : open_ ? `<div class="vt-acts"><button class="vt-btn pri" type="button" data-act="start">Cast your vote</button></div>`
          : `<div class="vt-acts"><button class="vt-btn" type="button" data-act="close">Close</button></div>`}`;
    } else if (v === "soon") {
      prog(1);
      h = `<h2 id="vtTitle">The community vote opens soon</h2>
        <p class="vt-lead">On <b>${when(opensMs())}</b> you decide how the Ecosystem Budget is spent: weekly USDC prizes for active traders, or 100% buyback and burn. No wallet, no gas, 30 seconds. Come back then, the vote will open right on this page.</p>
        <div class="vt-acts"><button class="vt-btn" type="button" data-act="close">Got it</button></div>`;
    } else { // down
      prog(1);
      h = `<h2 id="vtTitle">Voting is unavailable right now</h2>
        <p class="vt-lead">We could not reach the vote. Nothing you did is lost, please try again in a minute.</p>
        <div class="vt-acts"><button class="vt-btn pri" type="button" data-act="retry">Try again</button></div>`;
    }
    body.innerHTML = h;
    requestAnimationFrame(() => {
      body.querySelectorAll(".vt-fill").forEach((el) => { el.style.width = el.dataset.w + "%"; });
      const f = body.querySelector(v === "pick" ? ".vt-opt" : ".vt-btn.pri, .vt-btn");
      if (f && !body.contains(document.activeElement)) f.focus({ preventScroll: true });
    });
    tick();
  }

  // ---- actions
  async function cast(choice) {
    if (state.busy) return;
    state.busy = true; state.error = ""; render();
    try {
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voter: voterId(), choice }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
      state.poll = j; state.mine = choice;
      store.set("anewone_vote_mine", choice); store.set("anewone_vote_poll", j.poll);
      state.busy = false; state.view = "result"; track("vote_cast", { vote_choice: choice });
      paintEntries();
    } catch (e) {
      state.busy = false;
      state.error = e.status === 410 ? "Voting has just closed." : e.status === 429 ? "Too many votes from this network. Please try again later." : "We could not record your vote. Please try again.";
      if (e.status === 410) { await load(); state.view = "result"; }
    }
    render();
  }
  const shareText = () => {
    const m = state.mine && state.mine !== "no" ? MODELS[state.mine].name.toLowerCase() : null;
    return m ? `I just voted on how @AnewOne_xyz spends its Ecosystem Budget: I picked the ${m} model. Weekly USDC prizes for traders vs 100% buyback & burn. No wallet, no gas, 30 seconds.`
      : "I just voted on how @AnewOne_xyz spends its Ecosystem Budget: weekly USDC prizes for traders, or 100% buyback & burn? No wallet, no gas, 30 seconds.";
  };
  function onClick(e) {
    const opt = e.target.closest("[data-pick]");
    if (opt) { state.pick = opt.dataset.pick; render(); const again = bg.querySelector(`[data-pick="${state.pick}"]`); if (again) again.focus({ preventScroll: true }); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "yes") { state.view = "pick"; state.pick = state.mine && state.mine !== "no" ? state.mine : null; state.error = ""; render(); }
    else if (act === "no") cast("no");
    else if (act === "back") { state.view = "intro"; state.error = ""; render(); }
    else if (act === "cast" && state.pick) cast(state.pick);
    else if (act === "change" || act === "start") { state.view = "intro"; state.error = ""; render(); }
    else if (act === "share") window.open("https://x.com/intent/post?text=" + encodeURIComponent(shareText()) + "&url=" + encodeURIComponent(SHARE_URL), "_blank", "noopener");
    else if (act === "copy") {
      (navigator.clipboard ? navigator.clipboard.writeText(SHARE_URL) : Promise.reject()).then(() => { b.textContent = "Link copied"; setTimeout(() => { b.textContent = "Copy link"; }, 1800); }).catch(() => { b.textContent = SHARE_URL; });
    }
    else if (act === "retry") { load().then(() => { state.view = state.loadFailed ? "down" : isOpen() && !state.mine ? "intro" : "result"; render(); }); }
    else if (act === "close") close();
  }

  // ---- wire up
  function init() {
    const card = $("#vtCard"), pill = $("#vtPill");
    if (card) $("button", card).addEventListener("click", (e) => open());
    if (pill) pill.addEventListener("click", () => open());
    setInterval(tick, 1000);
    // a page that was open before the start shows the vote by itself once the time comes (the times come from the API)
    setInterval(() => {
      paintEntries();
      if (bg && bg.classList.contains("open") && state.view === "soon" && !isUpcoming()) { state.view = state.mine ? "result" : "intro"; render(); }
    }, 5000);
    load().then(() => {
      const wantsIt = new URLSearchParams(location.search).get("vote") === "1";
      if (wantsIt) { open(); return; }
      // once, on a first visit, a few seconds in, and never on top of something else
      const calm = () => !document.hidden && !document.querySelector(".modal-bg.open, .vt-bg.open");
      if (isOpen() && !state.mine && !store.get("anewone_vote_seen")) {
        setTimeout(() => { if (calm()) { store.set("anewone_vote_seen", "1"); open(); } }, 6000);
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
