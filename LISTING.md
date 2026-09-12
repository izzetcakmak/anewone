# Listing $NOAH: explorer verification, CoinGecko, CoinMarketCap

What to do after Arc mainnet opens, in order. Each step's output feeds the next one, and the
listing forms all refuse a token that is not verifiably traded somewhere.

## 1. Verify the contracts on the mainnet explorer

Both trackers require a verified contract, and so does anyone reading the code from a block
explorer. The testnet explorer is Blockscout (`https://testnet.arcscan.app`); the mainnet one is
expected to be the same stack at its own domain, so the commands only change in the URL.

```bash
# the platform: the constructor arguments are the ones script/Deploy.s.sol passed
ARGS=$(cast abi-encode "constructor(uint256,uint256,address,address,address)" \
  4000000000000000000000 5000000000000000000000 \
  0xf0db7b58379503491d857dB50AC9ece64c653918 \
  0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377 \
  0x3600000000000000000000000000000000000000)

forge verify-contract <PLATFORM> src/ANewOne.sol:ANewOne \
  --chain-id 5042 --verifier blockscout --verifier-url <EXPLORER>/api \
  --constructor-args "$ARGS" --watch

# $NOAH: deployed by the platform inside createToken, so the holder of the whole supply is the
# platform address
forge verify-contract <NOAH> src/ANewOne.sol:ANewOneToken \
  --chain-id 5042 --verifier blockscout --verifier-url <EXPLORER>/api \
  --constructor-args $(cast abi-encode "constructor(string,string,uint256,address)" \
    "Noah's Arc" "NOAH" 1000000000000000000000000000 <PLATFORM>) --watch
```

On mainnet the three Uniswap arguments are the ones above (they are what Deploy.s.sol uses on
chain 5042); on any other chain they are zero. Check the deploy log for the exact values it
printed: `ANEWONE_PLATFORM`, `NOAH_TOKEN`, `DEX_FACTORY`, `DEX_POSITION_MANAGER`, `USDC_ERC20`.

Rehearsed on Arc testnet on 12 Sep 2026 with exactly these commands (zeros for the Uniswap
arguments there): platform `0xEc5926A39d5Dc7F8286d2c2c19FAE18F843D7f47` and token
`0xD03DF0a8176bB84F4EAC0e6E51345777FE2b102F` both came back "Pass - Verified" within a minute,
and the explorer serves their source. Verification takes a couple of queue rounds, so keep
`--watch`.

## 2. Wait for a market

Both CoinGecko and CoinMarketCap only list an asset that trades on a market they track. $NOAH
trades on its bonding curve from the first block, but that is not an exchange anyone tracks. The
market appears when $NOAH graduates at 5,000 USDC raised and the platform opens its Uniswap v3
pool (see MIGRATION.md). Submit after the pool exists and has real volume.

## 3. What both forms ask for

| Field | Value |
|---|---|
| Name / symbol | Noah's Arc / NOAH |
| Chain | Arc (chain id 5042) |
| Contract address | from the deploy log, verified in step 1 |
| Website | https://anewone.xyz |
| Explorer link | the mainnet explorer's token page |
| Market / pair | the Uniswap v3 pool, NOAH against USDC, 1% fee tier |
| Logo | `docs/brand/noah-200.png` (200x200 PNG; 512 and 1024 are there too) |
| X | https://x.com/anewone_xyz |
| GitHub | https://github.com/izzetcakmak/anewone |
| Docs | https://anewone.xyz/docs.html |
| About / team | https://anewone.xyz/about.html |
| Contact | support@anewone.xyz |
| Description | The first coin launched on A NEW ONE, a memecoin launchpad on Arc where coins trade on a USDC bonding curve and graduate into a Uniswap v3 pool the platform contract holds for good. |

## 4. Submit

- **CoinGecko**: log in, Request Form at the bottom of the site, "New Coin/Token Listing".
  Their asset platform `arc` currently carries chain id 5042002, which is Arc testnet. If the
  form will not take a mainnet address, ask them to add Arc mainnet (5042) with the "New Chain
  Listing (Asset Platform)" request first.
- **CoinMarketCap**: https://coinmarketcap.com/request/, "Add cryptoasset". Same pack.

Both take weeks, and both reject incomplete submissions without much explanation, so fill every
field and link the verified contract.

## 5. Worth doing alongside

- DefiLlama and the Arc ecosystem page: both are read by the trackers and by security vendors.
- Keep `docs/meta/noah.json` in step with whatever the listings say, since the site and the
  token metadata point at it.
