# 🕹 A NEW ONE — anewone.xyz

**Insert Coin. Launch a New One.**

A pump.fun-style meme token launchpad built on **Arc Network** (Circle's stablecoin L1, gas = USDC) — with quality upgrades pump.fun doesn't have. Every token on the floor is… a new one.

**First token on the platform: [$NOAH — Noah's Arc](docs/meta/noah.json).** Everyone's boarding the Arc. Two by two. 🦒🦒

## Why it's better than pump.fun

| Feature | pump.fun | A NEW ONE |
|---|---|---|
| Trade fee | 1% to platform | 1% — **half goes to the token creator** |
| Sniping | bots eat launches | **anti-snipe: 2% max per wallet for the first 20 blocks** (creator included) |
| Rug vector | LP migration step | **none — curve reserves are locked in the contract forever**, fees are segregated |
| Pricing | SOL | **USDC** (Arc's native gas token) — prices mean something |
| Graduation | forced migration | badge + event at 5,000 USDC raised; trading never halts |

## Mechanics

- 1B supply per token, 100% on a constant-product bonding curve (virtual reserve: 4,000 USDC)
- Buy/sell any time; the contract is the AMM — no LP, no migration, nothing to pull
- Launching a token is free (gas only), optional dev-buy at creation
- Creator claims accrued fees with `claimCreatorFees()` — **within 7 days** of the pot starting
  to accrue; unclaimed pots expire and roll into platform fees (`sweepExpired` is permissionless)

## Deployments

| Network | Platform | $NOAH |
|---|---|---|
| Arc Testnet (5042002) | `0xC83212Af0aE3FF762Df955E571655082AEc45B49` | `0x7BE0b3a50D326c30Fdb75B0806184E3B1D04e595` |
| Arc Mainnet | ⏳ auto-deploys the minute mainnet is detected | ⏳ |



## Layout

- `src/ANewOne.sol` — platform + minimal ERC20 (no external deps), 21/21 forge tests.
  Multiple owners share the platform-fee pool; any owner can `addOwner`/`removeOwner`
  (the last owner cannot be removed). Seed a second owner at deploy via `SECOND_OWNER`.
- `script/Deploy.s.sol` — deploys platform and launches $NOAH
- `docs/` — static retro UI served at anewone.xyz via GitHub Pages, rate-limit-friendly RPC usage
- `monitor/scan.mjs` — runs every minute via Windows Task Scheduler (`AnewoneMainnetScan`):
  probes candidate Arc mainnet RPCs + the chainid.network registry; on detection checks
  deployer gas, auto-deploys, updates `docs/config.js`, and pings Telegram

## Dev

```bash
forge test
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast  # needs PRIVATE_KEY in .env
node monitor/scan.mjs                                               # one scan pass
```

Built on [Arc Network](https://www.arc.network) — this project follows the
[Arc brand guidelines](https://www.arc.io/brand-guidelines-and-partner-toolkit): text-only
"Built on Arc" references, no Arc logo usage, no "Arc" in the product name.
