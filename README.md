# 🕹 A NEW ONE: anewone.xyz

**Insert Coin. Launch a New One.**

A memecoin launchpad on **Arc Network**, Circle's stablecoin L1 where gas is paid in USDC. Coins launch on a
USDC bonding curve and graduate into a Uniswap v3 pool whose liquidity nobody can withdraw. Every token on the
floor is... a new one.

**First coin on the platform: [$NOAH, Noah's Arc](docs/meta/noah.json).** Everyone's boarding the Arc. Two by two. 🦒🦒

## At a glance

| | A NEW ONE |
|---|---|
| Launching | Free, gas only. 1B fixed supply, no mint function. Optional dev buy in the same transaction. |
| Pricing | USDC, Arc's native gas token, so prices mean something |
| Trade fee | 1.5%: 0.5% to the token's creator, 1% to the platform, split evenly between its owners |
| Sniping | Anti-snipe: at most 2% of supply per wallet for the first 20 blocks, creator included |
| Graduation | At 5,000 USDC raised the curve moves into a Uniswap v3 pool at the price it ended on |
| Liquidity | The pool position stays in the platform contract forever; there is no function that can withdraw it |
| Sign-in | Any browser wallet (MetaMask, OKX, Rabby) or Continue with Google for a non-custodial wallet |

## How it works

**The curve.** Every coin trades from its first block on its own constant-product bonding curve against a
virtual 4,000 USDC reserve. Buy or sell any time; the contract is the market maker. Token images live in the
`TokenImage` launch event rather than in storage, so a launch with a full-size image costs about 2M gas
instead of 20M+.

**Fees.** Every trade pays 1.5%. The creator's 0.5% is collected with `claimCreatorFees()` within 7 days of the
pot starting to accrue; unclaimed pots expire into platform fees (`sweepExpired` is permissionless). The
platform's 1% is credited to the owners in equal shares as it accrues, and each owner withdraws only their
own with `withdrawPlatformFees(to)`; an owner holding a balance cannot be removed until it is withdrawn.

**Graduation.** The buy that crosses 5,000 USDC raised goes through, then the curve closes. `migrate(token)`,
which anyone can call once migrations are open, opens a Uniswap v3 pool (1% fee tier, full range) at the
curve's last price with the raised USDC and as many tokens as that USDC pairs with; the rest of the unsold
supply is burned. In the pool the USDC side of the fees keeps paying creator and platform, and the token side
is burned.

**Uniswap never holds up a launch.** The Uniswap v3 addresses are fixed at deploy with no setter. Migrations
open only once Uniswap checks out at those addresses: code present, the 1% fee tier, the position manager
belonging to the factory, and the factory byte for byte the build Uniswap published. If a move cannot happen,
the owners may put a graduated coin back on its curve after an hour; that moves no funds and changes no price.
The full runbook is in [MIGRATION.md](MIGRATION.md).

## Safety

- The site never asks for a seed phrase, private key or password. Every transaction is shown and approved in
  the user's own wallet.
- The site is static: no backend, no accounts, no trackers. See the [privacy page](https://anewone.xyz/privacy.html)
  and the [terms](https://anewone.xyz/terms.html).
- Creator links must be https; X and Telegram links are restricted to their own domains. Names, descriptions
  and comments are escaped, and images are raster only (no SVG).
- Security contact: [security.txt](https://anewone.xyz/.well-known/security.txt).
- 83 forge tests, including migrations against Uniswap's published v3 bytecode and invariant campaigns.

## Deployments

| Network | Platform | $NOAH |
|---|---|---|
| Arc Testnet (5042002) | `0x99Bd23c2DD814055a4A2438912C6b4eD2Ae9Ebcf` | `0x0D1ac2a7FCdd8bF74EEC839DF4ED909071296a49` |
| Arc Mainnet (5042) | Deploys itself the minute mainnet is detected | Launched in the same deployment |

On Arc mainnet the platform points at Uniswap's official v3 deployment: factory
`0xf0db7b58379503491d857dB50AC9ece64c653918`, position manager `0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377`.

## Repository layout

- `src/ANewOne.sol`: the platform and a minimal ERC-20. Uses OpenZeppelin's `Math` and `SafeCast`, vendored in
  `lib/openzeppelin-contracts`. Several owners share the platform fee pool (`addOwner` / `removeOwner`; the
  last owner cannot be removed).
- `script/Deploy.s.sol`: deploys the platform and launches $NOAH with its dev buy in the same transaction.
- `script/DeployUniswapV3.s.sol`: stands up Uniswap v3 from its npm bytecode for testnet and anvil rehearsals.
- `test/`: the forge test suite and the Uniswap v3 fixtures (provenance in `test/fixtures/uniswap-v3/PROVENANCE.md`).
- `docs/`: the static site, deployed by Vercel on every push: the app, docs, the ark, the Boarding Pass,
  privacy and terms.
- `monitor/`: the jobs behind the launch, run every minute by Windows Task Scheduler (`AnewoneMainnetScan`):
  - `scan.mjs` finds Arc mainnet, bridges USDC, deploys, confirms the launch on chain and flips `docs/config.js`
  - `bridge.mjs` moves 10 USDC from Base to Arc with CCTP V2 and Circle's Forwarding Service
  - `migrate.mjs` opens migrations once Uniswap checks out and moves every graduated coin
  - `private-rpc.mjs` lets an optional `ARC_MAINNET_RPC` carry the launch transactions; `--check` tests it
  - `snapshot.mjs` builds the Boarding Pass leaderboard, `floor.mjs` the prebuilt front-page index,
    `ark-card.mjs` the ark's share image
- `MIGRATION.md`: the mainnet runbook for Uniswap v3 migrations.

## Dev

```bash
forge test
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast   # needs PRIVATE_KEY in .env (see .env.example)
node monitor/scan.mjs                                                # one scan pass
node monitor/migrate.mjs --rpc <url> --platform <address>            # read-only migration status
node monitor/private-rpc.mjs --check                                 # is ARC_MAINNET_RPC usable?
```

## License

[MIT](LICENSE). Use it, change it, ship it; keep the copyright notice. Vendored dependencies keep their own
licenses: `lib/forge-std` is Apache-2.0 or MIT, the `lib/openzeppelin-contracts` subset is MIT, and the Uniswap v3 build in
`test/fixtures/uniswap-v3` is Uniswap's own published artifact (GPL-2.0-or-later), used only in tests.

Built on [Arc Network](https://www.arc.network). This project follows the
[Arc brand guidelines](https://www.arc.io/brand-guidelines-and-partner-toolkit): text-only "Built on Arc"
references, no Arc logo usage, no "Arc" in the product name.
