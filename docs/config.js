// ANEWONE (anewone.xyz) network config. The mainnet block is filled automatically by monitor/scan.mjs
// the moment Arc mainnet is detected and the platform is deployed.
window.ANEWONE_CONFIG = {
  /* MAINNET_BLOCK_START — rewritten verbatim by monitor/scan.mjs; keep both markers */
  mainnet: {
    live: false,
    chainId: null,
    chainIdHex: null,
    rpc: null,
    explorer: null,
    platform: null,
    noah: null,
  },
  /* MAINNET_BLOCK_END */
  testnet: {
    live: true,
    chainId: 5042002,
    chainIdHex: "0x4cef52",
    rpc: "https://rpc.testnet.arc.network",
    // Read RPCs (prices/balances/feed), tried in order via a FallbackProvider: keyed QuickNode
    // first (domain-locked to anewone.xyz, high limits), public RPC as fallback. `rpc` above
    // stays PUBLIC on purpose — wallet/Web3Auth submit txs outside this origin and the
    // domain-locked URL would 401 them.
    // Read pool, best first. Measured against the real workload (eth_call, 200
    // concurrent) rather than assumed:
    //
    //   drpc         200 concurrent, 0 errors   ~230 calls/s
    //   blockdaemon  200 concurrent, 0 errors   ~150 calls/s
    //   arc public    throttles at 50            ~39 calls/s
    //   our keyed     throttles at 25            (last resort)
    //
    // The keyed endpoint sits LAST on purpose. Its quota is shared by every
    // visitor at once, so it is the one thing that gets worse as the site gets
    // busier; the public ones rate-limit per IP, so they scale with the crowd.
    // A keyed entry may declare the hosts its domain lock accepts — anywhere else
    // (www., a *.vercel.app preview, localhost) it 401s every call, so it is
    // dropped from the pool instead of burning the retry budget on a certain failure.
    rpcs: [
      "https://rpc.drpc.testnet.arc.network",
      "https://rpc.blockdaemon.testnet.arc.network",
      "https://rpc.testnet.arc.network",
      {
        url: "https://chaotic-dimensional-dream.arc-testnet.quiknode.pro/6f85d01f85d8794bd8a1299852d1c16511efb267/",
        hosts: ["anewone.xyz"],
      },
    ],
    // eth_getLogs is a different capability from eth_call and the endpoints differ:
    // the keyed QuickNode plan caps a range at 5 blocks (413s the history scan),
    // drpc and the public RPC cap at 10k, blockdaemon served 50k. The front end
    // asks for 10k chunks, so all three below work — best first.
    logRpcs: [
      "https://rpc.blockdaemon.testnet.arc.network",
      "https://rpc.drpc.testnet.arc.network",
      "https://rpc.testnet.arc.network",
    ],
    explorer: "https://testnet.arcscan.app",
    platform: "0x99Bd23c2DD814055a4A2438912C6b4eD2Ae9Ebcf",
    noah: "0x0D1ac2a7FCdd8bF74EEC839DF4ED909071296a49",
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
      clientId: "BIBoyMyqi-N0SYPTKHXIrBdWulIYDbJ12IONwS-i-g8VEy-2OmH9DxqBnVTOCc99gBE7v51L5aiQntfu1O9KswQ",
      network: "sapphire_mainnet",
    },
  },
};
