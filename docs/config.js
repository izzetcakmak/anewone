// ANEWONE (anewone.xyz) network config. The mainnet block is filled automatically by monitor/scan.mjs
// the moment Arc mainnet is detected and the platform is deployed.
window.ANEWONE_CONFIG = {
  mainnet: {
    live: false,
    chainId: null,
    chainIdHex: null,
    rpc: null,
    explorer: null,
    platform: null,
    noah: null,
  },
  testnet: {
    live: true,
    chainId: 5042002,
    chainIdHex: "0x4cef52",
    rpc: "https://rpc.testnet.arc.network",
    explorer: "https://explorer.testnet.arc.network",
    platform: "0x5d85Df16c7CA1B0239959eB6dCc66d1F9AAbdEeF",
    noah: "0x0a4E6EbE4Fd63647b0506b4816b276c212595934",
  },
};
