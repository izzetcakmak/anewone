#!/usr/bin/env node
/**
 * Demo "agent" for the ANEWONE x402 API — walks the full 402 payment loop:
 *
 *   GET url            -> 402 + accepts[] payment terms
 *   build EIP-3009 authorization for accepts[0], base64 it into X-PAYMENT
 *   GET url again      -> 200 + data + X-PAYMENT-RESPONSE settlement receipt
 *
 * The authorization here carries a placeholder signature, which the MOCK
 * facilitator accepts — this demos the protocol, not custody. For real
 * payments use a real x402 client (Circle CLI's agent wallet, or x402-fetch
 * with a funded key): they produce the same header, properly signed.
 *
 *   node api/agent-demo.mjs [url]        (default http://127.0.0.1:8402/floor)
 */
import { randomBytes } from "node:crypto";

const url = process.argv[2] || "http://127.0.0.1:8402/floor";
const show = (o) => JSON.stringify(o, null, 2);

console.log(`agent → GET ${url} (no payment)`);
const first = await fetch(url);
if (first.status !== 402) {
  console.log(`← ${first.status} (route is free or already paid)\n${show(await first.json())}`);
  process.exit(0);
}
const terms = await first.json();
const req = terms.accepts?.[0];
if (!req) throw new Error(`402 without payment terms:\n${show(terms)}`);
console.log(`← 402 Payment Required: $${Number(req.maxAmountRequired) / 1e6} USDC on ${req.network}`);
console.log(`   payTo ${req.payTo} | "${req.description}"`);

const payment = {
  x402Version: 1,
  scheme: req.scheme,
  network: req.network,
  payload: {
    signature: "0x" + "ee".repeat(65), // placeholder — real clients sign EIP-3009 here
    authorization: {
      from: "0x00000000000000000000000000000000a6e47000", // demo agent wallet
      to: req.payTo,
      value: req.maxAmountRequired,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds),
      nonce: "0x" + randomBytes(32).toString("hex"),
    },
  },
};

console.log(`agent → GET ${url} (X-PAYMENT attached)`);
const paid = await fetch(url, {
  headers: { "X-PAYMENT": Buffer.from(JSON.stringify(payment)).toString("base64") },
});
const body = await paid.json();
const receiptB64 = paid.headers.get("x-payment-response");
const receipt = receiptB64 ? JSON.parse(Buffer.from(receiptB64, "base64").toString("utf8")) : null;

console.log(`← ${paid.status}`);
if (receipt) console.log(`   settlement: ${receipt.success ? `✓ tx ${receipt.transaction}` : `✗ ${receipt.error || receipt.errorReason}`}`);
console.log(show(body));
