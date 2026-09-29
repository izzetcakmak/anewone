#!/usr/bin/env node
// Dinari sandbox, end to end, with nothing needed beyond a sandbox API key: a throwaway wallet
// becomes a KYC'd customer, links itself to Dinari by signature, draws 1,000 mockUSD from the
// faucet and buys a few dollars of a dShare through a proxied (gasless) order. It is the same
// flow api/_dinari.js runs for a visitor, minus the browser, so every step prints what Dinari
// actually answered: the response shapes the site relies on, the permit above all, get checked
// against reality here before a visitor meets them.
//
//   node monitor/dinari-smoke.mjs                 # every step, continuing from the state file
//   node monitor/dinari-smoke.mjs --only buy      # one step: stocks entity kyc account wallet faucet buy status portfolio
//   node monitor/dinari-smoke.mjs --country TR    # does the sandbox take a Turkish resident? (default SG, Dinari's own example)
//   node monitor/dinari-smoke.mjs --fresh         # forget the state file and start over with a new wallet
//
// Reads .env: DINARI_API_KEY_ID and DINARI_API_SECRET_KEY (sandbox keys from partners.dinari.com),
// optionally DINARI_CHAIN (default eip155:421614, Arbitrum Sepolia, where the sandbox faucet
// mints) and DINARI_SMOKE_PRIVATE_KEY (else a random wallet, kept in the state file).
// Nothing here touches production: the client is pinned to the sandbox host.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import Dinari from "@dinari/api-sdk";

