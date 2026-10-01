// Renders post.html (1600x900) to assets-post.png.   node build-brand/assets-post/render.mjs
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new",
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 } });
const p = await b.newPage();
await p.goto("file:///C:/Users/Monster/anewone/build-brand/assets-post/post.html", { waitUntil: "networkidle0" });
await p.evaluate(() => document.fonts.ready);
await new Promise((r) => setTimeout(r, 600));
await p.screenshot({ path: "C:/Users/Monster/anewone/build-brand/assets-post/assets-post.png" });
console.log("rendered 1600x900");
await b.close();
