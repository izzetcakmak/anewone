# Vendored third-party code

Nothing on this page loads from a third-party origin. Every dependency is served from
`anewone.xyz` itself, which is what lets the CSP keep `script-src` at `'self'` and removes
the CDN as a way to rewrite the code that builds and signs transactions.

The trade is that a committed binary is opaque unless its origin is written down. This file
is that record. Re-verify with `sha256sum` after any update, and update the entry.

---

## ethers.umd.min.js

| | |
|---|---|
| Package | `ethers` |
| Version | 6.13.4 |
| File | `dist/ethers.umd.min.js` |
| Size | 505,826 bytes |
| SHA-256 | `c8fa22ce2d2d8ec7beed85e218081d3f784605f9d3845427f2c1d9abb0ec0849` |
| SRI (sha384) | `6Zl0Pc8zjSz8KvmNeXRvUQgY4ryFb+BwDvKCmLYcBME0joAaru491tQgi9B7zsMM` |

Fetched from `https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js` and confirmed
byte-identical to `https://unpkg.com/ethers@6.13.4/dist/ethers.umd.min.js` — two CDNs with
independent infrastructure serving the same bytes.

To re-verify:

```bash
curl -sL https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js | sha256sum
```

## lightweight-charts.standalone.production.js

| | |
|---|---|
| Package | `lightweight-charts` |
| Version | 5.0.8 (banner reads `Lightweight Charts™ v5.0.8`) |
| Size | 180,434 bytes |
| SHA-256 | `c8fa22ce2d2d8ec7beed85e218081d3f784605f9d3845427f2c1d9abb0ec0849` |

Loaded lazily, only when a trade modal is opened. Renders candles; it never touches the wallet.

## web3auth.esm.js

| | |
|---|---|
| Size | 1,417,528 bytes |
| SHA-256 | `c8fa22ce2d2d8ec7beed85e218081d3f784605f9d3845427f2c1d9abb0ec0849` |

**Not an upstream release** — there is no published file to compare it against. Public CDNs
mis-transpile Web3Auth's CJS dependencies (loglevel), so this is bundled locally with esbuild
from official npm packages. The recipe is committed in `build-web3auth/`:

- `package.json` — `@web3auth/modal`, `@web3auth/base`, `@web3auth/ethereum-provider` at `^9.7.0`
- `package-lock.json` — 226 packages, every one resolved from `registry.npmjs.org` and every one
  carrying an integrity hash (zero exceptions)
- `entry.mjs` — re-exports exactly four symbols: `Web3Auth`, `CHAIN_NAMESPACES`,
  `WEB3AUTH_NETWORK`, `EthereumPrivateKeyProvider`
- `shim.mjs` — the `globalThis.Buffer` polyfill

Resolved versions: `@web3auth/modal`, `base`, `ethereum-provider`, `no-modal`, `base-provider`,
`auth-adapter`, `ui` at 9.7.0; `@web3auth/auth` at 9.6.4.

This bundle has wallet access, so it was also checked for where it can talk to. Every remote host
referenced belongs to Web3Auth/Torus infrastructure (`*.web3auth.io`, `images.toruswallet.io`,
`*.tor.us`), block-explorer metadata tables that Web3Auth ships (etherscan, bscscan, blockscout,
oklink, cronoscan, klaytn, solana), the W3C SVG namespace, MetaMask's gas API, or documentation
URLs in library error strings. No unrecognised endpoint appears.

To re-verify the inputs:

```bash
cd build-web3auth && npm ci
```

`npm ci` fails if any package does not match the integrity hash in the lockfile.

---

## walletconnect.esm.js

| | |
|---|---|
| Size | 2,127,359 bytes |
| SHA-256 | `1a4355dcd94e9887bd4829614f285cba3e4e04e1f470c413afaf55895e03ae00` |

**Not an upstream release**, like the Web3Auth bundle: WalletConnect's EIP-1193 provider with
its QR / deep-link modal, bundled locally with esbuild from official npm packages so the site
keeps `script-src 'self'`. Loaded only when somebody picks WalletConnect in the wallet picker.
The recipe is committed in `build-walletconnect/`:

- `package.json` — `@walletconnect/ethereum-provider` at `^2.21.0`, `buffer`, `esbuild`
- `package-lock.json` — 308 packages, every one resolved from `registry.npmjs.org` and every one
  carrying an integrity hash (zero exceptions)
- `entry.mjs` — re-exports exactly one symbol: `EthereumProvider`
- `shim.mjs` — the `globalThis.Buffer` polyfill

Resolved versions: `@walletconnect/ethereum-provider`, `universal-provider`, `sign-client` at
2.25.0; `@reown/appkit` (the modal) at 1.8.19. Built 27 Sep 2026 with `npm run build`.

This bundle has wallet access, so it was also checked for where it can talk to. Every remote
host referenced belongs to WalletConnect/Reown infrastructure (`*.walletconnect.org`,
`*.walletconnect.com`, `*.reown.com`, `api.web3modal.org`, `fonts.reown.com`), wallet deep-link
domains the modal offers (`go.cb-w.com`, `app.binance.com`, `phantom.app`, `solflare.com`,
`app.safe.global`, `t.me`), `4byte.sourcify.dev` (function-signature lookups for the modal's
transaction preview), `ipfs.io` / `arweave.net` (wallet icon fallbacks), or documentation URLs
in library error strings (`viem.sh`, `abitype.dev`, `oxlib.sh`, `docs.soliditylang.org`,
`feross.org`, `github.com`, `www.npmjs.com`). No unrecognised endpoint appears. The provider
talks to the relay at `wss://relay.walletconnect.org` with the project id in `docs/config.js`,
which is public and allowlisted to `anewone.xyz`.

To re-verify the inputs:

```bash
cd build-walletconnect && npm ci && npm run build && sha256sum ../docs/vendor/walletconnect.esm.js
```

---

## gangway-kit.js

| | |
|---|---|
| Package | `gangway-kit` (in-house, izzetcakmak; GangWay Kit, formerly arc-bridge-kit) |
| Version | 0.6.1 |
| File | `gangway-kit.js` |
| Size | 154,273 bytes (LF line endings, as committed and served) |
| SHA-256 | `87cc379f5f4af02f8ff1490ad58b5900b4aa7a531b047ecd6ab8879ea87f2be4` |

