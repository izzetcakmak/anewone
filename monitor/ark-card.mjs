/**
 * Renders docs/ark/card.jpg — the preview image X and every other unfurler shows
 * when the ark is shared.
 *
 * The page draws itself entirely from inline SVG, so there is no artwork file to
 * point at; the card has to be a picture OF the page. Rasterising matters:
 * X silently refuses to render an SVG card, which is the mistake $NOAH's own
 * card made before it was flattened to a JPEG.
 *
 * Run it again whenever the boat or its passengers change:
 *   node monitor/ark-card.mjs
 */
import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const OUT = path.join(DOCS, "ark", "card.jpg");
const CHROME = process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
                ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

// file:// would work, but serving matches how the page is actually loaded
const server = http.createServer((req, res) => {
  let p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DOCS) || !fs.existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  // 1240 makes .scene exactly 1200 wide once the stage padding is taken off
  defaultViewport: { width: 1240, height: 900, deviceScaleFactor: 2 },
});
try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(base + "/ark/", { waitUntil: "networkidle0" });

  // The gate only exists to unlock audio, which a screenshot does not need. The
  // deck is already laid out underneath it, so lifting the gate is enough.
  await page.evaluate(() => {
    document.getElementById("gate").remove();
    // Hold everything still: a card caught mid-blink reads as a rendering bug,
    // and the passengers breathe and blink continuously now.
    document.querySelectorAll(".cloud, .wave, .body, .eyes")
      .forEach((el) => { el.style.animation = "none"; });
    // and point every gaze slightly down-left, so the crowd looks at the reader
    document.querySelectorAll(".crew button").forEach((b) => {
      b.style.setProperty("--px", "-0.7");
      b.style.setProperty("--py", "0.9");
    });
    // The captain's thoughts only surface on hover, and a share card has no
    // pointer — so open the story one by hand, or the card loses the caption.
    const story = document.getElementById("thought");
    if (story) { story.classList.add("show"); story.style.transition = "none"; }
  });
  await page.waitForFunction(() => document.querySelectorAll(".crew button").length >= 13);

  const scene = await page.$(".scene");
  const box = await scene.boundingBox();
  await scene.screenshot({ path: OUT, type: "jpeg", quality: 88 });

  if (errs.length) console.log("page errors:", errs);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`wrote ${path.relative(DOCS, OUT)}  ${Math.round(box.width)}x${Math.round(box.height)} css px`
              + ` @2x  ${kb} KB`);
} finally {
  await browser.close();
  server.close();
}
