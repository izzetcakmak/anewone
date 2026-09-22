// Local smoke test for api/chat.js: no Vercel needed. Reads .env for the keys.
//   node monitor/chat-smoke.mjs            -> GET facts + one anonymous turn
//   node monitor/chat-smoke.mjs --signed   -> also a signed turn (memory on) with a throwaway wallet
import fs from "node:fs";
import { Wallet } from "ethers";
for (const line of fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.CHAT_ALLOW_ANY_ORIGIN = "1";
const { default: handler, signInText } = await import("../api/chat.js");
function call(method, body) {
  return new Promise((resolve) => {
    const res = { headers: {}, code: 200, setHeader(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); }, send(t) { resolve({ code: this.code, body: t }); } };
    handler({ method, headers: { origin: "https://anewone.xyz" }, body, socket: { remoteAddress: "127.0.0.1" } }, res);
  });
}
console.log("GET", JSON.stringify((await call("GET")).body, null, 1));
const q = process.argv.includes("--signed") ? null : "Which coin is closest to graduation?";
if (q) console.log("anon:", JSON.stringify((await call("POST", { action: "chat", messages: [{ role: "user", content: q }] })).body, null, 1));
if (process.argv.includes("--signed")) {
  const w = Wallet.createRandom(); const issued = new Date().toISOString();
  const auth = { address: w.address, issued, signature: await w.signMessage(signInText(w.address, issued)) };
  console.log("wallet", w.address);
  const t1 = await call("POST", { action: "chat", auth, messages: [{ role: "user", content: "Remember that I'm watching NOAH and I prefer answers in Turkish." }] });
  console.log("turn1:", JSON.stringify(t1.body, null, 1));
  await new Promise((r) => setTimeout(r, 15000));
  const t2 = await call("POST", { action: "chat", auth, messages: [{ role: "user", content: "What do you remember about me?" }] });
  console.log("turn2:", JSON.stringify(t2.body, null, 1));
  console.log("memories:", JSON.stringify((await call("POST", { action: "memories", auth })).body, null, 1));
  const bad = await call("POST", { action: "memories", auth: { ...auth, address: Wallet.createRandom().address } });
  console.log("forged address ->", bad.code, bad.body.error);
}
