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
  // "Continue with Google" (embedded wallet via Web3Auth), configured PER blockchain network.
  // While testnet is live the testnet clientId is used; the moment the scanner flips
  // mainnet.live=true the mainnet entry takes over automatically. Before launch, create a
  // sapphire_mainnet project at dashboard.web3auth.io, whitelist https://anewone.xyz, and
  // paste its clientId into web3auth.mainnet.clientId. Empty clientId => the Google button
  // simply stays hidden on that network (nothing breaks).
  web3auth: {
    testnet: {
      clientId: "BHMuvLRDj0_XO7RJoviuCgjbSLcvMWUgAgdCCSrStDO41bmuiyXZw9haSXuNDTtwqwR7IpqqZ_KKjqc-Jlvjqqk",
      network: "sapphire_devnet",
    },
    mainnet: {
      clientId: "", // paste a sapphire_mainnet Web3Auth clientId here before mainnet launch
      network: "sapphire_mainnet",
    },
  },
};