Built here, not fetched: the source is public at https://github.com/izzetcakmak/gangway-kit
(local checkout `C:\Users\Monster\arc-bridge-kit`, demo at https://arc-bridge-kit.vercel.app) and is copied verbatim. It is plain JavaScript on
top of the vendored ethers v6: Circle CCTP V2 + Forwarding Service for the bridge, LI.FI's
public API for same-chain swaps (through this site's `/api/lifi` proxy, which holds the key),
and the platform's own `buy` for the last leg. From Solana (v0.5.0, 23 Sep 2026) the whole
trip is one LI.FI route signed by the user's Wallet Standard wallet; the kit bundles no Solana
library and reads Solana balances over public JSON-RPC. From Sui (v0.6.0, 10 Oct 2026, two days after
Circle's CCTP V2 went live there) USDC goes over CCTP V2 with the Forwarding Service: the kit builds
one programmable transaction itself, the JSON a Wallet Standard wallet receives from `transaction.toJSON()`,
calling Circle's published Move packages (`deposit_for_burn`, `handler::burn`, `complete_burn`; ids from
developers.circle.com/cctp/references/sui-packages, equal to those of a live mainnet burn). That JSON is
tested equal to what `@mysten/sui` 2.35.0 prints and was dry-run on Sui mainnet against real accounts;
no Sui library is bundled, and balances, coins and status are read over Sui's GraphQL endpoint
(`graphql.mainnet.sui.io`, public JSON-RPC being switched off). Any swap into USDC on Sui is LI.FI's
transaction, signed exactly as quoted. It builds no swap calldata of its own;
LI.FI transactions are sent exactly as quoted, CCTP calls go to Circle's uniform contract addresses on EVM chains.

To re-verify after an update: `curl -s https://anewone.xyz/vendor/gangway-kit.js | sha256sum` (or
`git show HEAD:docs/vendor/gangway-kit.js | sha256sum`); a Windows checkout may carry CRLF and hash differently.

## onramp-kit.js

| | |
|---|---|
| Package | `@circle-fin/onramp-kit` (Circle, Apache-2.0), browser surface only |
| Version | 1.0.3 |
| File | `onramp-kit.js` (ESM, minified) |
| Size | 98,209 bytes |
| SHA-256 | `eaa614ccec073e3956d3f77f5188e701a14c38169662c12a33c1e8f7242da64b` |
| SRI (sha384) | `TOpBOKdQYBtYavc2RdmrIFoDPN2WjJTyNlhQkW7cl9/lJJxuxSBWQdan2Uvg1R/O` |

**Not an upstream release file**: Circle ships the kit as npm modules that import `zod` and
`pino`, so it is bundled locally with esbuild from the official npm package. The recipe is
committed in `build-onramp/`:

- `package.json` / `package-lock.json`: `@circle-fin/onramp-kit@1.0.3` pinned, every package
  resolved from `registry.npmjs.org` with an integrity hash
- `entry.mjs`: re-exports exactly four symbols, `createOnrampKit`, `KitError`,
  `ONRAMP_EVENT_TYPES`, `ONRAMP_EVENT_CODES`
- `build.mjs`: the esbuild call; prints the hashes above

The server half of the kit (`@circle-fin/onramp-kit/server`, which holds the API key) is **not**
in this bundle; it runs in `api/onramp-session.js` on Vercel. The only remote host the bundle
references is `https://onramp.arc.io`, Circle's hosted widget origin, which it frames in an
iframe and origin-pins `postMessage` events to. It never touches the wallet: it receives a
short-lived session token from our own `/api/onramp-session` and mounts the widget; the
purchase itself happens inside Circle's frame.

Loaded lazily, only when a visitor presses "Buy USDC with card".

To re-verify:

    cd build-onramp && npm ci && node build.mjs

## earn-kit.js

| | |
|---|---|
| Package | `@circle-fin/earn-kit` 1.8.1 + `@circle-fin/borrow-kit` 1.0.0 + `@circle-fin/adapter-ethers-v6` + `@circle-fin/adapter-viem-v2` 1.19 (`/next`, with viem) (Circle, Apache-2.0) |
| File | `earn-kit.js` (ESM, minified) |
| Size | 2,002,407 bytes |
| SHA-256 | `76ef39488c455d7f8e1f551b931dd9af2288eb27ff6d9033c06e90ac2fa4a118` |

**Not an upstream release file**: bundled locally with esbuild from the official npm packages,
recipe in `build-earn/` (`entry.mjs` re-exports `EarnKit`, `BorrowKit`, `KitError`,
`getErrorMessage`, `isRetryableError`, `createEthersAdapterFromProvider` and the viem `/next`
adapter as `createViemNextAdapterFromProvider`, plus viem's `createPublicClient`, `http` and `fallback` so the page can point that adapter's reads at the site's RPC pool, which Borrow uses because a loan is one atomic
batch: on Arc a plain wallet gets that through the chain's sender-preserving batcher, which only
this adapter knows; `build.mjs` prints the hash). Runs in Circle's permissionless mode: no API key is bundled or needed. Vault and market
data come from `https://api.circle.com`; deposits, withdrawals and loan operations are signed by
the visitor's own wallet through the ethers adapter and go to the Morpho contracts on Arc. The
bundle also carries Circle's chain table (public RPC and explorer URLs for every chain the kits
know, incl. `@solana/web3.js`) and viem, which is why it is 2 MB; only the Arc entries are used.
Loaded lazily, only on `/earn/`.

To re-verify:

    cd build-earn && npm ci && node build.mjs
