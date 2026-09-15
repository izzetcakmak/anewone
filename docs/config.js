// ANEWONE (anewone.xyz) network config. The mainnet block is filled automatically by monitor/scan.mjs
// the moment Arc mainnet is detected and the platform is deployed.
window.ANEWONE_CONFIG = {
  /* MAINNET_BLOCK_START — rewritten verbatim by monitor/scan.mjs; keep both markers */
  mainnet: {
    live: true,
    chainId: 5042,
    chainIdHex: "0x13b2",
    rpc: "https://rpc.drpc.mainnet.arc.io",
    // Measured 16 Sep 2026, minutes after launch. eth_call: all four answer. eth_getLogs:
    // dRPC refuses every range on its free plan ("ranges over 10000 blocks"), quicknode and
    // rpc.mainnet.arc.io take up to 10k blocks, blockdaemon takes any range — so it leads
    // the log pool and dRPC is not in it at all.
    rpcs: ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io", "https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"],
    logRpcs: ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"],
    // no public block explorer yet (arcscan.app / explorer.arc.network do not resolve,
    // arcscan.xyz is a parked domain, explorer.arc.io is behind Circle's access login)
    explorer: null,
    platform: "0x3DDA5AD5E74c658aff3d082AFe404a71615B1bc5",
    noah: "0x26Cc2b608Df6be8fF63C64C9464b2756cC5dc128",
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
    // eth_getLogs is a different capability from eth_call, and for logs the
    // deciding property is not throughput but HISTORY. Token artwork lives in a
    // TokenImage event at the block the coin was created — sometimes millions of
    // blocks back — and blockdaemon answers those with "pruned history
    // unavailable". Ordering it first (it takes the widest ranges and the most
    // concurrency) silently emptied every card on the floor for anyone without a
    // warm cache. Full-history endpoints lead; blockdaemon still earns its place
    // on the recent ranges the live tail asks for.
    // dRPC is not in this list. On 13 Sep 2026 its free plan was found refusing
    // getLogs past a few hundred blocks ("ranges over 10000 blocks are not
    // supported on free plan", returned even for 1,000), and leading this list it
    // froze live trades for every visitor. It still serves eth_call in rpcs above.
    logRpcs: [
      "https://rpc.testnet.arc.network",
      "https://rpc.blockdaemon.testnet.arc.network",
    ],
    explorer: "https://testnet.arcscan.app",
    platform: "0x99Bd23c2DD814055a4A2438912C6b4eD2Ae9Ebcf",
    noah: "0x0D1ac2a7FCdd8bF74EEC839DF4ED909071296a49",
  },
  // Where a coin trades once it has graduated into Uniswap v3; {token} and {usdc} are filled
  // in. Left empty until the link has been checked by hand against the live Uniswap app:
  // while it is empty, the trade panel links the pool on the explorer instead.
  uniswap: {
    // router / quoter: Uniswap's own Arc deployment (sdk-core ARC_ADDRESSES: SwapRouter02 and
    // QuoterV2). The gangway (/bridge/) buys graduated coins in their Uniswap pool through them,
    // but only after checking on-chain that the router has code and reports the platform's
    // factory; until then, and on a platform without Uniswap, it says so instead of trading.
    mainnet: { swapUrl: "", router: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77", quoter: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468" },
    testnet: { swapUrl: "", router: "", quoter: "" },
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
