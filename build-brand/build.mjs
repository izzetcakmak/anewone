// Renders every raster brand asset from docs/brand/logo.svg (a 1024 square that
// carries its own ground). Small sizes are cropped to the letters first so the
// mark stays legible.   node build-brand/build.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const sharp = createRequire("C:/Users/Monster/node_modules/")("sharp");

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const svg = readFileSync(`${ROOT}docs/brand/logo.svg`, "utf8");
const noGround = svg.replace(/<rect width="1024" height="1024" fill="#0c0c0b"\/>\s*/, "");

const full = await sharp(Buffer.from(svg), { density: 300 }).resize(1024, 1024).png().toBuffer();
const clear = await sharp(Buffer.from(noGround), { density: 300 }).resize(1024, 1024).png().toBuffer();

// [file, size, crop as a fraction of the full square centred on the letters]
const crop = (f) => { const w = Math.round(1024 * f); return { left: Math.round(512 - w / 2), top: Math.round(512 - w / 2), width: w, height: w }; };
const jobs = [
  ["docs/brand/logo-1024.png",   1024, 1],
  ["docs/brand/pfp-512.png",      512, 1],
  ["docs/brand/pfp.png",          180, 1],
  ["docs/apple-touch-icon.png",   180, 0.90],
  ["docs/brand/mark.png",          96, 0.86],
  ["docs/favicon.png",             32, 0.80],
];
for (const [out, size, f] of jobs) {
  let img = sharp(full);
  if (f < 1) img = img.extract(crop(f));
  await img.resize(size, size).png().toFile(`${ROOT}${out}`);
  console.log("wrote", out, size);
}
await sharp(clear).png().toFile(`${ROOT}docs/brand/logo.png`);
console.log("wrote docs/brand/logo.png 1024 (no ground)");
