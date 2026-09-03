// Single entry that re-exports exactly what the page needs. esbuild resolves the CJS/ESM
// interop (loglevel etc.) that the public CDNs mishandle, producing one browser-ready file.
export { Web3Auth } from "@web3auth/modal";
export { CHAIN_NAMESPACES, WEB3AUTH_NETWORK } from "@web3auth/base";
export { EthereumPrivateKeyProvider } from "@web3auth/ethereum-provider";
