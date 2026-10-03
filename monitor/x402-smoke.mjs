// The x402 handshake of /api/agent, end to end, without the Circle CLI.
//
//   node monitor/x402-smoke.mjs                       the 402 of the live site: is the price list sane?
//   node monitor/x402-smoke.mjs --url http://localhost:3000/api/agent/tokens?limit=2
//   BUYER_KEY=0x... node monitor/x402-smoke.mjs --pay  sign an EIP-3009 authorization for the first
//                                                      accepted option and retry: a real payment on
//                                                      that network, so point it at a testnet deploy
//                                                      (X402_NETWORKS=eip155:5042002) and a buyer
//                                                      wallet with Arc testnet USDC from faucet.circle.com
//   node monitor/x402-smoke.mjs --local               the paywall in-process with a fake request:
//                                                      503 unconfigured, 402 configured, every
//                                                      refusal of a bad PAYMENT-SIGNATURE; no network
import { Wallet, toBeHex, randomBytes } from "ethers";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const url = opt("--url", "https://anewone.xyz/api/agent/tokens?limit=2");

const dec = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const out = (label, x) => console.log(label, typeof x === "string" ? x : JSON.stringify(x, null, 1).slice(0, 1800));

/** The buyer's half: sign a TransferWithAuthorization for one accepted option, as the Circle CLI would. */
async function signFor(accept, key) {
  const buyer = new Wallet(key);
  const chainId = Number(accept.network.split(":")[1]);
  const authorization = {
    from: buyer.address,
    to: accept.payTo,
    value: accept.amount,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + Math.min(3600, (accept.maxTimeoutSeconds || 60) * 10)),
    nonce: toBeHex(BigInt("0x" + Buffer.from(randomBytes(32)).toString("hex")), 32),
  };
  const signature = await buyer.signTypedData(
    { name: accept.extra.name, version: accept.extra.version, chainId, verifyingContract: accept.asset },
    { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  );
  return { x402Version: 2, accepted: accept, payload: { signature, authorization } };
}

async function remote() {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  out(`GET ${url} -> ${r.status}`, "");
  const hdr = r.headers.get("payment-required");
  const body = await r.json().catch(() => null);
  if (r.status !== 402) return out("body:", body);
  const req = hdr ? dec(hdr) : body;
  out("PAYMENT-REQUIRED (decoded):", req);
  if (!hdr) console.log("WARNING: no PAYMENT-REQUIRED header; the body carried the requirements");
  if (JSON.stringify(req) !== JSON.stringify(body)) console.log("WARNING: header and body differ");
  if (!flag("--pay")) return;
  const key = process.env.BUYER_KEY;
  if (!key) throw new Error("--pay needs BUYER_KEY");
  const accept = req.accepts[0];
  console.log(`paying ${accept.amount} units on ${accept.network} to ${accept.payTo} from ${new Wallet(key).address}`);
  const sig = enc(await signFor(accept, key));
  const r2 = await fetch(url, { headers: { accept: "application/json", "PAYMENT-SIGNATURE": sig } });
  out(`retry -> ${r2.status}`, "");
  const pr = r2.headers.get("payment-response");
  if (pr) out("PAYMENT-RESPONSE (decoded):", dec(pr));
  out("body:", await r2.json().catch(() => null));
}

/** A fake Vercel req/res pair for the in-process run. */
function fake(path, headers = {}) {
  const res = { statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; }, headersSent: false };
  return { req: { method: "GET", url: path, headers: { host: "anewone.xyz", ...headers }, socket: {} }, res };
}

async function local() {
  const { paywall } = await import("../api/_x402.js");
  const check = async (label, path, headers, expect) => {
    const { req, res } = fake(path, headers);
    const ok = await paywall(req, res, path.replace(/^\/api\/agent\/?/, "").split(/[/?]/)[0] || "");
    const got = ok ? "serve" : res.statusCode + " " + (res.body && (res.body.error || "")).slice(0, 70);
    console.log((String(got).startsWith(expect) ? "ok   " : "FAIL ") + label + " -> " + got);
    return res;
  };
  // 1. nothing configured: priced routes 503, the document free
  delete process.env.X402_PAY_TO;
  await check("unconfigured document", "/api/agent", {}, "serve");
  await check("unconfigured tokens", "/api/agent/tokens", {}, "503");
  // 2. configured on Arc testnet with a throwaway key
  const seller = Wallet.createRandom();
  process.env.X402_PAY_TO = seller.address;
  process.env.X402_SELLER_KEY = seller.privateKey;
  process.env.X402_NETWORKS = "eip155:5042002";
  const r402 = await check("configured tokens, no payment", "/api/agent/tokens?limit=2", {}, "402");
  const req = dec(r402.headers["payment-required"]);
  if (req.accepts[0].payTo !== seller.address || req.accepts[0].amount !== "1000") console.log("FAIL 402 shape", req.accepts[0]);
  else console.log("ok    402 advertises " + req.accepts[0].amount + " units on " + req.accepts[0].network + " to payTo");
  if (!req.extensions?.bazaar?.info?.input?.queryParams?.limit) console.log("FAIL bazaar input missing");
  // 3. every way a payment header can be wrong
  await check("garbage header", "/api/agent/tokens", { "payment-signature": "%%%" }, "402 PAYMENT-SIGNATURE is not base64");
  const buyer = Wallet.createRandom();
  const good = await signFor(req.accepts[0], buyer.privateKey);
  const bad = (mut) => enc(mut(JSON.parse(JSON.stringify(good))));
  await check("wrong payTo", "/api/agent/tokens", { "payment-signature": bad((p) => { p.accepted.payTo = buyer.address; return p; }) }, "402 payment does not match");
  await check("wrong network", "/api/agent/tokens", { "payment-signature": bad((p) => { p.accepted.network = "eip155:8453"; return p; }) }, "402 payment does not match");
  await check("underpaid", "/api/agent/tokens", { "payment-signature": bad((p) => { p.payload.authorization.value = "999"; return p; }) }, "402 authorization value below");
  await check("expired", "/api/agent/tokens", { "payment-signature": bad((p) => { p.payload.authorization.validBefore = "1"; return p; }) }, "402 authorization expired");
  await check("to someone else", "/api/agent/tokens", { "payment-signature": bad((p) => { p.payload.authorization.to = buyer.address; return p; }) }, "402 authorization.to is not payTo");
  // 4. a well-formed payment reaches the facilitator; with no USDC behind it the facilitator
  //    refuses, which comes back as a 402 "payment refused", or 503 if it cannot be reached
  const r = await check("well-formed (unfunded buyer) -> facilitator", "/api/agent/tokens", { "payment-signature": enc(good) }, "");
  console.log("      facilitator said: " + r.statusCode + " " + (r.body && r.body.error));
  await check("replayed nonce", "/api/agent/tokens", { "payment-signature": enc(good) }, "402 authorization already used");
}

(flag("--local") ? local() : remote()).catch((e) => { console.error(e); process.exit(1); });
