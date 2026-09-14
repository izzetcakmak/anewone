// Renders every raster brand asset from docs/brand/logo.svg.
//   node build-brand/build.mjs
// sharp is resolved from the home directory's node_modules (not a project dep).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const sharp = createRequire("C:/Users/Monster/node_modules/")("sharp");

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const mark = readFileSync(`${ROOT}docs/brand/logo.svg`, "utf8");
const inner = mark.replace(/^[\s\S]*?<defs>/, "<defs>").replace(/<\/svg>\s*$/, "");
const INK = "#07080b";

// A square tile: the mark on the site's near-black, scaled to `fill` of the tile.
function tile(fill, radius = 0) {
  const s = 512 * fill, off = (512 - s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${radius}" fill="${INK}"/>
  <g transform="translate(${off} ${off}) scale(${fill})">${inner}</g>
</svg>`;
}

const jobs = [
  ["docs/brand/logo.png",        mark,        1024, { transparent: true }],
  ["docs/brand/logo-1024.png",   tile(0.84),  1024],
  ["docs/brand/pfp-512.png",     tile(0.86),   512],
  ["docs/brand/pfp.png",         tile(0.86),   180],
  ["docs/brand/mark.png",        tile(0.92),    96],
  ["docs/apple-touch-icon.png",  tile(0.88),   180],
  ["docs/favicon.png",           tile(1.00),    32],
];

for (const [out, svg, size, opt = {}] of jobs) {
  let img = sharp(Buffer.from(svg), { density: 600 }).resize(size, size);
  if (!opt.transparent) img = img.flatten({ background: INK });
  await img.png().toFile(`${ROOT}${out}`);
  console.log("wrote", out, size);
}
