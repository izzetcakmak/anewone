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
| SHA-256 | `fd66c04651929c6a37806a37e8217e6b6aac07c7e816ad478f52690b7429bc61` |
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
| SHA-256 | `94c5265136e809f7010d1bd2f424cc8e23c25535d6f969927b0db97b4a7c6d62` |

Loaded lazily, only when a trade modal is opened. Renders candles; it never touches the wallet.

## web3auth.esm.js

| | |
|---|---|
| Size | 1,417,528 bytes |
| SHA-256 | `54569855fc5ce51b120a95bbcd961a2e9191d850f433e38adbd9f5db2e48d9c9` |

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
