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
    platform: "0xC83212Af0aE3FF762Df955E571655082AEc45B49",
    noah: "0x7BE0b3a50D326c30Fdb75B0806184E3B1D04e595",
  },
};
