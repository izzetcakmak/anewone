// Single entry that re-exports exactly what the page needs: WalletConnect's EIP-1193
// provider, which brings its own QR / deep-link modal. Bundled with esbuild, committed as
// docs/vendor/walletconnect.esm.js so the site keeps script-src 'self'.
export { EthereumProvider } from "@walletconnect/ethereum-provider";
