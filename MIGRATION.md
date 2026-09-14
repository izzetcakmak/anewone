# Opening migrations on Arc mainnet

The platform ships with migrations **closed**. Nothing moves into Uniswap until the admin calls
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
owner console opens them by hand either way. Once the admin closes them again, the scanner
leaves them closed.

`setMigrationsOpen(true)` itself reverts with `dex: not live` until Uniswap's contracts exist
at the fixed addresses, and with `dex: 1% tier` or `dex: pm factory` if what is there is not
the Uniswap v3 the platform expects.

`eth_call` runs on the node, with Arc's real USDC precompile. A local fork cannot: Foundry has
no implementation of the native-balance precompile at `0x1800...0000` that every USDC transfer
goes through, so `forge script` and `cast call --trace` both fail on it. Use plain `cast call`.

```bash
cast send $PLATFORM "setMigrationsOpen(bool)" true --rpc-url $RPC --private-key <admin: the main wallet>
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
because Uniswap is not live yet or somebody blocked its pool, the admin may put the coin back
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

## 9. Bridge kit: USDC in from any chain, then buy

`arc-bridge-kit` (`C:\Users\Monster\arc-bridge-kit`, demo at https://arc-bridge-kit.vercel.app)
brings USDC to Arc over Circle CCTP V2 with the Forwarding Service (one signature on the source
chain, no gas on Arc) and can chain a `buy` on the platform once it lands. Circle already quotes
forwarded routes into Arc (domain 26) from every major mainnet and Base's TokenMessengerV2 has
Arc registered; what is missing at the time of writing is only Arc's public mainnet RPC.
Steps, in order, once the chain is up:

1. Arc mainnet RPC + explorer go into `docs/config.js` (`mainnet.rpcs`, `mainnet.explorer`);
   the scanner writes them with the rest of the block. The kit reads them through `arcRpcs`
   and `arcExplorer`, nothing is hard-coded on its side.
2. Confirm the route from the kit folder, read-only:

   ```bash
   npm run preflight:mainnet     # every source chain: chainId, USDC decimals, Arc registered, Iris forward quote
   ```

   Also fill `ARC.mainnet.rpcs` in `arc-bridge-kit.js` with the same RPC so the preflight
   checks Arc itself (USDC face `0x3600…0000` = 6 decimals, `MessageTransmitterV2.localDomain() == 26`).
3. Ship it: copy `arc-bridge-kit.js` to `docs/vendor/`, add its line to `docs/vendor/PROVENANCE.md`,
   load it after `ethers.umd.min.js` and `config.js`. Mount as in
   `arc-bridge-kit/INTEGRATION-ANEWONE.md`: `network` from `cfg.mainnet.live`, the site's own
   EIP-1193 provider, `onConnect` = the site's connect flow, and for Web3Auth the `switchChain`
   option (its embedded wallet needs `addChain`/`switchChain`, not `wallet_switchEthereumChain`).
4. On a coin page pass `destination` = `buy(token, minOut)` with `value = received * 1e12 - gas`
   (CCTP mints 6-decimal units, Arc's native USDC is 18-decimal). `quoteBuy` reverts on a
   graduated curve before the wallet opens; the anti-snipe cap still applies in the first blocks.
5. First real run, small: 2 USDC from Base mainnet, Fast, recipient = the connected wallet,
   then buy $NOAH with it. Expect ~0.02 USDC of Circle fees and 20-60 s. If the forwarder is
   late the widget offers "Mint on Arc" (`receiveMessage` from the user's wallet, needs a little
   USDC on Arc); the attestation is kept in localStorage.
6. Paying with something other than USDC is in the kit (14 Sep 2026): LI.FI quotes the
   same-chain swap into USDC, the kit sends it, measures the USDC that arrived and burns that.
   Works on Base Sepolia today (ETH → USDC → Arc → $NOAH can be rehearsed end to end) and on
   12 of the 14 mainnet sources (`npm run preflight:mainnet` prints an `info` line per chain;
   World Chain and Sei have no LI.FI swap, they bridge USDC only). Keyless LI.FI is ~200
   requests / 2 h per visitor IP, which showed up on the very first testnet try. Before launch:
   free partner key from portal.li.fi → `LIFI_API_KEY` in the anewone Vercel project → copy the
   kit's `api/lifi/[...path].js` into anewone's `api/` → mount with
   `lifiApi: location.origin + "/api/lifi"`. The key never reaches the browser.
7. Graduated coins from the gangway: `docs/config.js` → `uniswap.mainnet.router` / `.quoter` hold
   Uniswap's Arc SwapRouter02 and QuoterV2 (from sdk-core `ARC_ADDRESSES`). The page only trades
   through them once, on the live chain, `eth_getCode(router)` is non-empty and `router.factory()`
   equals the platform's `v3Factory()`; a mismatch keeps pool buys off and the page says so. Check
   by hand before launch: `cast code 0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77 --rpc-url $RPC`
   and `cast call 0x53bf…6f77 "factory()(address)"` == `$FACTORY`. Pool buys are USDC-face
   `approve` + `exactInputSingle` on the 1% tier; QuoterV2 sets the minimum out with a 5% guard.
8. Swap revenue: the gangway passes `integrator=anewone` and `fee=0.0025` to LI.FI on mainnet
   (0.25% of every non-USDC payment, forwarded to the integrator's fee wallet on the source
   chain at execution, per chain and token). **Not registered as of 14 Sep 2026**: the API
   answers `Integrator "anewone" is not configured for collecting fees` (no other name is,
   either). Register the integration string `anewone` at portal.li.fi with the main wallet as
   fee wallet; until then the kit detects the refusal, quotes without the fee (the swap still
   works) and simply earns nothing. Withdraw from the portal dashboard with that same wallet.
9. LI.FI into Arc: the kit's `router: "auto"` asks LI.FI for a route into chain 5042 on every
   quote (cached 10 min). Today it answers "not supported"; the day it does, any-token → USDC on
   Arc becomes one LI.FI transaction and CCTP stays the fallback, no redeploy needed. Check with
   `npm run preflight:mainnet` ("LI.FI direct route into Arc: YES").
