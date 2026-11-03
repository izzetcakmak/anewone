// Renders cover.html (1500x600 CSS, 5:2) to cover.png at 2x = 3000x1200.   node build-brand/arc-day-48/render.mjs
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 600 }, deviceScaleFactor: Number(process.env.DSF || 2) });
await p.goto("file://" + join(here, "cover.html"), { waitUntil: "networkidle" });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(500);
await p.screenshot({ path: resolve(here, process.env.OUT || "cover.png") });
console.log("rendered", process.env.OUT || "cover.png");
await b.close();
