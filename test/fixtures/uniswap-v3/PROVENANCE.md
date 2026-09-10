# Uniswap v3 bytecode for the migration tests

These are Uniswap's own compiled artifacts, copied byte for byte out of the npm tarballs
below. The tests deploy them as they are, so the migration is exercised against the exact
code Uniswap ships, not a recompilation of it. That matters for more than fidelity: the
position manager finds pools through a hardcoded hash of the pool's creation code
(`POOL_INIT_CODE_HASH`), and only the published build matches it.

| file | package | path in tarball | sha256 |
|---|---|---|---|
| `UniswapV3Factory.json` | `@uniswap/v3-core@1.0.1` | `artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json` | `599479f60ebb056804aff7b2d05bdd0830ddbb1fdfaa0b6c62c02294ca7188b0` |
| `NonfungiblePositionManager.json` | `@uniswap/v3-periphery@1.4.4` | `artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json` | `bb4f9f1ca393293831e73db52c5425cc336b49dbda2cd9cd2708c4c885221675` |
| `SwapRouter.json` | `@uniswap/v3-periphery@1.4.4` | `artifacts/contracts/SwapRouter.sol/SwapRouter.json` | `c3eb42a951dbe00277660ba47304ed41cf1bde67e98b8a952f7f22c917d6fb02` |

Tarball integrity, as the npm registry publishes it:

- `uniswap-v3-core-1.0.1.tgz`: `sha512-7pVk4hEm00j9tc71Y9+ssYpO6ytkeI0y7WE9P6UcmNzhxPePwyAxImuhVsTqWK9YFvzgtvzJHi64pBl4jUzKMQ==`
- `uniswap-v3-periphery-1.4.4.tgz`: `sha512-S4+m+wh8HbWSO3DKk4LwUCPZJTpCugIsHrWR86m/OrUyvSqGDTXKFfc2sMuGXCZrD1ZqO3rhQsKgdWg3Hbb2Kw==`

Check: `keccak256(UniswapV3Pool creation code)` from the same v3-core tarball is
`0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54`, equal to
`POOL_INIT_CODE_HASH` in v3-periphery 1.4.4 `contracts/libraries/PoolAddress.sol`.

License: v3-core is BUSL-1.1, which converted to GPL-2.0-or-later on 2023-04-01; v3-periphery
is GPL-2.0-or-later. Used here only as test fixtures.
