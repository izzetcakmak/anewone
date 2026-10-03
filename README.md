# 🕹 A NEW ONE: anewone.xyz

**Real assets. Launched on a new one.**

The launch and distribution front end for real-world assets on **Arc Network**, Circle's stablecoin L1 where gas
is paid in USDC. Funds and credit on Centrifuge rails, stocks from licensed issuers, and, live today, USDC that
earns and USDC you can borrow on Morpho through Circle's Earn and Borrow kits (`docs/earn/`). The issuer is always
a regulated entity; A NEW ONE never issues, never custodies and never advises. It is the interface.

The memecoin launchpad the project started as lives on as **AnewOne.Fun** (`docs/fun/`): coins launch on a USDC
bonding curve and graduate into a Uniswap v3 pool whose liquidity nobody can withdraw. Everything below about the
curve, the floor and $NOAH is about that side of the house.

**First coin on the platform: [$NOAH, Noah's Ark](docs/meta/noah.json).** On chain its name reads "Noah's Arc",
on purpose: it was the first coin to launch on Arc's public mainnet, and the name tips its hat to the chain it
boards. Everyone's boarding the Arc. Two by two. 🦒🦒

## At a glance

| | A NEW ONE |
|---|---|
| Launching | Free, gas only. 1B fixed supply, no mint function. Optional dev buy in the same transaction. |
| Pricing | USDC, Arc's native gas token, so prices mean something |
| Trade fee | 1.5%: 0.5% to the token's creator, 1% to the platform, split evenly between its owners |
| Sniping | Anti-snipe: at most 2% of supply per wallet for the first 20 blocks, creator included. Per wallet, so it slows a multi-wallet snipe rather than preventing it |
| Graduation | At 5,000 USDC raised the curve moves into a Uniswap v3 pool at the price it ended on |
| Liquidity | The pool position stays in the platform contract forever; there is no function that can withdraw it |
| Sign-in | Any browser wallet (MetaMask, OKX, Rabby), WalletConnect to a wallet app from a phone or by QR, or Continue with Email or Social (Google, X, Discord, Apple, email code) for a non-custodial wallet |
| Deck Hand | `/chat/`: an assistant over the live floor that remembers you across sessions and devices, memory Seal-encrypted on Walrus mainnet via [MemWal](https://github.com/MystenLabs/MemWal); model Qwen3.8 27B on Groq |

## How it works

**The curve.** Every coin trades from its first block on its own constant-product bonding curve against a
virtual 4,000 USDC reserve. Buy or sell any time; the contract is the market maker. Token images live in the
`TokenImage` launch event rather than in storage, so a launch with a full-size image costs about 2M gas
instead of 20M+.

**Fees.** Every trade pays 1.5%. The creator's 0.5% is collected with `claimCreatorFees()` within 7 days of the
pot starting to accrue; unclaimed pots expire into platform fees (`sweepExpired` is permissionless). The
platform's 1% is credited to the owners in equal shares as it accrues, and each owner withdraws only their
own with `withdrawPlatformFees(to)`; an owner holding a balance cannot be removed until it is withdrawn.
Withdrawing is the only thing an owner can do. Adding and removing owners, opening migrations and reopening
curves belong to the `admin`: the wallet that deployed the platform, fixed for good with no way to hand it over.

**Graduation.** The buy that crosses 5,000 USDC raised goes through, then the curve closes. `migrate(token)`,
which anyone can call once migrations are open, opens a Uniswap v3 pool (1% fee tier, full range) at the
curve's last price with the raised USDC and as many tokens as that USDC pairs with; the rest of the unsold
supply is burned. In the pool the USDC side of the fees keeps paying creator and platform, and the token side
is burned.

**Uniswap never holds up a launch.** The Uniswap v3 addresses are fixed at deploy with no setter. Migrations
open only once Uniswap checks out at those addresses: code present, the 1% fee tier, the position manager
belonging to the factory, and the factory byte for byte the build Uniswap published. If a move cannot happen,
the admin may put a graduated coin back on its curve after an hour; that moves no funds and changes no price.
The full runbook is in [MIGRATION.md](MIGRATION.md).

## Safety

- The site never asks for a seed phrase, private key or password. Every transaction is shown and approved in
  the user's own wallet.
- The launchpad is static: no accounts, no trackers. The server functions in `api/` (RPC relay, Deck Hand, card
  onramp, LI.FI proxy) each do one thing and are described on the [privacy page](https://anewone.xyz/privacy.html);
  see also the [terms](https://anewone.xyz/terms.html).
- Creator links must be https; X and Telegram links are restricted to their own domains. Names, descriptions
  and comments are escaped, and images are raster only (no SVG).
- Security contact: [security.txt](https://anewone.xyz/.well-known/security.txt).
- 87 forge tests, including migrations against Uniswap's published v3 bytecode, invariant campaigns, and a
  rehearsal on a fork of Arc mainnet against the live platform and Uniswap's own deployment
  (`test/ANewOneMainnetFork.t.sol`, see [MIGRATION.md](MIGRATION.md)). No external audit yet.

## Selling to agents (x402)

The index API has a second door, `/api/agent` (a rewrite onto the same function, so it costs no extra
serverless function), which serves the very same answers as `/api/basedbot`
priced per call in USDC under the [x402 protocol](https://developers.circle.com/x402-facilitators/x402)
(v2) and settled by Circle's Facilitator Service on Arc mainnet. An agent calls a priced endpoint,
gets a `402` with the accepted options (`PAYMENT-REQUIRED` header), signs an EIP-3009 USDC
authorization for one of them and retries with it in `PAYMENT-SIGNATURE`; the answer carries the
settlement in `PAYMENT-RESPONSE`. The Circle CLI does all of it:
`circle services pay "https://anewone.xyz/api/agent/tokens" -X GET --chain ARC`. The document at
`/api/agent` and the [OpenAPI spec](https://anewone.xyz/openapi.yaml) are free; the list, a coin, the
tape and the distribution cost $0.001 a call and candles $0.002 (`X402_PRICES` overrides).

`api/_x402.js` is the paywall: it advertises the price, checks the buyer's payload against it,
refuses a replayed authorization, submits the rest to the facilitator's `/settle`, and serves only on
terminal success, never from a cache. It authenticates to the facilitator with `CIRCLE_API_KEY`, or
on the keyless trial with a seller proof signed by `X402_SELLER_KEY`, the key of the payout wallet
`X402_PAY_TO` (a wallet of its own, holding nothing but the fees). Until `X402_PAY_TO` is set the priced
endpoints answer 503 and point at the free index. `node monitor/x402-smoke.mjs --local` runs the
handshake in-process; `--pay` with `BUYER_KEY` pays a real call (rehearse on Arc testnet first).
Listing in [Circle's Agent Marketplace](https://agents.circle.com/services) is by intake form, reviewed by
hand, with the payout wallet sanctions-screened; Gateway nanopayments (gasless, sub-cent) are the step
after that.

## Deployments

| Network | Platform | $NOAH |
|---|---|---|
| Arc Testnet (5042002) | `0x99Bd23c2DD814055a4A2438912C6b4eD2Ae9Ebcf` | `0x0D1ac2a7FCdd8bF74EEC839DF4ED909071296a49` |
| Arc Mainnet (5042), live since 16 Sep 2026 | `0x3DDA5AD5E74c658aff3d082AFe404a71615B1bc5` | `0x26Cc2b608Df6be8fF63C64C9464b2756cC5dc128` |

On Arc mainnet the platform points at Uniswap's official v3 deployment: factory
`0xf0db7b58379503491d857dB50AC9ece64c653918`, position manager `0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377`.

## Repository layout

- `src/ANewOne.sol`: the platform and a minimal ERC-20. Uses OpenZeppelin's `Math` and `SafeCast`, vendored in
  `lib/openzeppelin-contracts`. Owners share the platform fees and can only withdraw their own share; the
  `admin` (the deployer) alone adds and removes them (`addOwner` / `removeOwner`; the last owner cannot be removed).
- `script/Deploy.s.sol`: deploys the platform and launches $NOAH with its dev buy in the same transaction.
- `script/DeployUniswapV3.s.sol`: stands up Uniswap v3 from its npm bytecode for testnet and anvil rehearsals.
- `test/`: the forge test suite and the Uniswap v3 fixtures (provenance in `test/fixtures/uniswap-v3/PROVENANCE.md`).
- `docs/`: the static site, deployed by Vercel on every push: the app, docs, the ark, the Boarding Pass,
  Swap & Bridge (`bridge/`), Deck Hand (`chat/`), privacy and terms. Every page shares one look through two files:
  `docs/shell.css` (the colours, the bar, the hero, the glass pills, the Deck Hand widget; its classes are prefixed `nx-`
  and it loads after a page's own `<style>`) and `docs/shell.js` (the sky and arch under each hero, the bar, the theme
  switch, and the Deck Hand launcher and inline chat). The home page `docs/index.html` is the wallet-free front door.
- `api/`: Vercel functions. `chat.js` is Deck Hand: verifies the wallet signature, recalls from and remembers to
  Walrus Memory under a per-wallet namespace, reads the floor index for live Arc data and answers with an
  OpenAI-compatible model; its `mode: "site"` is the anonymous assistant on the home page and in the corner of every page
  (no memory, answers about the whole site, suggested questions cached, a daily allowance per visitor and for the site:
  `CHAT_SITE_DAY_IP`, `CHAT_SITE_DAY_ALL`; `LLM_MODEL_SITE` gives it its own model, `openai/gpt-oss-20b` in production:
  Groq meters tokens per model, so the home page's questions never draw on the memory chat's allowance, and a full
  prompt is about 1,800 input tokens against the free plan's 8,000 a minute and 200,000 a day for each model). `rpc.js` relays reads for browsers that block `*.arc.io`; `lifi/` proxies Swap & Bridge quotes.
- `monitor/`: the jobs behind the launch, run every minute by Windows Task Scheduler (`AnewoneMainnetScan`):
  - `scan.mjs` finds Arc mainnet, bridges USDC, deploys, confirms the launch on chain and flips `docs/config.js`
  - `bridge.mjs` moves 10 USDC from Base to Arc with CCTP V2 and Circle's Forwarding Service
  - `migrate.mjs` opens migrations once Uniswap checks out and moves every graduated coin
  - `private-rpc.mjs` lets an optional `ARC_MAINNET_RPC` carry the launch transactions; `--check` tests it
  - `snapshot.mjs` builds the Boarding Pass leaderboard, `floor.mjs` the prebuilt front-page index,
    `ark-card.mjs` the ark's share image
  - `chat-smoke.mjs` exercises `api/chat.js` locally, `--signed` for a full remember-then-recall round trip
- `MIGRATION.md`: the mainnet runbook for Uniswap v3 migrations.

## Dev

```bash
forge test
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast   # needs PRIVATE_KEY in .env (see .env.example)
node monitor/scan.mjs                                                # one scan pass
node monitor/migrate.mjs --rpc <url> --platform <address>            # read-only migration status
node monitor/private-rpc.mjs --check                                 # is ARC_MAINNET_RPC usable?
npm install && node monitor/chat-smoke.mjs --signed                  # Deck Hand end to end (needs MEMWAL_* and LLM_API_KEY in .env)
```

## License

[MIT](LICENSE). Use it, change it, ship it; keep the copyright notice. Vendored dependencies keep their own
licenses: `lib/forge-std` is Apache-2.0 or MIT, the `lib/openzeppelin-contracts` subset is MIT, and the Uniswap v3 build in
`test/fixtures/uniswap-v3` is Uniswap's own published artifact (GPL-2.0-or-later), used only in tests.

Built on [Arc Network](https://www.arc.network). This project follows the
[Arc brand guidelines](https://www.arc.io/brand-guidelines-and-partner-toolkit): text-only "Built on Arc"
references, no Arc logo usage, no "Arc" in the product name.
