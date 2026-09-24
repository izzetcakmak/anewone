// Static preview of docs/ for the in-app browser. Fakes the two onramp config endpoints so the
// "Buy USDC with card" button can be seen without a Circle key; never used in production.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const root = path.resolve(process.argv[2] || "docs"), port = Number(process.argv[3] || 4174);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".woff2": "font/woff2" };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/api/onramp-config") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ enabled: true, endpoint: "/api/onramp-session" }));
  if (u === "/api/onramp-session") return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "preview server: no Circle key here" }));
  let f = path.join(root, u); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!f.startsWith(root) || !fs.existsSync(f)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log("docs preview on http://localhost:" + port));
