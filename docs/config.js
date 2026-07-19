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
    platform: "0x30c941ed26088DED6c5D4F1571a49f74478DCc84",
    noah: "0xdd1B695d94dE16A85E17E772664067020806E4A1",
  },
  // "Continue with Google" (embedded wallet via Web3Auth) activates when this is set to a
  // public Web3Auth clientId. Get one free at dashboard.web3auth.io, add anewone.xyz to the
  // project's allowed origins, paste the clientId here. Empty = the Google button stays hidden.
  web3authClientId: "BHMuvLRDj0_XO7RJoviuCgjbSLcvMWUgAgdCCSrStDO41bmuiyXZw9haSXuNDTtwqwR7IpqqZ_KKjqc-Jlvjqqk",
  // must match the network your Web3Auth project is registered on (dashboard → project)
  web3authNetwork: "sapphire_devnet",
};
