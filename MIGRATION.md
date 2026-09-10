# Opening migrations on Arc mainnet

The platform ships with migrations **closed**. Nothing moves into Uniswap until an owner calls
`setMigrationsOpen(true)`: the scanner does so by itself once the checks in section 4 pass, and
the owner console can do it by hand. Closing again (`setMigrationsOpen(false)`) is always
possible; it holds migrations back, moves no funds, and the scanner does not overrule it.

The deploy never waits for Uniswap. Its addresses are fixed at deploy, but what stands behind
them is only checked when migrations are opened, so the platform and $NOAH launch with the
chain even if Uniswap reaches Arc later. A coin that graduates stops trading on its curve and
waits for its move; until migrations open, the site says trading resumes on Uniswap v3 once it
is live on Arc.

The whole flow was rehearsed on Arc testnet on 10 Sep 2026 against the real USDC precompile,
with Uniswap v3 deployed from its npm bytecode (`script/DeployUniswapV3.s.sol`): both token
orderings migrated at the curve's last price (relative error 4e-11), every wei and every token
accounted for, and the pool's fees split and burned as designed.

```bash
RPC=<Arc mainnet RPC>
PLATFORM=<platform address>
FACTORY=0xf0db7b58379503491d857dB50AC9ece64c653918
NFPM=0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377
USDC=0x3600000000000000000000000000000000000000
```

## 1. The platform points at Uniswap's own deployment

These are immutable, so this only confirms what the deploy script wrote.

```bash
cast call $PLATFORM "v3Factory()(address)" --rpc-url $RPC        # == $FACTORY
cast call $PLATFORM "positionManager()(address)" --rpc-url $RPC  # == $NFPM
cast call $PLATFORM "usdc()(address)" --rpc-url $RPC             # == $USDC
cast call $PLATFORM "migrationsOpen()(bool)" --rpc-url $RPC      # false
```

## 2. The code behind them is Uniswap's published v3

The factory has no immutables, so its runtime code must equal the npm artifact byte for byte.

```bash
cast keccak $(cast code $FACTORY --rpc-url $RPC)
python -c "import json;print(json.load(open('test/fixtures/uniswap-v3/UniswapV3Factory.json'))['deployedBytecode'])" | cast keccak
cast call $NFPM "factory()(address)" --rpc-url $RPC                          # == $FACTORY
cast call $FACTORY "feeAmountTickSpacing(uint24)(int24)" 10000 --rpc-url $RPC # == 200
```

## 3. What the position manager was given as WETH9

Arc has no wrapped native token. If `WETH9()` returns the USDC face itself (`$USDC`), a speck
of USDC sent to the position manager steers its payment code into `WETH9.deposit` and every
mint reverts until somebody calls its public `refundETH()`. A migration then fails whole and
loses nothing (`test_positionManagerWithUsdcAsWeth_failsSafe`), but know it before opening.

```bash
cast call $NFPM "WETH9()(address)" --rpc-url $RPC
```

## 4. Open, then dry-run on the node before anybody pays for it

The scanner opens migrations by itself (`monitor/migrate.mjs`) the first time all of these hold:
Uniswap v3 has code at the fixed addresses, the 1% tier has tick spacing 200, the position
manager belongs to the factory, the factory's runtime code with its own address masked out
hashes to the npm build (`0xc66c27d7...18af`), and the position manager's WETH9 is not the USDC
face. Anything else, and it keeps them closed and says why on Telegram every few hours. The
owner console opens them by hand either way. Once an owner closes them again, the scanner
leaves them closed.

`setMigrationsOpen(true)` itself reverts with `dex: not live` until Uniswap's contracts exist
at the fixed addresses, and with `dex: 1% tier` or `dex: pm factory` if what is there is not
the Uniswap v3 the platform expects.

`eth_call` runs on the node, with Arc's real USDC precompile. A local fork cannot: Foundry has
no implementation of the native-balance precompile at `0x1800...0000` that every USDC transfer
goes through, so `forge script` and `cast call --trace` both fail on it. Use plain `cast call`.

```bash
cast send $PLATFORM "setMigrationsOpen(bool)" true --rpc-url $RPC --private-key <owner>
cast call $PLATFORM "migrate(address)" <graduated token> --from <any address> --rpc-url $RPC
```

A dry run that reverts means the real call would revert too: nothing is lost, and the reason is
in the revert string (`pool price out of reach` means somebody parked liquidity at the wrong
price; buying or selling it back toward the curve's price clears it).

## 5. Point the site at the Uniswap app

Once a link has been opened by hand and shows the token against USDC on Arc, put it in
`docs/config.js` as `uniswap.mainnet.swapUrl` (`{token}` and `{usdc}` are filled in). Until
then the trade panel of a migrated coin links its pool on the explorer.

## 6. After the first migration

For the migrated token (the testnet rehearsal script checks exactly these):

- the pool's price equals the curve's last `priceWad` (to ~1e-10);
- USDC in the pool, times 1e12, plus the dust credited to `platformFees`, equals `raised`;
- tokens in the pool plus tokens at `0x...dEaD` equal the curve's `tReserve`, none left behind;
- `NFPM.ownerOf(positionOf(token))` is the platform;
- the site shows the coin as ON UNISWAP and its panel offers Uniswap instead of the curve.

## 7. If a move cannot happen

A graduated coin's curve is closed while it waits for its move. If the move cannot happen,
because Uniswap is not live yet or somebody blocked its pool, an owner may put the coin back
on its curve from one hour after graduation (`reopenCurve(token)`, or the owner console, a
local file kept outside the repo). It then trades exactly as before graduation until `migrate` succeeds, which
closes it for good. Reopening moves no funds and changes no price.

## 8. Keeping it moving

`migrate(token)` is permissionless and nothing in the contract calls it on its own. Once
migrations are open, the scanner does (`monitor/migrate.mjs`, run from its deployed phase):
every minute it checks the curves for graduations, dry-runs each migration on the node, and
sends it from the deployer, who pays about 0.12 USDC of gas per move. Every move is reported
on Telegram; a migration that would revert, or a deployer below 0.3 USDC of gas, is reported
once and then at most every six hours while it lasts. To see what it sees without sending:

```bash
node monitor/migrate.mjs --rpc $RPC --platform $PLATFORM --from <deployer address>
```
