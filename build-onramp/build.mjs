// node build.mjs  ->  ../docs/vendor/onramp-kit.js (ESM, minified) and prints the SHA-256
// to paste into docs/vendor/PROVENANCE.md.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
const out = "../docs/vendor/onramp-kit.js";
const ver = JSON.parse(readFileSync("node_modules/@circle-fin/onramp-kit/package.json", "utf8")).version;
await build({
  entryPoints: ["entry.mjs"], bundle: true, minify: true, format: "esm", platform: "browser",
  target: ["es2020"], outfile: out, legalComments: "none", sourcemap: false,
  banner: { js: `/* @circle-fin/onramp-kit ${ver} (browser surface) — bundled locally, see build-onramp/ and docs/vendor/PROVENANCE.md. Apache-2.0. */` },
  define: { "process.env.NODE_ENV": '"production"' },
});
const buf = readFileSync(out);
console.log(out, statSync(out).size, "bytes");
console.log("sha256", createHash("sha256").update(buf).digest("hex"));
console.log("sha384-sri", createHash("sha384").update(buf).digest("base64"));
