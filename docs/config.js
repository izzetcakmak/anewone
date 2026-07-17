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
    platform: "0x21BC50350e89A3B71E81445245Ac1c6B6f4Dc000",
    noah: "0xfF3800de41059A1E7980eAcF14147D8aEf31115d",
  },
};