const MON = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(MON, "dinari-smoke-state.json"); // gitignored: holds a throwaway key
for (const line of fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const STEPS = ["stocks", "entity", "kyc", "account", "wallet", "faucet", "buy", "status", "portfolio"];
const only = arg("--only");
if (only && !STEPS.includes(only)) { console.error("unknown step; one of " + STEPS.join(" ")); process.exit(2); }
const COUNTRY = (arg("--country") || "SG").toUpperCase();
const CHAIN = process.env.DINARI_CHAIN || "eip155:421614";
const USD = Number(arg("--usd") || 10);

if (!process.env.DINARI_API_KEY_ID || !process.env.DINARI_API_SECRET_KEY) {
  console.error("DINARI_API_KEY_ID and DINARI_API_SECRET_KEY are missing from .env (sandbox keys: partners.dinari.com)");
  process.exit(1);
}
const dinari = new Dinari({ apiKeyID: process.env.DINARI_API_KEY_ID, apiSecretKey: process.env.DINARI_API_SECRET_KEY, environment: "sandbox" });

// ---- state: whatever earlier runs created, so a step can be re-run alone
if (process.argv.includes("--fresh") && fs.existsSync(STATE)) fs.unlinkSync(STATE);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
if (!state.privateKey) state.privateKey = process.env.DINARI_SMOKE_PRIVATE_KEY || Wallet.createRandom().privateKey;
const wallet = new Wallet(state.privateKey);
state.address = wallet.address; save();
console.log(`wallet ${wallet.address} · chain ${CHAIN} · sandbox`);

const show = (label, x) => console.log(`\n== ${label}\n` + JSON.stringify(x, null, 1));
const need = (k) => { if (!state[k]) throw new Error(`no ${k} in the state file yet; run the earlier steps first`); return state[k]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Dinari documents the permit only as "typed data to be signed by the wallet". This expects the
 * usual EIP-712 envelope (domain, types, message) and signs it; anything else is printed raw so
 * the shape can be read and this helper fixed, rather than guessed at.
 */
async function signPermit(permit) {
  const td = permit.typedData || permit.typed_data || permit;
  const { domain, types, message } = td;
  if (!domain || !types || !message) throw new Error("permit is not EIP-712 typed data as expected; raw permit:\n" + JSON.stringify(permit, null, 1));
  const t = { ...types }; delete t.EIP712Domain; // ethers derives the domain type itself
  return wallet.signTypedData(domain, t, message);
}

const steps = {
  async stocks() {
    show("market hours", await dinari.v2.marketData.retrieveMarketHours());
    const list = await dinari.v2.marketData.stocks.list({ limit: 200 });
    const tradable = list.data.filter((s) => s.is_tradable);
    console.log(`\n== stocks: ${list.data.length} listed, ${tradable.length} tradable`);
    for (const s of tradable.slice(0, 12)) console.log(`  ${s.symbol.padEnd(6)} ${s.name}  fractional=${s.is_fractionable}  tokens=${(s.tokens || []).join(",") || "-"}`);
    // the buy step wants a fractionable stock, so a market order for a round dollar amount is legal
    const pick = tradable.find((s) => s.is_fractionable && (s.tokens || []).some((t) => t.startsWith(CHAIN + ":"))) || tradable.find((s) => s.is_fractionable) || tradable[0];
    if (pick) { state.stockId = pick.id; state.stockSymbol = pick.symbol; save(); console.log(`picked ${pick.symbol} (${pick.id})`); }
    show(`price of ${pick.symbol}`, await dinari.v2.marketData.stocks.retrieveCurrentPrice(pick.id));
  },
  async entity() {
    // one customer entity per wallet; reference_id is how api/_dinari.js finds it again
    const ref = wallet.address.toLowerCase();
    const found = (await dinari.v2.entities.list({ reference_id: ref })).data?.[0];
    const entity = found || await dinari.v2.entities.create({ name: wallet.address, reference_id: ref });
    state.entityId = entity.id; save();
    show(found ? "entity (existing)" : "entity (created)", entity);
  },
  async kyc() {
    // production: createManagedCheck -> embed_url for the visitor. The sandbox lets anyone
    // submit KYC data directly, which is what makes this script self-contained.
    const entityId = need("entityId");
    let info;
    try {
      info = await dinari.v2.entities.kyc.submit(entityId, {
        jurisdiction: "BASELINE", provider_name: "anewone-smoke",
        data: { first_name: "Ada", last_name: "Lovelace", birth_date: "1990-12-10", email: "smoke@anewone.xyz", country_code: COUNTRY, address_country_code: COUNTRY, address_city: "Test", address_street_1: "1 Test St" },
      });
    } catch (e) {
      console.log(`kyc submit for country ${COUNTRY} failed: ${e.status || ""} ${e.message}`);
      info = await dinari.v2.entities.kyc.retrieve(entityId).catch(() => null);
    }
    show(`kyc (country ${COUNTRY})`, info);
    if (info) { state.kycStatus = info.status; save(); }
  },
  async account() {
    const entityId = need("entityId");
    const found = (await dinari.v2.entities.accounts.list(entityId)).data?.[0];
    const account = found || await dinari.v2.entities.accounts.create(entityId, { jurisdiction: "BASELINE" });
    state.accountId = account.id; save();
    show(found ? "account (existing)" : "account (created)", account);
  },
  async wallet() {
    // prove the wallet: Dinari hands out a message, the wallet signs it (personal_sign)
    const accountId = need("accountId");
    const linked = await dinari.v2.accounts.wallet.get(accountId).catch(() => null);
    if (linked && linked.address.toLowerCase() === wallet.address.toLowerCase()) return show("wallet (already linked)", linked);
    const { message, nonce } = await dinari.v2.accounts.wallet.external.getNonce(accountId, { chain_id: "eip155:0", wallet_address: wallet.address });
    console.log("\n== message to sign\n" + message);
    const signature = await wallet.signMessage(message);
    show("wallet (linked)", await dinari.v2.accounts.wallet.external.connect(accountId, { chain_id: "eip155:0", nonce, signature, wallet_address: wallet.address }));
  },
  async faucet() {
    const accountId = need("accountId");
    await dinari.v2.accounts.mintSandboxTokens(accountId, { chain_id: CHAIN });
    const cash = await dinari.v2.accounts.getCashBalances(accountId);
    show("cash balances", cash);
    const pay = cash.find((b) => b.chain_id === CHAIN);
    if (!pay) throw new Error(`no payment token on ${CHAIN} after the faucet; is DINARI_CHAIN the chain the sandbox mints on?`);
    state.paymentToken = pay.token_address; save();
  },
  async buy() {
    // proxied order: Dinari prepares a permit for the payment token, the wallet signs it,
    // Dinari puts the order on chain and pays the gas out of the payment token
    const accountId = need("accountId"), stockId = need("stockId"), paymentToken = need("paymentToken");
    const prepared = await dinari.v2.accounts.orderRequests.eip155.createPermit(accountId, {
      chain_id: CHAIN, order_side: "BUY", order_type: "MARKET", order_tif: "DAY",
      payment_token: paymentToken, payment_token_quantity: USD, stock_id: stockId, client_order_id: "smoke-" + Date.now(),
    });
    show("permit to sign", prepared);
    const permit_signature = await signPermit(prepared.permit);
    const req = await dinari.v2.accounts.orderRequests.eip155.submit(accountId, { order_request_id: prepared.order_request_id, permit_signature });
    state.orderRequestId = req.id; save();
    show("order request", req);
  },
  async status() {
    const accountId = need("accountId"), id = need("orderRequestId");
    const done = new Set(["SUBMITTED", "ERROR", "CANCELLED", "EXPIRED", "REJECTED"]);
    let req;
    for (let i = 0; i < 20; i++) {
      req = await dinari.v2.accounts.orderRequests.retrieve(id, { account_id: accountId });
      console.log(`order request ${req.status}${req.order_id ? " · order " + req.order_id : ""}`);
      if (done.has(req.status)) break;
      await sleep(3000);
    }
    show("order request", req);
    if (req.order_id) show("order", await dinari.v2.accounts.orders.retrieve(req.order_id, { account_id: accountId }));
  },
  async portfolio() {
    const accountId = need("accountId");
    show("portfolio", await dinari.v2.accounts.getPortfolio(accountId));
    show("cash", await dinari.v2.accounts.getCashBalances(accountId));
  },
};

try {
  for (const s of only ? [only] : STEPS) { console.log(`\n#### ${s}`); await steps[s](); }
} catch (e) {
  // Dinari's errors carry the HTTP status and its JSON body; both are what a fix needs
  console.error("\nfailed:", e.status ? `${e.status} ${e.name}: ` : "", e.message);
  if (e.error) console.error(JSON.stringify(e.error, null, 1));
  process.exit(1);
}
