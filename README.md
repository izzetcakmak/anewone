# 🕹 A NEW ONE: anewone.xyz

**Real assets. Launched on a new one.**

The launch and distribution front end for real-world assets on **Arc Network**, Circle's stablecoin L1 where gas
is paid in USDC. Funds and credit on Centrifuge rails and Circle's USYC (`docs/assets/`), stocks from licensed
issuers, and, live today, USDC that earns and USDC you can borrow on Aave V4 and on Morpho (`docs/earn/`). The issuer is always a regulated entity;
A NEW ONE never issues, never custodies and never advises. It is the interface.

The memecoin launchpad the project started as lives on as **AnewOne.Fun** (`docs/fun/`): coins launch on a USDC
bonding curve and graduate into a Uniswap v3 pool whose liquidity nobody can withdraw. Everything below about the
curve, the floor and $NOAH is about that side of the house.

**First coin on the platform: [$NOAH, Noah's Ark](docs/meta/noah.json).** On chain its name reads "Noah's Arc",
on purpose: it was the first coin to launch on Arc's public mainnet, and the name tips its hat to the chain it
boards. Everyone's boarding the Arc. Two by two. 🦒🦒

## Earn & Borrow

`docs/earn/` puts two lending protocols on one page, each action signed from the user's own wallet.

- **Aave V4** (`docs/earn/aave.js`, first on both tabs). Earn supplies USDC or EURC to Aave's Main market. Borrow
  offers two Aave markets, each a separate account with its own health factor: the **Main** market (USDC or EURC
  against cirBTC or WETH) and the **Forex** market, shown as *Currency loans* (EURC against USDC or USDC against EURC,
  up to 90%). Every action (approve, supply, enable collateral, borrow, repay, withdraw) is one transaction through
  Arc's sender-preserving batcher, Multicall3From `0x522fAf9A91c41c443c66765030741e4AaCe147D0`, and is simulated with
  `eth_estimateGas` before the wallet opens. The page refuses a borrow or withdrawal that would leave the health
  factor under 1.15, and "available to borrow" is the hub's free cash within the spoke's draw cap. Market and
  position reads go through Multicall3 (three `eth_call`s for both markets).
- **Morpho**, through Circle's Earn and Borrow kits: curated vaults on Earn, markets on Borrow. A vault deposit is
  simulated first, so a vault whose curator caps refuse it says so before the wallet opens; vaults with no named
  curator, test deployments, vaults Circle flags and vaults holding under 1,000 sit under *Show unlisted*.
- **Your deposits** lists every Morpho and Aave deposit of the connected wallet at the top of the page.
- **Fees.** Supplying, withdrawing and repaying are free on both. A new Morpho loan carries a 0.15% origination fee
  through Circle's kit (90% to the site, 10% to Arc). Each amount borrowed on Aave through the site carries a 0.15%
  interface fee, a token transfer to `aave.feeTo` in `docs/config.js` inside the same batch, shown in the quote;
  an empty `feeTo` turns it off, and the code caps it at 1%.

Aave V4 on Arc (from [bgd-labs/aave-address-book](https://github.com/bgd-labs/aave-address-book), checked on chain):
Core hub `0x17288dfc86205301064577b98B02b81017e6F79C`, Main spoke `0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d`,
Forex spoke `0x4164EBCAF74670aa74C8D4F59de6157c0780F1bB`.

## Funds and stocks

`docs/assets/` lists four tokenized funds live on Arc, each card reading its price from the chain: **JTRSY**, **JAAA**
and **HYB** (Janus Henderson and NYLIM, issued by Anemoy on Centrifuge rails, for non-US professional investors) and
**USYC** (Circle's own money market fund, for institutions outside the United States). The issuer runs KYC and
whitelists the wallet; the page cannot skip that. Centrifuge funds are bought with a deposit request and claimed once
the issuer fills it (the cross-chain message fee is shown in the quote); USYC is minted and burned against USDC at
once by the issuer's Teller. A connected wallet sees its own shares at NAV, pending orders and fills to claim at the
top. A NEW ONE takes no fee on any of them. `docs/assets/stocks/` lists the xStocks catalog (Backed, a Kraken
company) with live prices; the page checks the chain and turns each card live when Backed's token has code on Arc.
`api/xstocks.js` and `api/usyc.js` relay the two public feeds that send no CORS headers.

## Portfolio

`docs/portfolio/` is one read-only page for a wallet (the connected one, or any pasted Arc address): stablecoins,
Aave and Morpho deposits and loans, fund shares and AnewOne.Fun coins, valued in USD, with alerts for a health factor
nearing 1.0 or a wallet with no USDC for gas. It asks for no signature; every action opens on the page it belongs to.

## Swap & Bridge

`docs/bridge/` brings money onto Arc as USDC from Base, Ethereum, Arbitrum, OP Mainnet, Polygon, Avalanche, Unichain, Linea, World Chain, Sonic, Monad, Sei, HyperEVM, Ink, Solana and Sui, with no gas needed on Arc: USDC over
Circle's CCTP V2 and its Forwarding Service, anything else swapped into USDC by LI.FI on the way (the EVM and
Solana routing lives in [gangway-kit](https://github.com/izzetcakmak/gangway-kit)). From **Solana**, SOL or any Solana token is one
LI.FI route signed in Phantom, Solflare or Backpack (Wallet Standard). From **Sui**, USDC crosses on CCTP signed in
Slush, Phantom or Suiet; other Sui tokens are swapped into USDC first. A non-USDC payment carries a 0.25% fee to the
site, shown in the quote.

The home page carries a *Swap on Arc* card that prices a trade from 24h prices and opens this page for the exact
route, beside Arc's busiest tokens by 24h volume (GeckoTerminal, restricted to tokens LI.FI routes, $NOAH pinned).

**EURC and cirBTC** arrive as themselves through Circle Gateway (Unified Balance Kit, `docs/vendor/gateway-kit.js`):
a deposit into the wallet's Gateway balance on Base, Avalanche, World Chain or Ethereum, then one EIP-712 signature
spends it to Arc, where Circle's forwarder mints it (no gas on Arc). The same 0.25% fee goes in as the kit's custom
fee, but only when the extra burn intents it needs cost under a fifth of it; the quote is estimated both ways.

## AnewOne.Fun at a glance

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

## The weekly program and partner links

Every Sunday at 09:00 UTC a week closes, and prize weeks and **$NOAH buyback weeks** take turns, starting 25 Oct 2026
(`monitor/week.mjs` builds the board). In a prize week the 10 wallets with the most trading volume enter a live draw
and 3 win USDC, a pot of 0.5% of the week's volume paid from the platform's own share of the fees; in a buyback week
the same 0.5% buys $NOAH, which is burned only once $NOAH has graduated. Both are platform decisions, not contract
rules, announced in the docs before they change. The community vote that shaped them (22 to 24 Oct, 46 votes) is
recorded in the docs.

A partner app links its users to `fun/?launch=1&ref=<code>`. A code on the short list in `docs/fun/index.html` is
written into the coin's metadata by the launch transaction, so which coins came through a partner is public on Arc and
`monitor/partner-report.mjs` computes the platform fee they earned from the chain alone. Nothing changes for the
creator or the fees they pay.

## How the launchpad works

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
- The site is static: no accounts and no cookies. Visits are counted with Plausible (cookieless, no profile). The
  server functions in `api/` (RPC relay, Deck Hand, card onramp, LI.FI proxy, Morpho loan fee proxy, price relays,
  the agent API) each do one thing and are described on the [privacy page](https://anewone.xyz/privacy.html);
  see also the [terms](https://anewone.xyz/terms.html).
- Creator links must be https; X and Telegram links are restricted to their own domains. Names, descriptions
  and comments are escaped, and images are raster only (no SVG).
- Security contact: [security.txt](https://anewone.xyz/.well-known/security.txt).
- 87 forge tests, including migrations against Uniswap's published v3 bytecode, invariant campaigns, and a
  rehearsal on a fork of Arc mainnet against the live platform and Uniswap's own deployment
  (`test/ANewOneMainnetFork.t.sol`, see [MIGRATION.md](MIGRATION.md)). No external audit yet.

## Selling to agents (x402)

The index API (`/api/basedbot`, free, 240 requests a minute per IP) has a second door, `/api/agent` (a rewrite onto the same function, so it costs no extra
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
- `docs/`: the static site, deployed by Vercel on every push: Earn & Borrow (`earn/`, with the Aave V4 module
  `earn/aave.js`), real-world assets (`assets/`), the launchpad (`fun/`), docs, the ark, the Boarding Pass,
  Swap & Bridge (`bridge/`), Portfolio (`portfolio/`), Deck Hand (`chat/`), privacy and terms. Every page shares one look through two files:
  `docs/shell.css` (the colours, the bar, the hero, the glass pills, the Deck Hand widget; its classes are prefixed `nx-`
  and it loads after a page's own `<style>`) and `docs/shell.js` (the sky and arch under each hero, the bar, the theme
  switch, and the Deck Hand launcher and inline chat). The home page `docs/index.html` is the wallet-free front door.
- `api/`: Vercel functions. `chat.js` is Deck Hand: verifies the wallet signature, recalls from and remembers to
  Walrus Memory under a per-wallet namespace, reads the floor index for live Arc data and answers with an
  OpenAI-compatible model; its `mode: "site"` is the anonymous assistant on the home page and in the corner of every page
  (no memory, answers about the whole site, suggested questions cached, a daily allowance per visitor and for the site:
  `CHAT_SITE_DAY_IP`, `CHAT_SITE_DAY_ALL`; `LLM_MODEL_SITE` can give it its own model; production runs it on `LLM_MODEL` since 19 Oct 2026, because
  `openai/gpt-oss-20b` mixed up the Aave markets and fees. Groq meters tokens per model, so both modes now share one
  allowance, and a site question is about 2,400 input tokens plus up to 900 out against the free plan's 8,000 a minute
  and 200,000 a day for each model). `rpc.js` relays reads for browsers that block `*.arc.io`; `lifi/` proxies Swap & Bridge quotes.
- `monitor/`: the jobs behind the launch, run every minute by Windows Task Scheduler (`AnewoneMainnetScan`):
  - `scan.mjs` finds Arc mainnet, bridges USDC, deploys, confirms the launch on chain and flips `docs/config.js`
  - `bridge.mjs` moves 10 USDC from Base to Arc with CCTP V2 and Circle's Forwarding Service
  - `migrate.mjs` opens migrations once Uniswap checks out and moves every graduated coin
  - `private-rpc.mjs` lets an optional `ARC_MAINNET_RPC` carry the launch transactions; `--check` tests it
  - `snapshot.mjs` builds the Boarding Pass leaderboard, `floor.mjs` the prebuilt front-page index,
    `ark-card.mjs` the ark's share image
  - `week.mjs` builds the weekly prize and buyback board, `partner-report.mjs` the partner fee report,
    `traction.mjs` a one-off traction report
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
