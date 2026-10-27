// node build.mjs  ->  ../docs/vendor/gateway-kit.js (ESM, minified) and prints the SHA-256
// to paste into docs/vendor/PROVENANCE.md.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
const out = "../docs/vendor/gateway-kit.js";
const ver = JSON.parse(readFileSync("node_modules/@circle-fin/unified-balance-kit/package.json", "utf8")).version;
const aver = JSON.parse(readFileSync("node_modules/@circle-fin/adapter-ethers-v6/package.json", "utf8")).version;
await build({
  entryPoints: ["entry.mjs"], bundle: true, minify: true, format: "esm", platform: "browser",
  target: ["es2020"], outfile: out, legalComments: "none", sourcemap: false, inject: ["buffer-shim.mjs"],
  banner: { js: `/* @circle-fin/unified-balance-kit ${ver} + @circle-fin/adapter-ethers-v6 ${aver} — bundled locally, see build-gateway/ and docs/vendor/PROVENANCE.md. Apache-2.0. */` },
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
});
const buf = readFileSync(out);
console.log(out, statSync(out).size, "bytes");
console.log("sha256", createHash("sha256").update(buf).digest("hex"));
