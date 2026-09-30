// Sets (or shows) the site's origination fee on Circle's Borrow Service. The fee is carved
// from a new loan's proceeds: 90% to BORROW_FEE_ADDRESS, 10% to Arc. It is keyed to the
// Circle API key: the site's Circle Console key, ONRAMP_API_KEY in .env, is the same key
// (CIRCLE_API_KEY overrides it). The key is never printed.
//   node monitor/borrow-fee.mjs            show the current config
//   node monitor/borrow-fee.mjs 25 0x…     set 25 bps (0.25%) paid to 0x…
//   node monitor/borrow-fee.mjs 0          turn the fee off
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, "")])), ...process.env };
const API_KEY = env.CIRCLE_API_KEY || env.ONRAMP_API_KEY;
if (!API_KEY) { console.error("CIRCLE_API_KEY or ONRAMP_API_KEY missing from .env"); process.exit(1); }

// the kit lives in build-earn's node_modules (the page's bundle is built from there)
const { BorrowKit } = createRequire(path.join(ROOT, "build-earn", "package.json"))("@circle-fin/borrow-kit");
const kit = new BorrowKit();
const config = { apiKey: API_KEY };

const [bps, addr] = process.argv.slice(2);
if (bps !== undefined) {
  const n = Number(bps);
  if (!Number.isInteger(n) || n < 0 || n > 10000) { console.error("fee must be whole basis points, 0-10000"); process.exit(1); }
  if (n > 0 && !/^0x[0-9a-fA-F]{40}$/.test(addr || "")) { console.error("a fee above 0 needs the recipient address"); process.exit(1); }
  const r = await kit.setIntegratorConfig({ integratorFeeBps: n, integratorFeeAddress: n > 0 ? addr : null, config });
  console.log("set:", r.integratorFeeBps, "bps →", r.integratorFeeAddress || "(off)");
} else {
  let r;
  try { r = await kit.getIntegratorConfig({ config }); }
  catch (e) { if (/no integrator fee configuration/i.test(e.message || "")) { console.log("no fee set yet (0 bps)"); process.exit(0); } throw e; }
  console.log("integrator", r.integratorId, "·", r.integratorFeeBps, "bps →", r.integratorFeeAddress || "(off)", "· updated", r.updatedAt);
}
