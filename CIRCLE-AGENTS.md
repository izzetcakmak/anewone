# Circle Agent Stack × A NEW ONE

Notes on [Circle for Agents](https://agents.circle.com/) (announced May 2026) and what it
means for this project. A NEW ONE already lives on Arc — Circle's stablecoin L1 where gas
*is* USDC — so the Agent Stack is effectively native tooling for our chain: it gives AI
agents wallets, spending guardrails, and a payment protocol, all denominated in the same
USDC our bonding curves price in.

## What Circle shipped

Four products, live at [agents.circle.com](https://agents.circle.com/):

### 1. Circle CLI

A single command-line interface over Circle's platform — wallets, transfers, swaps,
CCTP bridging, smart-contract execution, and x402 service discovery/payment — designed
so an agent can operate it from a terminal without bespoke API integration.

- Installs from npm (Node.js ≥ 20.18.2)
- Supports **Agent Wallets** (email-OTP auth, policy enforcement) and **local wallets**
  (imported private key / mnemonic, stored per the Open Wallet Standard)
- Agent-driven setup: `curl -sL https://agents.circle.com/skills/setup.md` and follow
  the instructions
- Docs: <https://developers.circle.com/agent-stack/circle-cli>

### 2. Agent Wallets

Permissionless, policy-controlled wallets built for machine-initiated operation:

- **Custody**: built on Circle's user-controlled wallets with 2-of-2 MPC key management.
  Key shares are never exposed to the agent; the human retains custody and Circle cannot
  unilaterally move funds.
- **Policies**: time-bound USDC spending limits (e.g. daily/monthly) for outbound
  transfers and x402 payments, plus allowlists/blocklists for wallet **and contract**
  addresses.
- All transfers are sanctions-screened before onchain submission.
- Docs: <https://developers.circle.com/agent-stack/agent-wallets>

### 3. Agent Marketplace

A curated, machine-readable directory of agentic services at
[agents.circle.com/services](https://agents.circle.com/services). Listings carry pricing,
capabilities, and invocation methods so agents can discover, evaluate, and pay for
services programmatically (x402). Circle ships npm middleware that lets a provider price
any HTTP route and let the gateway handle payment — an endpoint becomes revenue with no
signup flow.

### 4. Nanopayments (powered by Circle Gateway)

Gas-free USDC transfers down to **$0.000001**, built for high-frequency
machine-to-machine flows. Live on mainnet across 11 chains; **Arc testnet is supported**,
and Circle's reference implementation settles on Arc.

How it works:

1. Buyer deposits USDC into a Gateway Wallet contract once (the only onchain step).
2. Each payment is an offchain EIP-3009 authorization — zero gas.
3. Gateway verifies and deducts within hundreds of milliseconds, so the seller can
   deliver immediately, then settles net positions onchain in batches.
4. Sellers withdraw accumulated USDC to any supported chain (including Arc testnet) via
   a single cross-chain call.

This is what makes sub-cent **x402** payments (the open standard built on HTTP
`402 Payment Required`) economically viable.

- Docs: <https://developers.circle.com/gateway/nanopayments>
- Arc sample app: <https://github.com/circlefin/arc-nanopayments>

## Why this matters for A NEW ONE

Our platform contract is unusually agent-friendly by construction: the contract *is* the
AMM (no LP, no router, no migration), buys are `payable` in Arc's native USDC, and every
quote is a view call. An agent needs exactly one contract address to trade the whole floor.

**Agents as traders.** A user gives their agent an Agent Wallet, allowlists the A NEW ONE
platform contract (`0x30c941ed26088DED6c5D4F1571a49f74478DCc84` on Arc testnet), and sets
a daily USDC cap. The agent can then:

- read `tokensCount()` / `priceWad(token)` / `progressBps(token)` to scan the floor,
- price entries with `quoteBuy(token, usdcIn)` / `quoteSell(token, amount)`,
- trade via `buy(token, minTokensOut)` (sending native USDC) and
  `sell(token, amount, minUsdcOut)`.

The wallet policy layer gives the human hard guardrails the contract can't: even a
misbehaving agent can't exceed its spend limit or touch a non-allowlisted contract. Our
anti-snipe rule (2% max per wallet for the first 20 blocks) applies to agents like anyone
else — a fleet of agent wallets is exactly the sniping pattern it was built to blunt.

**Agents as creators.** `createToken(name, symbol, metadataURI)` is free (gas only) with
an optional dev-buy, so an agent can launch tokens autonomously — and since half of the 1%
trade fee accrues to the creator, an agent that launches a token has an income stream it
can claim with `claimCreatorFees()` (within the 7-day window) into its own wallet.

**A NEW ONE as a marketplace service.** The natural x402 product is a paid data API over
the launchpad — curve stats, graduation feed, new-launch webhooks, comment streams —
priced per-call at sub-cent rates via Nanopayments and listed on Agent Marketplace.
Trading agents are the ideal customers, and Circle's route-pricing middleware means no
account system on our side.

## Possible next steps

- [ ] Try Circle CLI against Arc testnet: create an Agent Wallet, allowlist the platform
      contract, execute a policy-capped `buy` on $NOAH
- [x] Prototype an x402-priced endpoint returning live curve stats — done: `api/server.mjs`
      (zero-dep, `GET /floor` at $0.001 and `GET /token/{address}` at $0.0005, with
      `MOCK_CHAIN`/`MOCK_FACILITATOR` dev modes; `api/agent-demo.mjs` demos the full
      402 → pay → 200 loop)
- [ ] Point `FACILITATOR_URL` at Circle's Nanopayments facilitator and take a real
      Gateway-settled payment on Arc testnet (needs the facilitator endpoint + asset id
      from the [Nanopayments docs](https://developers.circle.com/gateway/nanopayments))
- [ ] List the endpoint on Agent Marketplace once it settles real payments
- [ ] Watch for Nanopayments Arc **mainnet** support — same trigger as our own
      `monitor/scan.mjs` mainnet watch

## Sources

- [Circle for Agents](https://agents.circle.com/)
- [Circle Launches AI Infrastructure to Power the Agentic Economy (press release, Businesswire)](https://www.businesswire.com/news/home/20260511078086/en/Circle-Launches-AI-Infrastructure-to-Power-the-Agentic-Economy)
- [Agent Stack: Financial Infrastructure for the Agentic Economy (Circle blog)](https://www.circle.com/blog/introducing-circle-agent-stack-financial-infrastructure-for-the-agentic-economy)
- [Circle Agent Stack product page](https://www.circle.com/agent-stack)
- [Circle CLI docs](https://developers.circle.com/agent-stack/circle-cli)
- [Agent Wallets docs](https://developers.circle.com/agent-stack/agent-wallets)
- [Nanopayments docs](https://developers.circle.com/gateway/nanopayments)
- [Nanopayments powered by Circle Gateway is live on mainnet (Circle blog)](https://www.circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet)
- [How to Build Agentic AI Payments Systems on Arc (Circle blog)](https://www.circle.com/blog/build-agentic-systems-for-high-frequency-sub-cent-transactions)
- [circlefin/arc-nanopayments sample](https://github.com/circlefin/arc-nanopayments)
- [What Nanopayments changes for Arc builders (Arc community)](https://community.arc.io/public/clubs/agentic-economy-dofua/blogs/what-nanopayments-powered-by-circle-gateway-changes-for-arc-builders-2026-04-29)
