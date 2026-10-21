// Static preview of docs/ for the in-app browser. Fakes the two onramp config endpoints so the
// "Buy USDC with card" button can be seen without a Circle key; never used in production.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
process.env.CHAT_ALLOW_ANY_ORIGIN = "1"; // the preview has no anewone.xyz origin
const xstocks = (await import("../api/xstocks.js")).default; // the real function, run in-process
const usyc = (await import("../api/usyc.js")).default;
const ack = (await import("../api/ack.js")).default; // carries /api/vote behind the rewrite
const borrowFee = (await import("../api/borrow-fee.js")).default; // keyless here unless the env carries one
// vercel.json's rewrites for the kit's fee-bearing Borrow Service paths
const BORROW_PATHS = { "/v1/borrowKit/loans/borrow/quote": "quote", "/v1/borrowKit/loans/borrow": "execute" };
const root = path.resolve(process.argv[2] || "docs"), port = Number(process.argv[3] || 4174);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".woff2": "font/woff2" };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/api/onramp-config") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ enabled: true, endpoint: "/api/onramp-session" }));
  if (u === "/api/onramp-session") return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "preview server: no Circle key here" }));
  if (BORROW_PATHS[u]) {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { setHeader: (k, v) => res.setHeader(k, v), status(c) { res.statusCode = c; return r; }, json(o) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); }, send(t) { res.end(t); } };
      borrowFee({ method: req.method, headers: req.headers, query: { op: BORROW_PATHS[u] }, body, socket: req.socket }, r).catch((e) => { res.writeHead(500).end(String(e)); });
    });
    return;
  }
  if (u === "/api/vote") { // the community vote: Vercel rewrites this to ack.js?poll=1; keeps votes in memory here
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch {}
      const r = { setHeader: (k, v) => res.setHeader(k, v), status(c) { res.statusCode = c; return r; }, json(o) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); } };
      ack({ method: req.method, headers: req.headers, query: { poll: "1" }, body: parsed, socket: req.socket }, r).catch((e) => { res.writeHead(500).end(String(e)); });
    });
    return;
  }
  const fn = { "/api/xstocks": xstocks, "/api/usyc": usyc }[u];
  if (fn) { // same shape Vercel gives the function: query parsed, json/status helpers
    const q = Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const r = { setHeader: (k, v) => res.setHeader(k, v), status(c) { res.statusCode = c; return r; }, json(o) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); } };
    return fn({ method: req.method, headers: req.headers, query: q, socket: req.socket }, r).catch((e) => { res.writeHead(500).end(String(e)); });
  }
  let f = path.join(root, u); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!f.startsWith(root) || !fs.existsSync(f)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log("docs preview on http://localhost:" + port));
