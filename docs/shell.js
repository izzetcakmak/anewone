/* A NEW ONE shell: the sky and arch under every .nx-hero, the bar's glass on scroll, the home bar's
   menu and theme switch, and the Deckhand (inline where a page has a [data-nx-chat], floating
   everywhere else). Plain script, no dependencies, safe to load with defer or at the end of the body.
   A page opts out of the floating Deckhand with <html data-nx-nodeck>; an embedded page (?embed=1) never gets it. */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  var script = doc.currentScript;
  var BASE = script && script.src ? new URL(".", script.src).href : location.origin + "/";   // the folder shell.js lives in: the site root
  var qs = function (s, r) { return (r || doc).querySelector(s); };
  var qsa = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var embedded = /[?&]embed=1\b/.test(location.search);

  // ---- the sky: stars, and the arch of stones laid flat beneath the hero ----
  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function starsSvg() {
    var r = rng(11), s = "";
    for (var i = 0; i < 90; i++) {
      var x = r() * 1440, y = 70 + Math.pow(r(), 1.4) * 600, rad = 0.4 + r() * 1.1;
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + rad.toFixed(2) + '" style="--o:' + (0.18 + r() * 0.7).toFixed(2) + ';animation-delay:' + (r() * 6).toFixed(1) + 's"/>';
    }
    return '<svg class="nx-stars" viewBox="0 0 1440 700" preserveAspectRatio="xMidYMin slice" aria-hidden="true">' + s + "</svg>";
  }
  function archSvg() {
    var W = 2600, R = 4200, band = 78, cx = W / 2, apex = 120, cy = apex + R, R2 = R, R1 = R - band;
    var f = function (n) { return n.toFixed(1); };
    var P = function (r, d) { var t = d * Math.PI / 180; return [cx + r * Math.sin(t), cy - r * Math.cos(t)]; };
    var wedge = function (a, b, r1, r2) { var a2 = P(r2, a), b2 = P(r2, b), b1 = P(r1, b), a1 = P(r1, a);
      return "M" + f(a2[0]) + " " + f(a2[1]) + "A" + r2 + " " + r2 + " 0 0 1 " + f(b2[0]) + " " + f(b2[1]) + "L" + f(b1[0]) + " " + f(b1[1]) + "A" + r1 + " " + r1 + " 0 0 0 " + f(a1[0]) + " " + f(a1[1]) + "Z"; };
    var arcP = function (r, a, b) { var p = P(r, a), q = P(r, b); return "M" + f(p[0]) + " " + f(p[1]) + "A" + r + " " + r + " 0 0 1 " + f(q[0]) + " " + f(q[1]); };
    var deg = function (px) { return (px / R2) * (180 / Math.PI); };
    var step = deg(66), gap = deg(5), keyHalf = deg(40), maxA = 20, stones = "";
    [1, -1].forEach(function (sg) {
      for (var b = keyHalf; b < maxA; b += step) {
        var a0 = b + gap / 2, a1 = b + step - gap / 2, mid = (a0 + a1) / 2, fo = 0.28 + 0.72 * Math.exp(-Math.pow(mid / 9, 2));
        stones += '<path d="' + (sg > 0 ? wedge(a0, a1, R1, R2) : wedge(-a1, -a0, R1, R2)) + '" class="nx-stone" style="--o:' + fo.toFixed(2) + '"/>';
      }
    });
    var keyD = wedge(-keyHalf + deg(2), keyHalf - deg(2), R1 - 6, R2 + 12), k = P((R1 - 6 + R2 + 12) / 2, 0), A = 12.5, sc = 0.42;
    return '<svg class="nx-arch" viewBox="0 0 ' + W + ' 300" aria-hidden="true"><defs>' +
      '<radialGradient id="nxStone" cx="' + cx + '" cy="' + cy + '" r="' + R2 + '" gradientUnits="userSpaceOnUse"><stop offset="' + (R1 / R2).toFixed(4) + '" stop-color="var(--nx-mint)" stop-opacity=".02"/><stop offset=".9945" stop-color="var(--nx-mint)" stop-opacity=".3"/><stop offset="1" stop-color="var(--nx-ice)" stop-opacity=".9"/></radialGradient>' +
      '<linearGradient id="nxEdge" gradientUnits="userSpaceOnUse" x1="' + (cx - 1300) + '" x2="' + (cx + 1300) + '"><stop offset="0" stop-color="var(--nx-mint)" stop-opacity=".25"/><stop offset=".5" stop-color="var(--nx-ice)"/><stop offset="1" stop-color="var(--nx-mint)" stop-opacity=".25"/></linearGradient>' +
      '<linearGradient id="nxKey" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--nx-key-a)"/><stop offset="1" stop-color="var(--nx-key-b)"/></linearGradient>' +
      '<filter id="nxB8" x="-5%" y="-100%" width="110%" height="300%"><feGaussianBlur stdDeviation="8"/></filter>' +
      '<filter id="nxB36" x="-5%" y="-200%" width="110%" height="500%"><feGaussianBlur stdDeviation="36"/></filter>' +
      '<filter id="nxBk" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12"/></filter></defs>' +
      '<path d="' + arcP(R2 + 2, -A, A) + '" fill="none" stroke="var(--nx-mint)" stroke-width="60" style="opacity:calc(.42*var(--nx-glow))" filter="url(#nxB36)"/>' +
      '<path d="' + arcP(R2 + 2, -A, A) + '" fill="none" stroke="url(#nxEdge)" stroke-width="14" style="opacity:calc(.7*var(--nx-glow))" filter="url(#nxB8)"/>' + stones +
      '<path d="' + arcP(R2, -A, A) + '" fill="none" stroke="url(#nxEdge)" stroke-width="1.8"/>' +
      '<path d="' + arcP(R1, -A, A) + '" fill="none" stroke="url(#nxEdge)" stroke-width="1" opacity=".5"/>' +
      '<path d="' + keyD + '" fill="var(--nx-mint)" opacity=".55" filter="url(#nxBk)"/>' +
      '<path d="' + keyD + '" fill="url(#nxKey)" stroke="#fff" stroke-opacity=".55" stroke-width="1"/>' +
      '<g transform="translate(' + f(k[0] - 50 * sc) + " " + f(k[1] - 49 * sc) + ') scale(' + sc + ')"><path fill="#04140d" fill-opacity=".92" fill-rule="evenodd" d="M50 10 L82 88 H18 Z M50 46 m-11.5 0 a11.5 11.5 0 1 1 23 0 a11.5 11.5 0 1 1 -23 0 M34 64 H66 V88 H34 Z"/></g></svg>';
  }
  qsa(".nx-hero").forEach(function (h) { if (!qs(".nx-arch", h)) h.insertAdjacentHTML("afterbegin", starsSvg() + archSvg()); });

  // ---- the bar turns to glass once the page moves under it ----
  var bar = qs(".nx-bar") || qs(".nx-nav");
  if (bar) { var onScroll = function () { bar.classList.toggle("stuck", (window.pageYOffset || root.scrollTop) > 20); }; onScroll(); addEventListener("scroll", onScroll, { passive: true }); }

  // ---- the theme switch for pages whose own script does not have one (home, docs); the key is the site's ----
  function flip() { var next = root.getAttribute("data-theme") === "light" ? "dark" : "light"; root.setAttribute("data-theme", next); try { localStorage.setItem("anewone_theme", next); } catch (e) {} }
  qsa("[data-nx-theme]").forEach(function (b) { b.addEventListener("click", flip); });

  // ---- the home bar's menu on a phone ----
  var burger = qs("#nxBurger"), panel = qs("#nxPanel");
  if (burger && panel) {
    burger.addEventListener("click", function () { var o = panel.classList.toggle("open"); burger.setAttribute("aria-expanded", o ? "true" : "false"); });
    panel.addEventListener("click", function (e) { if (e.target.closest("a")) panel.classList.remove("open"); });
    addEventListener("keydown", function (e) { if (e.key === "Escape") panel.classList.remove("open"); });
  }

  // ---- the Deckhand: one conversation per tab, shown by every chat on the page ----
  var API = new URL("api/chat", BASE).href, AVATAR = new URL("chat/deckhand.svg", BASE).href, FULL = new URL("chat/", BASE).href, DOCS = new URL("docs.html", BASE).href;
  var GREET = "Ahoy. I’m the Deckhand. Ask me anything about A NEW ONE: funds, vaults, fees, bridging, how it all fits together.";
  var CHIPS = ["What is A NEW ONE?", "Do you hold my funds?", "Which funds are live on Arc?", "How do I get USDC onto Arc?", "When can I trade stocks?"];
  var STORE = "anewone_deck_v1", MAX_TURNS = 12, MAX_CHARS = 1500;
  var SEND = "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 19V5M5 12l7-7 7 7\"/></svg>";
  var state = { msgs: [], busy: false }, views = [];
  try { var saved = JSON.parse(sessionStorage.getItem(STORE) || "[]"); if (Array.isArray(saved)) state.msgs = saved.filter(function (m) { return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; }).slice(-MAX_TURNS); } catch (e) {}
  function persist() { try { sessionStorage.setItem(STORE, JSON.stringify(state.msgs.filter(function (m) { return !m.err; }).slice(-MAX_TURNS))); } catch (e) {} }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  // text to nodes, with links made only from what the text itself says (no HTML ever reaches the page)
  var LINK = /(https?:\/\/[^\s)<>\x22\x27]+|(?:anewone\.xyz)?\/(?:earn|assets|fun|bridge|chat)\/[^\s)<>\x22\x27]*|(?:anewone\.xyz)?\/(?:docs|about|terms|privacy)\.html[^\s)<>\x22\x27]*)/g;
  function fill(node, text) {
    var last = 0, m; LINK.lastIndex = 0;
    while ((m = LINK.exec(text))) {
      var raw = m[0].replace(/[.,;:!?]+$/, ""), href;
      if (m.index > last) node.appendChild(doc.createTextNode(text.slice(last, m.index)));
      try {
        if (/^https?:/.test(raw)) href = raw; else href = new URL(raw.replace(/^anewone\.xyz/, "").replace(/^\//, ""), BASE).href;
        var a = el("a", null, raw); a.href = href;
        if (new URL(href).origin !== location.origin) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
        node.appendChild(a);
      } catch (e) { node.appendChild(doc.createTextNode(raw)); }
      last = m.index + raw.length; LINK.lastIndex = last;
    }
    if (last < text.length) node.appendChild(doc.createTextNode(text.slice(last)));
  }
  function changed() { views.forEach(function (v) { v.render(); }); persist(); }

  function ask(q) {
    q = String(q || "").trim().slice(0, MAX_CHARS);
    if (!q || state.busy) return;
    state.msgs.push({ role: "user", content: q }); state.busy = true; changed();
    var history = state.msgs.filter(function (m) { return !m.err; }).slice(-MAX_TURNS).map(function (m) { return { role: m.role, content: m.content }; });
    var ctl = typeof AbortController === "function" ? new AbortController() : null, timer = ctl && setTimeout(function () { ctl.abort(); }, 45000);
    fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "chat", mode: "site", messages: history }), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        if (x.r.ok && x.j.reply) state.msgs.push({ role: "assistant", content: String(x.j.reply) });
        else if (x.r.status === 429 && x.j.error === "daily") state.msgs.push({ role: "assistant", err: true, content: "The Deckhand has answered a lot of questions today and is resting until tomorrow. The Docs hold the same answers: " + DOCS });
        else if (x.r.status === 429) state.msgs.push({ role: "assistant", err: true, content: "That is a lot of questions in a minute. Give it a moment and ask again." });
        else state.msgs.push({ role: "assistant", err: true, content: "The Deckhand is not answering right now. The Docs hold the same answers: " + DOCS });
      })
      .catch(function () { state.msgs.push({ role: "assistant", err: true, content: "Could not reach the Deckhand. Check your connection and try again, or read the Docs: " + DOCS }); })
      .then(function () { if (timer) clearTimeout(timer); state.busy = false; changed(); });
  }

  function mount(host, opt) {
    host.classList.add("nx-chat");
    var head = el("div", "nx-chat-h"), img = el("img"); img.src = AVATAR; img.alt = "";
    var who = el("div"); who.appendChild(el("b", null, "Deckhand")); who.appendChild(el("span", null, opt.floating ? "AI assistant" : "AI assistant · knows every door"));
    head.appendChild(img); head.appendChild(who);
    if (opt.floating) { var full = el("a", "nx-chat-full", "Full chat ↗"); full.href = FULL; head.appendChild(full); }
    else { var st = el("div", "st"); st.appendChild(el("i")); st.appendChild(doc.createTextNode("ONLINE")); head.appendChild(st); }
    var body = el("div", "nx-chat-b"); body.setAttribute("aria-live", "polite");
    var chips = el("div", "nx-chat-c");
    CHIPS.forEach(function (q) { var b = el("button", null, q); b.type = "button"; b.addEventListener("click", function () { ask(q); }); chips.appendChild(b); });
    var form = el("form", "nx-chat-f"), input = el("input"), send = el("button");
    input.type = "text"; input.maxLength = MAX_CHARS; input.autocomplete = "off"; input.placeholder = "Ask anything about A NEW ONE…"; input.setAttribute("aria-label", "Your question");
    send.type = "submit"; send.setAttribute("aria-label", "Send"); send.innerHTML = SEND; form.appendChild(input); form.appendChild(send);
    form.addEventListener("submit", function (e) { e.preventDefault(); var v = input.value; if (v.trim() && !state.busy) { input.value = ""; ask(v); } });
    var note = el("div", "nx-chat-n"); note.appendChild(doc.createTextNode("AI answers can be wrong. Nothing here is investment advice. "));
    var tl = el("a", null, "Terms"); tl.href = new URL("terms.html#deckhand", BASE).href; note.appendChild(tl);
    [head, body, chips, form, note].forEach(function (n) { host.appendChild(n); });
    var view = { host: host, input: input,
      render: function () {
        body.textContent = "";
        var g = el("div", "nx-msg bot"); g.textContent = GREET; body.appendChild(g);
        state.msgs.forEach(function (m) { var d = el("div", "nx-msg " + (m.role === "user" ? "me" : m.err ? "err" : "bot")); fill(d, m.content); body.appendChild(d); });
        if (state.busy) { var t = el("div", "nx-msg bot"), dots = el("span", "nx-typing"); dots.appendChild(el("i")); dots.appendChild(el("i")); dots.appendChild(el("i")); t.appendChild(dots); body.appendChild(t); }
        send.disabled = state.busy; body.scrollTop = body.scrollHeight;
      } };
    views.push(view); view.render(); return view;
  }
  qsa("[data-nx-chat]").forEach(function (h) { mount(h, { floating: false }); });

  // the floating Deckhand: a launcher in the corner, and a panel above it
  if (!embedded && !root.hasAttribute("data-nx-nodeck")) {
    var fab = el("button", "nx-fab"), box = el("div", "nx-float");
    fab.type = "button"; fab.setAttribute("aria-label", "Ask the Deckhand"); fab.setAttribute("aria-expanded", "false"); fab.setAttribute("aria-controls", "nxFloat");
    var fi = el("img"); fi.src = AVATAR; fi.alt = ""; fab.appendChild(fi); fab.appendChild(el("i")); fab.appendChild(el("span", null, "Ask Deckhand"));
    box.id = "nxFloat"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Deckhand chat");
    var fv = mount(box, { floating: true });
    doc.body.appendChild(box); doc.body.appendChild(fab);
    var setOpen = function (o) { box.classList.toggle("open", o); fab.setAttribute("aria-expanded", o ? "true" : "false"); if (o) { fv.render(); setTimeout(function () { try { fv.input.focus({ preventScroll: true }); } catch (e) {} }, 60); } };
    fab.addEventListener("click", function () { setOpen(!box.classList.contains("open")); });
    doc.addEventListener("click", function (e) { if (box.classList.contains("open") && !box.contains(e.target) && !fab.contains(e.target)) setOpen(false); });
    addEventListener("keydown", function (e) { if (e.key === "Escape" && box.classList.contains("open")) { setOpen(false); fab.focus(); } });
    var inline = qs("[data-nx-chat]");
    if (inline && "IntersectionObserver" in window) new IntersectionObserver(function (en) { fab.classList.toggle("away", en[0].isIntersecting); }, { threshold: 0.35 }).observe(inline);
  }

  window.NX = { ask: ask, base: BASE };
})();
