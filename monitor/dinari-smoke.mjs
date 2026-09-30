// Smoke test for the Dinari API (licensed issuer of tokenized stocks). Read-only.
// Keys come from .env: DINARI_API_KEY_ID, DINARI_API_SECRET_KEY, and optionally
// DINARI_ENV=production (default sandbox). The keys are never printed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fileEnv = {};
try {
  fileEnv = Object.fromEntries(
    readFileSync(path.join(ROOT, ".env"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, "")])
  );
} catch {}
const env = { ...fileEnv, ...process.env };

const BASE = env.DINARI_ENV === "production"
  ? "https://api-enterprise.sbt.dinari.com"
  : "https://api-enterprise.sandbox.dinari.com";
const KEY_ID = env.DINARI_API_KEY_ID;
const SECRET = env.DINARI_API_SECRET_KEY;
if (!KEY_ID || !SECRET) {
  console.error("DINARI_API_KEY_ID / DINARI_API_SECRET_KEY missing from .env (Partners Dashboard → API keys)");
  process.exit(1);
}

async function get(p) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, {
    headers: { "X-API-Key-Id": KEY_ID, "X-API-Secret-Key": SECRET, accept: "application/json" },
  });
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return { status: r.status, ms: Date.now() - t0, json, body };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

console.log(`Dinari ${env.DINARI_ENV === "production" ? "production" : "sandbox"}: ${BASE}\n`);

// 1. auth + stock list
const list = await get("/api/v2/market_data/stocks/?page_size=10");
const stocks = Array.isArray(list.json) ? list.json : list.json?.results || list.json?.data || [];
check("auth + list stocks", list.status === 200 && stocks.length > 0,
  `HTTP ${list.status}, ${stocks.length} stocks, ${list.ms}ms` + (list.status !== 200 ? `  ${list.body.slice(0, 200)}` : ""));
for (const s of stocks.slice(0, 5)) {
  const chains = (s.tokens || []).map((t) => (typeof t === "string" ? t.split(":").slice(0, 2).join(":") : t.chain_id || "?"));
  console.log(`      ${String(s.symbol).padEnd(6)} ${String(s.name).slice(0, 32).padEnd(32)} tradable=${s.is_tradable}  tokens on: ${[...new Set(chains)].join(", ") || "none"}`);
}

// 2. symbol filter
const one = await get("/api/v2/market_data/stocks/?symbols=AAPL");
const aapl = (Array.isArray(one.json) ? one.json : one.json?.results || []).find((s) => s.symbol === "AAPL");
check("filter by symbol (AAPL)", one.status === 200 && !!aapl, `HTTP ${one.status}, ${one.ms}ms`);

// 3. a bad key must be refused
const bad = await fetch(BASE + "/api/v2/market_data/stocks/", {
  headers: { "X-API-Key-Id": "invalid", "X-API-Secret-Key": "invalid" },
});
check("bad key rejected", bad.status === 401 || bad.status === 403, `HTTP ${bad.status}`);

// Arc is not a Dinari chain yet as far as we know; show which chains the tokens live on.
const all = new Set(stocks.flatMap((s) => (s.tokens || []).map((t) => (typeof t === "string" ? t.split(":").slice(0, 2).join(":") : t.chain_id))));
console.log(`\nToken chains seen: ${[...all].filter(Boolean).join(", ") || "none"}`);

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
