/*!
 * arc-bridge-kit v0.2.0
 * Drop-in "pay with anything, land USDC on Arc, then buy" kit.
 *
 *  Legs (each optional except the bridge):
 *    1. SWAP   any token -> USDC on the source chain, via LI.FI's same-chain quote
 *    2. BRIDGE USDC -> Arc via Circle CCTP V2 + Forwarding Service (one signature, no gas on Arc)
 *               — or, the moment LI.FI opens routes into Arc, a single LI.FI cross-chain route
 *                 (router: "auto" probes it per quote and falls back to CCTP)
 *    3. BUY    a host-built transaction on Arc with the USDC that landed (e.g. launchpad buy)
 *
 *  - Fast Transfer (finality threshold 1000, ~20 s) or Standard (2000, no protocol fee).
 *  - Resumable: transfers are persisted in localStorage; a refresh picks them up, a swapped
 *    but not yet bridged amount can be continued, a late forwarder can be minted manually.
 *
 *  Usage (browser, classic script):
 *    <script src="ethers.umd.min.js"></script>
 *    <script src="arc-bridge-kit.js"></script>
 *    ArcBridgeKit.mount(document.getElementById("bridge"), {
 *      ethers: window.ethers, network: "testnet", getProvider: () => window.ethereum,
 *    });
 *
 *  Headless: new ArcBridgeKit.ArcBridge({ ethers, network, provider })
 *
 * Contract addresses, domain IDs and LI.FI behaviour verified live, Sep 2026.
 * No dependencies besides ethers v6 (passed in, never bundled).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ArcBridgeKit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "0.2.0";

  // ------------------------------------------------------------------ constants

  const ARC_DOMAIN = 26;
  const ZERO32 = "0x" + "0".repeat(64);
  const NATIVE = "0x0000000000000000000000000000000000000000";
  // bytes32("cctp-forward"): tells Circle's Forwarding Service to relay the mint on Arc.
  const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
  const FINALITY = { fast: 1000, standard: 2000 };
  const USDC_DECIMALS = 6;

  // CCTP V2 contracts are uniform across EVM chains (mainnet set / testnet set).
  const CCTP = {
    mainnet: {
      tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      iris: "https://iris-api.circle.com",
    },
    testnet: {
      tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
      iris: "https://iris-api-sandbox.circle.com",
    },
  };

  // LI.FI: one API for mainnets and the testnets it lists (Sepolia, Base/OP/Arbitrum Sepolia).
  const LIFI = { api: "https://li.quest/v1", integrator: "arc-bridge-kit" };

  // USDC on Arc is the native gas token; 0x3600...0000 is its ERC-20 face (6 decimals).
  const ARC = {
    mainnet: {
      key: "arc", name: "Arc", chainId: 5042, domain: ARC_DOMAIN,
      usdc: "0x3600000000000000000000000000000000000000",
      // Arc mainnet public RPCs are filled in by the host (config.js) the moment they are
      // published; the kit only needs them for balance polling and manual mint.
      rpcs: [],
      explorer: "https://arcscan.app",
      native: { name: "USDC", symbol: "USDC", decimals: 18 },
    },
    testnet: {
      key: "arc-testnet", name: "Arc Testnet", chainId: 5042002, domain: ARC_DOMAIN,
      usdc: "0x3600000000000000000000000000000000000000",
      rpcs: [
        "https://rpc.testnet.arc.network",
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://rpc.drpc.testnet.arc.network",
      ],
      explorer: "https://testnet.arcscan.app",
      native: { name: "USDC", symbol: "USDC", decimals: 18 },
    },
  };

  const ETH = { name: "Ether", symbol: "ETH", decimals: 18 };

  // Source chains. `fast` = Circle offers Fast Transfer on this chain (others finalize
  // quickly anyway, so standard is already fast there). Order = what users see.
  const SOURCES = {
    mainnet: [
      { key: "base", name: "Base", chainId: 8453, domain: 6, fast: true,
        usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
        explorer: "https://basescan.org", native: ETH },
      { key: "ethereum", name: "Ethereum", chainId: 1, domain: 0, fast: true,
        usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
        explorer: "https://etherscan.io", native: ETH },
      { key: "arbitrum", name: "Arbitrum", chainId: 42161, domain: 3, fast: true,
        usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
        explorer: "https://arbiscan.io", native: ETH },
      { key: "optimism", name: "OP Mainnet", chainId: 10, domain: 2, fast: true,
        usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
        explorer: "https://optimistic.etherscan.io", native: ETH },
      { key: "polygon", name: "Polygon PoS", chainId: 137, domain: 7, fast: false,
        usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
        explorer: "https://polygonscan.com", native: { name: "POL", symbol: "POL", decimals: 18 } },
      { key: "avalanche", name: "Avalanche", chainId: 43114, domain: 1, fast: false,
        usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        rpcs: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
        explorer: "https://snowtrace.io", native: { name: "AVAX", symbol: "AVAX", decimals: 18 } },
      { key: "unichain", name: "Unichain", chainId: 130, domain: 10, fast: true,
        usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
        rpcs: ["https://mainnet.unichain.org"],
        explorer: "https://uniscan.xyz", native: ETH },
      { key: "linea", name: "Linea", chainId: 59144, domain: 11, fast: true,
        usdc: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
        rpcs: ["https://rpc.linea.build"],
        explorer: "https://lineascan.build", native: ETH },
      { key: "worldchain", name: "World Chain", chainId: 480, domain: 14, fast: true,
        usdc: "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1",
        rpcs: ["https://worldchain-mainnet.g.alchemy.com/public"],
        explorer: "https://worldscan.org", native: ETH },
      { key: "sonic", name: "Sonic", chainId: 146, domain: 13, fast: false,
        usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
        rpcs: ["https://rpc.soniclabs.com"],
        explorer: "https://sonicscan.org", native: { name: "Sonic", symbol: "S", decimals: 18 } },
      { key: "monad", name: "Monad", chainId: 143, domain: 15, fast: false,
        usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        rpcs: ["https://rpc.monad.xyz"],
        explorer: "https://monadexplorer.com", native: { name: "Monad", symbol: "MON", decimals: 18 } },
      { key: "sei", name: "Sei", chainId: 1329, domain: 16, fast: false,
        usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
        rpcs: ["https://evm-rpc.sei-apis.com"],
        explorer: "https://seitrace.com", native: { name: "Sei", symbol: "SEI", decimals: 18 } },
      { key: "hyperevm", name: "HyperEVM", chainId: 999, domain: 19, fast: false,
        usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
        rpcs: ["https://rpc.hyperliquid.xyz/evm"],
        explorer: "https://hyperevmscan.io", native: { name: "HYPE", symbol: "HYPE", decimals: 18 } },
      { key: "ink", name: "Ink", chainId: 57073, domain: 21, fast: true,
        usdc: "0x2D270e6886d130D724215A266106e6832161EAEd",
        rpcs: ["https://rpc-gel.inkonchain.com"],
        explorer: "https://explorer.inkonchain.com", native: ETH },
    ],
    testnet: [
      { key: "base-sepolia", name: "Base Sepolia", chainId: 84532, domain: 6, fast: true,
        usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        rpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
        explorer: "https://sepolia.basescan.org", native: ETH },
      { key: "sepolia", name: "Ethereum Sepolia", chainId: 11155111, domain: 0, fast: true,
        usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        rpcs: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"],
        explorer: "https://sepolia.etherscan.io", native: ETH },
      { key: "arbitrum-sepolia", name: "Arbitrum Sepolia", chainId: 421614, domain: 3, fast: true,
        usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
        rpcs: ["https://sepolia-rollup.arbitrum.io/rpc"],
        explorer: "https://sepolia.arbiscan.io", native: ETH },
      { key: "optimism-sepolia", name: "OP Sepolia", chainId: 11155420, domain: 2, fast: true,
        usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
        rpcs: ["https://sepolia.optimism.io"],
        explorer: "https://sepolia-optimism.etherscan.io", native: ETH },
      { key: "polygon-amoy", name: "Polygon Amoy", chainId: 80002, domain: 7, fast: false,
        usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
        rpcs: ["https://rpc-amoy.polygon.technology", "https://polygon-amoy-bor-rpc.publicnode.com"],
        explorer: "https://amoy.polygonscan.com", native: { name: "POL", symbol: "POL", decimals: 18 } },
      { key: "avalanche-fuji", name: "Avalanche Fuji", chainId: 43113, domain: 1, fast: false,
        usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
        rpcs: ["https://api.avax-test.network/ext/bc/C/rpc"],
        explorer: "https://testnet.snowtrace.io", native: { name: "AVAX", symbol: "AVAX", decimals: 18 } },
      { key: "unichain-sepolia", name: "Unichain Sepolia", chainId: 1301, domain: 10, fast: true,
        usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
        rpcs: ["https://sepolia.unichain.org"],
        explorer: "https://sepolia.uniscan.xyz", native: ETH },
      { key: "linea-sepolia", name: "Linea Sepolia", chainId: 59141, domain: 11, fast: true,
        usdc: "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7",
        rpcs: ["https://rpc.sepolia.linea.build"],
        explorer: "https://sepolia.lineascan.build", native: ETH },
      { key: "worldchain-sepolia", name: "World Chain Sepolia", chainId: 4801, domain: 14, fast: true,
        usdc: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
        rpcs: ["https://worldchain-sepolia.g.alchemy.com/public"],
        explorer: "https://worldchain-sepolia.explorer.alchemy.com", native: ETH },
      { key: "sonic-testnet", name: "Sonic Testnet", chainId: 14601, domain: 13, fast: false,
        usdc: "0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51",
        rpcs: ["https://rpc.testnet.soniclabs.com"],
        explorer: "https://testnet.sonicscan.org", native: { name: "Sonic", symbol: "S", decimals: 18 } },
      { key: "monad-testnet", name: "Monad Testnet", chainId: 10143, domain: 15, fast: false,
        usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
        rpcs: ["https://testnet-rpc.monad.xyz"],
        explorer: "https://testnet.monadexplorer.com", native: { name: "Monad", symbol: "MON", decimals: 18 } },
      { key: "ink-sepolia", name: "Ink Sepolia", chainId: 763373, domain: 21, fast: true,
        usdc: "0xFabab97dCE620294D2B0b0e46C68964e326300Ac",
        rpcs: ["https://rpc-gel-sepolia.inkonchain.com"],
        explorer: "https://explorer-sepolia.inkonchain.com", native: ETH },
    ],
  };

  // "Pay with" shortlist: the source chain's native coin and USDC always, then these symbols
  // if LI.FI lists them on that chain (in this order).
  const PAY_SYMBOLS = ["WETH", "USDT", "DAI", "cbBTC", "WBTC", "EURC", "cbETH", "wstETH", "weETH",
    "USDbC", "AERO", "VIRTUAL", "DEGEN", "BRETT", "ARB", "OP", "LINK", "UNI", "AAVE", "PEPE", "WPOL", "WAVAX", "WS", "WMON"];

  const ABI = {
    erc20: [
      "function approve(address spender, uint256 value) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
      "function balanceOf(address owner) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ],
    tokenMessenger: [
      "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
    ],
    messageTransmitter: [
      "function receiveMessage(bytes message, bytes attestation) returns (bool)",
    ],
  };

  // ------------------------------------------------------------------ helpers

  const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  const isAddress = (a) => ADDR_RE.test(String(a || ""));
  const sameAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const isNative = (a) => sameAddr(a, NATIVE);

  /** EVM address -> bytes32 mintRecipient. Strict: a malformed recipient is not a failed
   *  transaction, it is USDC minted to an address nobody controls. */
  function toBytes32Address(addr) {
    if (!isAddress(addr)) throw new Error("mintRecipient must be a 20-byte hex address: " + addr);
    return "0x" + "0".repeat(24) + String(addr).slice(2).toLowerCase();
  }

  /** "10" / "10.5" -> minor units as BigInt for a token with `decimals`. Throws on junk. */
  function parseUnits(input, decimals = USDC_DECIMALS) {
    const s = String(input ?? "").trim().replace(",", ".");
    if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") throw new Error("invalid amount");
    const [i, f = ""] = s.split(".");
    if (f.length > decimals) throw new Error("max " + decimals + " decimals");
    return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals));
  }
  const parseUsdc = (input) => parseUnits(input, USDC_DECIMALS);

  /** minor units -> "12.34" (trims trailing zeros, keeps at least 2 decimals) */
  function formatUnits(minor, decimals = USDC_DECIMALS, maxDecimals = 6) {
    const n = BigInt(minor);
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const base = 10n ** BigInt(decimals);
    const i = abs / base;
    let f = (abs % base).toString().padStart(decimals, "0").slice(0, maxDecimals);
    f = f.replace(/0+$/, "");
    if (f.length < 2) f = f.padEnd(2, "0");
    return (neg ? "-" : "") + i.toString() + "." + f;
  }
  const formatUsdc = (minor, maxDecimals = 6) => formatUnits(minor, USDC_DECIMALS, maxDecimals);

  const padUint = (n) => BigInt(n).toString(16).padStart(64, "0");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

  /**
   * Fee quote maths, pure so it can be unit-tested.
   * fees = Iris /v2/burn/USDC/fees/{src}/{dst}?forward=true response (array).
   * Returns null when the route has no forwarding quote (forwarder not offered).
   */
  function computeFees(fees, amount, speed = "fast", headroom = 2n) {
    if (!Array.isArray(fees) || fees.length === 0) return null;
    const threshold = FINALITY[speed] ?? FINALITY.fast;
    const tier = fees.find((f) => Number(f.finalityThreshold) === threshold) ?? fees[0];
    const amt = BigInt(amount);
    // minimumFee is in basis points (may be fractional, e.g. 0.325 bps)
    const bps = Number(tier.minimumFee ?? 0);
    const protocolFee = BigInt(Math.ceil(Number(amt) * bps / 10_000));
    const fw = tier.forwardFee ?? {};
    const forwardFee = BigInt(fw.high ?? fw.med ?? fw.medium ?? fw.low ?? 0);
    if (forwardFee === 0n) return null;
    const expectedFee = protocolFee + forwardFee;
    const maxFee = expectedFee * headroom; // cap only; the actual fee charged is expectedFee-ish
    return {
      speed,
      minFinalityThreshold: Number(tier.finalityThreshold ?? threshold),
      protocolFee,
      forwardFee,
      expectedFee,
      maxFee,
      expectedReceive: amt > expectedFee ? amt - expectedFee : 0n,
      minReceive: amt > maxFee ? amt - maxFee : 0n,
      feeBps: bps,
    };
  }

  /** Turn LI.FI's terse refusals into something a user can act on. */
  function explainLifi(reason, src, network) {
    const r = String(reason || "");
    if (/rate limit/i.test(r)) return "LI.FI's public rate limit was hit. Wait a moment, or give the kit a LI.FI API key (lifiApiKey).";
    if (/no available quotes/i.test(r)) {
      return network === "testnet"
        ? "LI.FI has no swap for that amount on " + src.name + ". Testnet pools are shallow: try a smaller amount (0.001–0.002 " + src.native.symbol + "), or pay with USDC."
        : "LI.FI found no swap into USDC for that amount on " + src.name + " within a 10% price impact. Try a smaller amount or pay with USDC.";
    }
    if (/could not find token/i.test(r)) return "LI.FI does not list that token on " + src.name + ". Pay with USDC to bridge directly.";
    if (/not supported|allowed values/i.test(r)) return "LI.FI does not serve " + src.name + ". Pay with USDC to bridge over CCTP.";
    return "No LI.FI swap into USDC on " + src.name + ": " + r;
  }

  /** LI.FI transactionRequest -> ethers TransactionRequest (drop legacy gasPrice, keep gasLimit). */
  function toTxRequest(t) {
    if (!t || !t.to || !t.data) throw new Error("LI.FI quote has no transactionRequest");
    const req = { to: t.to, data: t.data };
    if (t.value != null) req.value = BigInt(t.value);
    if (t.gasLimit != null) req.gasLimit = BigInt(t.gasLimit);
    if (t.chainId != null) req.chainId = Number(t.chainId);
    return req;
  }

  /** LI.FI token list for a chain -> the "pay with" shortlist (native first, USDC second). */
  function payShortlist(tokens, chain) {
    const list = Array.isArray(tokens) ? tokens : [];
    const native = list.find((t) => isNative(t.address)) || { address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals };
    const usdc = { address: chain.usdc, symbol: "USDC", name: "USD Coin", decimals: USDC_DECIMALS };
    const out = [native, usdc];
    for (const sym of PAY_SYMBOLS) {
      const t = list.find((x) => x.symbol === sym && !isNative(x.address) && !sameAddr(x.address, chain.usdc));
      if (t) out.push({ address: t.address, symbol: t.symbol, name: t.name, decimals: Number(t.decimals) });
    }
    return out;
  }

  // ------------------------------------------------------------------ JSON-RPC (read-only)

  async function jsonRpc(url, method, params = [], timeoutMs = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const j = await res.json();
      if (j.error) return null;
      return j.result ?? null;
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  /** Try each RPC in order; first non-null result wins. */
  async function rpcAny(urls, method, params) {
    for (const u of urls || []) {
      const r = await jsonRpc(u, method, params);
      if (r != null) return r;
    }
    return null;
  }

  async function erc20Balance(urls, token, owner) {
    const r = await rpcAny(urls, "eth_call", [{ to: token, data: "0x70a08231" + padUint(BigInt(owner)) }, "latest"]);
    return r ? BigInt(r) : null;
  }

  async function fetchJson(url, timeoutMs = 10000, headers = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers });
      const j = await res.json().catch(() => null);
      if (!res.ok) return j && j.message ? { error: j.message, code: j.code } : null;
      return j;
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------------ storage

  function makeStorage(custom) {
    if (custom) return custom;
    try {
      if (typeof localStorage !== "undefined") {
        return {
          get: (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
          set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
        };
      }
    } catch {}
    const mem = new Map();
    return { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  }

  // ------------------------------------------------------------------ core

  /**
   * Headless engine. Works in the browser (EIP-1193 provider) and in Node (ethers Signer).
   *
   * opts:
   *   ethers        ethers v6 namespace (required)
   *   network       "mainnet" | "testnet" (default "testnet")
   *   provider      EIP-1193 provider (MetaMask, Web3Auth, ...). Optional if `signer` given.
   *   signer        ethers Signer already bound to the source chain (Node / custom flows)
   *   arcRpcs       override Arc read RPCs (e.g. from anewone config.js)
   *   arcExplorer   override Arc explorer
   *   sources       override / filter the source chain list (array of chain configs or keys)
   *   switchChain   async (chainCfg) => void — custom chain switching (Web3Auth etc.)
   *   storage       { get(k), set(k,v) } — defaults to localStorage
   *   feeHeadroom   BigInt multiplier applied to the quoted CCTP fee for maxFee (default 2n)
   *   minAmount     BigInt USDC minor units (default 1 USDC)
   *   router        "auto" (LI.FI route into Arc when it exists, else CCTP) | "cctp" | "lifi"
   *   lifiApiKey    optional LI.FI partner key (higher rate limits)
   *   lifiApi       base URL for LI.FI calls (default https://li.quest/v1). Point it at your own
   *                 proxy that adds the key server-side, so the key never ships to browsers.
   *   slippage      swap slippage as a fraction (default 0.005 = 0.5%)
   *
   * LI.FI without a key allows ~200 requests per 2 hours per IP, so the engine is thrifty:
   * quotes are cached 45 s, the Arc-route probe 30 min, and a 429 pauses LI.FI calls for 10 min.
   */
  class ArcBridge {
    constructor(opts = {}) {
      if (!opts.ethers) throw new Error("ArcBridge: pass ethers v6 as opts.ethers");
      this.ethers = opts.ethers;
      this.network = opts.network === "mainnet" ? "mainnet" : "testnet";
      this.cctp = CCTP[this.network];
      this.arc = { ...ARC[this.network] };
      if (opts.arcRpcs && opts.arcRpcs.length) this.arc.rpcs = opts.arcRpcs.slice();
      if (opts.arcExplorer) this.arc.explorer = opts.arcExplorer;
      this.provider = opts.provider || null;
      this.signer = opts.signer || null;
      this.customSwitch = opts.switchChain || null;
      this.storage = makeStorage(opts.storage);
      this.feeHeadroom = opts.feeHeadroom ?? 2n;
      this.minAmount = opts.minAmount ?? 1_000_000n;
      this.router = opts.router || "auto";
      this.lifiApiKey = opts.lifiApiKey || null;
      this.lifiApi = (opts.lifiApi || LIFI.api).replace(/\/$/, "");
      this.slippage = opts.slippage ?? 0.005;
      this._lifiBlockedUntil = 0;   // set when LI.FI answers 429; no calls until then
      this._quoteCache = new Map();  // key -> { at, value }
      this.storageKey = "arcbridgekit:" + this.network + ":transfers";
      this._tokenCache = {};
      this._arcRouteCache = {};

      const all = SOURCES[this.network];
      if (Array.isArray(opts.sources) && opts.sources.length) {
        this.sourceList = opts.sources.map((s) => (typeof s === "string" ? all.find((c) => c.key === s) : s)).filter(Boolean);
      } else {
        this.sourceList = all.slice();
      }
    }

    // ---- discovery

    sources() { return this.sourceList; }
    source(keyOrChainId) {
      return this.sourceList.find((c) => c.key === keyOrChainId || c.chainId === Number(keyOrChainId)) || null;
    }
    explorerTx(cfg, hash) { return cfg.explorer ? cfg.explorer.replace(/\/$/, "") + "/tx/" + hash : ""; }
    explorerAddress(cfg, addr) { return cfg.explorer ? cfg.explorer.replace(/\/$/, "") + "/address/" + addr : ""; }

    // ---- LI.FI

    _lifiHeaders() { return this.lifiApiKey ? { "x-lifi-api-key": this.lifiApiKey } : {}; }

    /** Tokens LI.FI can swap on a chain, cached per session. */
    async lifiTokens(chainId) {
      if (this._tokenCache[chainId]) return this._tokenCache[chainId];
      const j = await fetchJson(`${this.lifiApi}/tokens?chains=${chainId}`, 12000, this._lifiHeaders());
      const list = (j && j.tokens && j.tokens[String(chainId)]) || [];
      this._tokenCache[chainId] = list;
      return list;
    }

    /** "Pay with" shortlist for a source chain. */
    async payTokens(source) {
      const src = typeof source === "object" ? source : this.source(source);
      return payShortlist(await this.lifiTokens(src.chainId), src);
    }

    /**
     * One LI.FI quote. fromChain === toChain is a swap; different chains a route. Returns
     * { available, quote, toAmount, toAmountMin, approvalAddress, tx, tool, estSeconds, gasUsd, feeUsd }
     * or { available: false, reason }.
     */
    async lifiQuote({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, toAddress, order }) {
      if (Date.now() < this._lifiBlockedUntil) return { available: false, reason: "Rate limit exceeded (paused)" };
      const from = isAddress(fromAddress) ? fromAddress.toLowerCase() : "0x000000000000000000000000000000000000dead";
      const key = [fromChain, toChain, fromToken, toToken, String(fromAmount), from, toAddress || "", order || ""].join("|").toLowerCase();
      const hit = this._quoteCache.get(key);
      if (hit && Date.now() - hit.at < 45_000) return hit.value;
      const q = new URLSearchParams({
        fromChain: String(fromChain), toChain: String(toChain), fromToken, toToken,
        fromAddress: from, fromAmount: String(fromAmount), slippage: String(this.slippage),
        integrator: LIFI.integrator,
      });
      if (toAddress && isAddress(toAddress)) q.set("toAddress", toAddress.toLowerCase());
      if (order) q.set("order", order);
      const j = await fetchJson(`${this.lifiApi}/quote?${q}`, 15000, this._lifiHeaders());
      let value;
      if (!j) value = { available: false, reason: "LI.FI did not answer" };
      else if (j.error || !j.estimate) {
        const reason = j.error || j.message || "no LI.FI route";
        if (/rate limit/i.test(reason)) this._lifiBlockedUntil = Date.now() + 10 * 60_000;
        value = { available: false, reason };
      } else {
        const e = j.estimate;
        value = {
          available: true, quote: j, tool: j.tool, type: j.type,
          toAmount: BigInt(e.toAmount), toAmountMin: BigInt(e.toAmountMin || e.toAmount),
          approvalAddress: e.approvalAddress || null, tx: toTxRequest(j.transactionRequest),
          estSeconds: Number(e.executionDuration || 0),
          gasUsd: (e.gasCosts || []).reduce((s, g) => s + Number(g.amountUSD || 0), 0),
          feeUsd: (e.feeCosts || []).reduce((s, f) => s + Number(f.amountUSD || 0), 0),
        };
      }
      // a swap that is about to be sent must be fresh: bridge() clears the cache first
      this._quoteCache.set(key, { at: Date.now(), value });
      if (this._quoteCache.size > 50) this._quoteCache.delete(this._quoteCache.keys().next().value);
      return value;
    }

    /** Same-chain swap quote into USDC on `source`. */
    async quoteSwap(source, fromToken, fromAmount, fromAddress) {
      const src = typeof source === "object" ? source : this.source(source);
      if (sameAddr(fromToken, src.usdc)) return { available: true, identity: true, toAmount: BigInt(fromAmount), toAmountMin: BigInt(fromAmount) };
      return this.lifiQuote({ fromChain: src.chainId, toChain: src.chainId, fromToken, toToken: src.usdc, fromAmount, fromAddress });
    }

    /**
     * Does LI.FI route this source chain into Arc yet? Probed with a real quote (cheap, cached
     * 10 min). When it does, router "auto" takes the LI.FI route (any token in, USDC on Arc out).
     */
    async arcRouteAvailable(source, fromAddress) {
      const src = typeof source === "object" ? source : this.source(source);
      const c = this._arcRouteCache[src.chainId];
      if (c && Date.now() - c.at < 1_800_000) return c.ok;
      const r = await this.lifiQuote({ fromChain: src.chainId, toChain: this.arc.chainId, fromToken: src.usdc,
        toToken: this.arc.usdc, fromAmount: 5_000_000n, fromAddress });
      this._arcRouteCache[src.chainId] = { at: Date.now(), ok: !!r.available };
      return !!r.available;
    }

    // ---- quotes (no wallet needed)

    /** CCTP fee quote for `amount` USDC minor units from `source`. */
    async quote(source, amount, speed = "fast") {
      const src = typeof source === "object" ? source : this.source(source);
      if (!src) throw new Error("unknown source chain");
      const url = `${this.cctp.iris}/v2/burn/USDC/fees/${src.domain}/${ARC_DOMAIN}?forward=true`;
      const fees = await fetchJson(url);
      const q = computeFees(fees, amount, src.fast ? speed : "standard", this.feeHeadroom);
      if (!q) return { available: false, reason: "Circle is not quoting a forwarded route from " + src.name + " to Arc right now." };
      return { available: true, router: "cctp", source: src, amount: BigInt(amount), ...q,
        estSeconds: q.minFinalityThreshold === FINALITY.fast ? 20 : (src.domain === 0 ? 900 : 120) };
    }

    /**
     * Full plan for "pay `fromAmount` of `payToken` on `source`, land USDC on Arc":
     *  { router: "cctp"|"lifi", swap?, bridge, usdcIn, expectedReceive, estSeconds, ... }
     */
    async plan({ source, payToken, fromAmount, speed = "fast", fromAddress, recipient }) {
      const src = typeof source === "object" ? source : this.source(source);
      if (!src) throw new Error("unknown source chain");
      const token = payToken || src.usdc;
      const amt = BigInt(fromAmount);

      // Route straight into Arc via LI.FI when it exists (or is forced)
      if (this.router === "lifi" || (this.router === "auto" && await this.arcRouteAvailable(src, fromAddress))) {
        const r = await this.lifiQuote({ fromChain: src.chainId, toChain: this.arc.chainId, fromToken: token,
          toToken: this.arc.usdc, fromAmount: amt, fromAddress, toAddress: recipient });
        if (r.available) {
          return { available: true, router: "lifi", source: src, payToken: token, fromAmount: amt, lifi: r,
            usdcIn: r.toAmount, expectedReceive: r.toAmount, minReceive: r.toAmountMin, estSeconds: r.estSeconds || 60,
            protocolFee: 0n, forwardFee: 0n, expectedFee: 0n };
        }
        if (this.router === "lifi") return { available: false, reason: r.reason };
      }

      // Otherwise: optional LI.FI swap to USDC, then CCTP
      let swap = null, usdcIn = amt;
      if (!sameAddr(token, src.usdc)) {
        swap = await this.quoteSwap(src, token, amt, fromAddress);
        if (!swap.available) return { available: false, reason: explainLifi(swap.reason, src, this.network) };
        usdcIn = swap.toAmountMin; // plan on the guaranteed minimum; the real amount is measured after the swap
      }
      if (usdcIn < this.minAmount) return { available: false, reason: "That is less than " + formatUsdc(this.minAmount) + " USDC after the swap." };
      const bridge = await this.quote(src, usdcIn, speed);
      if (!bridge.available) return bridge;
      if (bridge.maxFee >= usdcIn) return { available: false, reason: "amount too small to cover bridge fees (max " + formatUsdc(bridge.maxFee) + " USDC)" };
      return { available: true, router: "cctp", source: src, payToken: token, fromAmount: amt, swap, bridge, usdcIn,
        expectedReceive: bridge.expectedReceive, minReceive: bridge.minReceive,
        protocolFee: bridge.protocolFee, forwardFee: bridge.forwardFee, expectedFee: bridge.expectedFee,
        estSeconds: bridge.estSeconds + (swap ? 15 : 0) };
    }

    // ---- balances

    async usdcBalance(source, owner) {
      const src = typeof source === "object" ? source : this.source(source);
      return erc20Balance(src.rpcs, src.usdc, owner);
    }
    async tokenBalance(source, token, owner) {
      const src = typeof source === "object" ? source : this.source(source);
      if (isNative(token)) return this.nativeBalance(src, owner);
      return erc20Balance(src.rpcs, token, owner);
    }
    async arcUsdcBalance(owner) {
      if (!this.arc.rpcs.length) return null;
      return erc20Balance(this.arc.rpcs, this.arc.usdc, owner);
    }
    async nativeBalance(source, owner) {
      const r = await rpcAny(source.rpcs, "eth_getBalance", [owner, "latest"]);
      return r ? BigInt(r) : null;
    }

    // ---- wallet plumbing

    async currentChainId() {
      if (this.signer) { const n = await this.signer.provider.getNetwork(); return Number(n.chainId); }
      const hex = await this.provider.request({ method: "eth_chainId" });
      return Number(BigInt(hex));
    }

    async account() {
      if (this.signer) return await this.signer.getAddress();
      const accts = await this.provider.request({ method: "eth_accounts" });
      return accts && accts[0] ? this.ethers.getAddress(accts[0]) : null;
    }

    async requestAccount() {
      if (this.signer) return this.account();
      const accts = await this.provider.request({ method: "eth_requestAccounts" });
      return accts && accts[0] ? this.ethers.getAddress(accts[0]) : null;
    }

    /** Switch the wallet to `cfg` (source chain or Arc). Adds the chain if unknown. */
    async ensureChain(cfg) {
      if (this.signer) {
        const id = await this.currentChainId();
        if (id !== cfg.chainId) throw new Error("signer is on chain " + id + ", expected " + cfg.chainId);
        return;
      }
      if (this.customSwitch) { await this.customSwitch(cfg); return; }
      const hex = "0x" + cfg.chainId.toString(16);
      if ((await this.currentChainId()) === cfg.chainId) return;
      try {
        await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch (e) {
        const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
        const unknown = code === 4902 || /unrecognized|not added|Unrecognized chain/i.test(String(e && e.message));
        if (!unknown) throw e;
        if (!cfg.rpcs || !cfg.rpcs.length) throw new Error(cfg.name + " is not in the wallet and no public RPC is configured to add it.");
        await this.provider.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hex, chainName: cfg.name, nativeCurrency: cfg.native,
            rpcUrls: cfg.rpcs, blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [] }],
        });
        await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      }
      // some wallets resolve before the chain actually flips
      for (let i = 0; i < 20; i++) {
        if ((await this.currentChainId()) === cfg.chainId) return;
        await sleep(250);
      }
      throw new Error("wallet did not switch to " + cfg.name);
    }

    async _signer() {
      if (this.signer) return this.signer;
      const bp = new this.ethers.BrowserProvider(this.provider, "any");
      return bp.getSigner();
    }

    async _ensureAllowance(signer, token, owner, spender, amount, onStep, label) {
      const erc = new this.ethers.Contract(token, ABI.erc20, signer);
      const allowance = await erc.allowance(owner, spender);
      if (allowance >= amount) return null;
      onStep({ step: "approving", amount, token, spender, label });
      const tx = await erc.approve(spender, amount);
      onStep({ step: "approve_sent", hash: tx.hash, label });
      const rc = await tx.wait();
      if (!rc || rc.status !== 1) throw new Error("approval reverted");
      onStep({ step: "approved", hash: tx.hash, label });
      return tx.hash;
    }

    // ---- persistence

    transfers() { return this.storage.get(this.storageKey) || []; }
    pending() {
      return this.transfers().filter((t) =>
        !["failed", "dismissed"].includes(t.status) &&
        !(t.status === "minted" && (!t.dest || t.dest.status === "done")));
    }
    _save(tr) {
      const list = this.transfers();
      const i = list.findIndex((t) => t.id === tr.id);
      if (i >= 0) list[i] = tr; else list.unshift(tr);
      this.storage.set(this.storageKey, list.slice(0, 50));
      return tr;
    }
    dismiss(id) {
      const tr = this.transfers().find((t) => t.id === id);
      if (tr) { tr.status = "dismissed"; this._save(tr); }
    }

    // ---- the flow

    /**
     * Pay `fromAmount` of `payToken` (default USDC) on `source`; USDC lands at `recipient` on Arc.
     * onStep({ step, ... }): switching, planning, approving/approve_sent/approved (label swap|bridge|lifi),
     *   swapping, swap_sent, swapped, burning, burn_sent, burned, lifi_sending, lifi_sent.
     * Resolves with the persisted transfer once the source-chain transaction is mined; then track().
     */
    async bridge({ source, amount, payToken, recipient, speed = "fast", dest = false, onStep = () => {} }) {
      const src = typeof source === "object" ? source : this.source(source);
      if (!src) throw new Error("unknown source chain");
      const token = payToken || src.usdc;
      const amt = BigInt(amount);
      const mintRecipient = toBytes32Address(recipient);

      onStep({ step: "switching", chain: src });
      await this.ensureChain(src);
      const signer = await this._signer();
      const owner = await signer.getAddress();

      onStep({ step: "planning" });
      this._quoteCache.clear(); // never send a 45 s old swap route
      const plan = await this.plan({ source: src, payToken: token, fromAmount: amt, speed, fromAddress: owner, recipient });
      if (!plan.available) throw new Error(plan.reason);

      const bal = await this.tokenBalance(src, token, owner);
      if (bal != null && bal < amt) throw new Error("balance on " + src.name + " is too low for " + amt.toString() + " minor units of the pay token");

      const tr = this._save({
        id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), network: this.network,
        router: plan.router, sourceKey: src.key, sourceChainId: src.chainId, sourceDomain: src.domain,
        payToken: token, payAmount: amt.toString(), recipient: this.ethers.getAddress(recipient), sender: owner,
        speed, dest: dest ? { status: "pending" } : undefined, status: "planned", startedAt: Date.now(),
      });

      // ---- router "lifi": one route from any token straight into Arc
      if (plan.router === "lifi") {
        if (!isNative(token)) await this._ensureAllowance(signer, token, owner, plan.lifi.approvalAddress, amt, onStep, "lifi");
        onStep({ step: "lifi_sending", tool: plan.lifi.tool });
        const tx = await signer.sendTransaction(plan.lifi.tx);
        tr.status = "sending"; tr.sendTx = tx.hash; tr.burnTx = tx.hash; tr.amount = plan.usdcIn.toString();
        tr.expectedFee = "0"; tr.tool = plan.lifi.tool; this._save(tr);
        onStep({ step: "lifi_sent", hash: tx.hash, url: this.explorerTx(src, tx.hash), transfer: tr });
        const rc = await tx.wait();
        if (!rc || rc.status !== 1) { tr.status = "failed"; tr.error = "route tx reverted"; this._save(tr); throw new Error("LI.FI transaction reverted"); }
        tr.status = "sent"; tr.sentAt = Date.now(); this._save(tr);
        onStep({ step: "burned", hash: tx.hash, transfer: tr });
        return tr;
      }

      // ---- leg 1: swap into USDC on the source chain (LI.FI)
      let usdcAmount = amt;
      if (plan.swap && !plan.swap.identity) {
        const usdc = new this.ethers.Contract(src.usdc, ABI.erc20, signer);
        const before = await usdc.balanceOf(owner);
        if (!isNative(token)) await this._ensureAllowance(signer, token, owner, plan.swap.approvalAddress, amt, onStep, "swap");
        onStep({ step: "swapping", tool: plan.swap.tool, expected: plan.swap.toAmount });
        const tx = await signer.sendTransaction(plan.swap.tx);
        tr.status = "swapping"; tr.swapTx = tx.hash; this._save(tr);
        onStep({ step: "swap_sent", hash: tx.hash, url: this.explorerTx(src, tx.hash), transfer: tr });
        const rc = await tx.wait();
        if (!rc || rc.status !== 1) { tr.status = "failed"; tr.error = "swap reverted"; this._save(tr); throw new Error("swap reverted"); }
        const after = await usdc.balanceOf(owner);
        usdcAmount = after - before;
        if (usdcAmount <= 0n) usdcAmount = plan.swap.toAmountMin; // could not read the delta; bridge the guaranteed minimum
        tr.status = "swapped"; tr.amount = usdcAmount.toString(); this._save(tr);
        onStep({ step: "swapped", hash: tx.hash, usdc: usdcAmount, transfer: tr });
      }

      // ---- leg 2: CCTP burn with forwarding
      return this._cctpLeg(tr, src, signer, owner, usdcAmount, mintRecipient, speed, onStep);
    }

    async _cctpLeg(tr, src, signer, owner, usdcAmount, mintRecipient, speed, onStep) {
      const q = await this.quote(src, usdcAmount, speed);
      if (!q.available) throw new Error(q.reason);
      if (q.maxFee >= usdcAmount) throw new Error("amount too small to cover fees (max fee " + formatUsdc(q.maxFee) + " USDC)");
      const usdc = new this.ethers.Contract(src.usdc, ABI.erc20, signer);
      const bal = await usdc.balanceOf(owner);
      if (bal < usdcAmount) throw new Error("USDC balance on " + src.name + " is " + formatUsdc(bal) + ", need " + formatUsdc(usdcAmount));
      await this._ensureAllowance(signer, src.usdc, owner, this.cctp.tokenMessenger, usdcAmount, onStep, "bridge");

      const tm = new this.ethers.Contract(this.cctp.tokenMessenger, ABI.tokenMessenger, signer);
      onStep({ step: "burning", amount: usdcAmount, maxFee: q.maxFee });
      const tx = await tm.depositForBurnWithHook(
        usdcAmount, ARC_DOMAIN, mintRecipient, src.usdc, ZERO32, q.maxFee, q.minFinalityThreshold, FORWARD_HOOK
      );
      tr.burnTx = tx.hash; tr.amount = usdcAmount.toString(); tr.expectedFee = q.expectedFee.toString();
      tr.maxFee = q.maxFee.toString(); tr.status = "burning"; this._save(tr);
      onStep({ step: "burn_sent", hash: tx.hash, url: this.explorerTx(src, tx.hash), transfer: tr });
      const rc = await tx.wait();
      if (!rc || rc.status !== 1) { tr.status = "failed"; tr.error = "burn reverted"; this._save(tr); throw new Error("burn reverted"); }
      tr.status = "burned"; tr.burnedAt = Date.now(); this._save(tr);
      onStep({ step: "burned", hash: tx.hash, transfer: tr });
      return tr;
    }

    /** Resume a transfer that swapped into USDC but never burned (page closed in between). */
    async continueBridge(tr, onStep = () => {}) {
      if (tr.status !== "swapped") throw new Error("nothing to continue");
      const src = this.source(tr.sourceKey);
      onStep({ step: "switching", chain: src });
      await this.ensureChain(src);
      const signer = await this._signer();
      const owner = await signer.getAddress();
      return this._cctpLeg(tr, src, signer, owner, BigInt(tr.amount), toBytes32Address(tr.recipient), tr.speed || "fast", onStep);
    }

    /** Iris message lookup for a burn tx. */
    async message(tr) {
      const j = await fetchJson(`${this.cctp.iris}/v2/messages/${tr.sourceDomain}?transactionHash=${tr.burnTx}`);
      return (j && j.messages && j.messages[0]) || null;
    }

    /** LI.FI status for a route transaction. */
    async lifiStatus(tr) {
      const q = new URLSearchParams({ txHash: tr.sendTx || tr.burnTx, fromChain: String(tr.sourceChainId), toChain: String(this.arc.chainId) });
      return fetchJson(`${this.lifiApi}/status?${q}`, 12000, this._lifiHeaders());
    }

    /**
     * Follow a source-chain transaction to the USDC landing on Arc.
     * onStep: attesting, attested, forwarding, minted, stalled (CCTP) / routing, minted, failed (LI.FI).
     */
    async track(tr, onStep = () => {}, opts = {}) {
      const stallAfter = opts.stallAfterMs ?? 10 * 60_000;
      const pollMs = opts.pollMs ?? 4000;
      const startBal = tr.arcStartBalance != null ? BigInt(tr.arcStartBalance)
        : (await this.arcUsdcBalance(tr.recipient));
      if (tr.arcStartBalance == null && startBal != null) { tr.arcStartBalance = startBal.toString(); this._save(tr); }

      if (tr.router === "lifi") {
        if (["sending", "sent"].includes(tr.status)) { tr.status = "routing"; this._save(tr); }
        onStep({ step: "routing", transfer: tr });
        for (;;) {
          if (opts.signal && opts.signal.aborted) return tr;
          const s = await this.lifiStatus(tr);
          const bal = await this.arcUsdcBalance(tr.recipient);
          const landed = (bal != null && startBal != null && bal > startBal) || (s && s.status === "DONE");
          if (s && s.receiving && s.receiving.txHash && !tr.mintTx) { tr.mintTx = s.receiving.txHash; this._save(tr); }
          if (landed) {
            tr.status = "minted"; tr.mintedAt = Date.now();
            if (bal != null && startBal != null) tr.received = (bal - startBal).toString();
            else if (s && s.receiving && s.receiving.amount) tr.received = String(s.receiving.amount);
            this._save(tr); onStep({ step: "minted", transfer: tr }); return tr;
          }
          if (s && s.status === "FAILED") { tr.status = "failed"; tr.error = s.substatus || "route failed"; this._save(tr); onStep({ step: "failed", transfer: tr }); return tr; }
          await sleep(pollMs);
        }
      }

      if (tr.status === "burning" || tr.status === "burned") { tr.status = "attesting"; this._save(tr); }
      onStep({ step: tr.status, transfer: tr });

      for (;;) {
        if (opts.signal && opts.signal.aborted) return tr;
        const msg = await this.message(tr);
        if (msg) {
          const attested = msg.status === "complete" && msg.attestation && msg.attestation !== "PENDING";
          if (attested && !tr.attestation) {
            tr.attestation = msg.attestation; tr.message = msg.message;
            tr.attestedAt = Date.now(); tr.status = "forwarding"; this._save(tr);
            onStep({ step: "attested", transfer: tr });
          }
          if (msg.forwardState != null && msg.forwardState !== tr.forwardState) {
            tr.forwardState = msg.forwardState; this._save(tr);
            onStep({ step: "forwarding", transfer: tr, forwardState: msg.forwardState });
          }
          const mintTx = msg.forwardTransactionHash || msg.destinationTransactionHash || (msg.forward && msg.forward.transactionHash);
          if (mintTx && !tr.mintTx) { tr.mintTx = mintTx; this._save(tr); }
        }

        // The balance on Arc is the ground truth, whatever the forwarder reports.
        const bal = await this.arcUsdcBalance(tr.recipient);
        const minted = (bal != null && startBal != null && bal > startBal) || tr.forwardState === "completed";
        if (minted) {
          tr.status = "minted"; tr.mintedAt = Date.now();
          if (bal != null && startBal != null) tr.received = (bal - startBal).toString();
          this._save(tr);
          onStep({ step: "minted", transfer: tr });
          return tr;
        }

        if (tr.attestation && Date.now() - tr.attestedAt > stallAfter && tr.status !== "stalled") {
          tr.status = "stalled"; this._save(tr);
          onStep({ step: "stalled", transfer: tr });
          if (opts.returnOnStall !== false) return tr;
        }
        await sleep(pollMs);
      }
    }

    /**
     * Last resort for CCTP: mint the attested message on Arc from the user's wallet (needs a
     * little USDC for gas on Arc). Only possible once `tr.attestation` is set.
     */
    async manualMint(tr, onStep = () => {}) {
      if (!tr.message || !tr.attestation) throw new Error("transfer is not attested yet");
      onStep({ step: "switching", chain: this.arc });
      await this.ensureChain(this.arc);
      const signer = await this._signer();
      const mt = new this.ethers.Contract(this.cctp.messageTransmitter, ABI.messageTransmitter, signer);
      onStep({ step: "minting" });
      const tx = await mt.receiveMessage(tr.message, tr.attestation);
      onStep({ step: "mint_sent", hash: tx.hash, url: this.explorerTx(this.arc, tx.hash) });
      const rc = await tx.wait();
      if (!rc || rc.status !== 1) throw new Error("receiveMessage reverted (already minted?)");
      tr.status = "minted"; tr.mintTx = tx.hash; tr.mintedAt = Date.now(); this._save(tr);
      onStep({ step: "minted", transfer: tr });
      return tr;
    }

    /** USDC minor units (6 dec) that landed on Arc for this transfer. */
    receivedOf(tr) {
      return BigInt(tr.received || (BigInt(tr.amount || 0) - BigInt(tr.expectedFee || 0)));
    }

    /**
     * Optional last leg on Arc once the USDC has landed, e.g. a launchpad buy. The host builds
     * the transaction; the kit switches the wallet to Arc, sends it and records the outcome so
     * a refresh can resume or retry it.
     *
     * destination.build({ transfer, received, signer, ethers, arc }) -> ethers TransactionRequest
     *   `received` is BigInt USDC minor units (6 dec). USDC is Arc's native token with 18
     *   decimals at the RPC level, so a payable call wants `received * 10n ** 12n` (minus gas).
     * onStep: switching, dest_building, dest_sending, dest_sent, dest_done
     */
    async runDestination(tr, destination, onStep = () => {}) {
      if (tr.status !== "minted") throw new Error("USDC has not landed on Arc yet");
      if (!destination || typeof destination.build !== "function") throw new Error("destination.build missing");
      const received = this.receivedOf(tr);
      tr.dest = { ...(tr.dest || {}), status: "pending" }; this._save(tr);
      onStep({ step: "switching", chain: this.arc });
      await this.ensureChain(this.arc);
      const signer = await this._signer();
      onStep({ step: "dest_building", received });
      const req = await destination.build({ transfer: tr, received, signer, ethers: this.ethers, arc: this.arc });
      if (!req || !req.to) throw new Error("destination.build returned no transaction");
      onStep({ step: "dest_sending" });
      const tx = await signer.sendTransaction(req);
      tr.dest = { status: "sent", tx: tx.hash, at: Date.now() }; this._save(tr);
      onStep({ step: "dest_sent", hash: tx.hash, url: this.explorerTx(this.arc, tx.hash) });
      const rc = await tx.wait();
      if (!rc || rc.status !== 1) { tr.dest.status = "failed"; this._save(tr); throw new Error("transaction on Arc reverted"); }
      tr.dest.status = "done"; tr.dest.minedAt = Date.now(); this._save(tr);
      onStep({ step: "dest_done", hash: tx.hash, url: this.explorerTx(this.arc, tx.hash), transfer: tr });
      return tr;
    }
  }

  // ------------------------------------------------------------------ UI

  const CSS = `
.abk{--abk-bg:var(--surface,#fff);--abk-bg2:var(--surface-2,#f1f1f3);--abk-text:var(--text,#111116);
  --abk-dim:var(--dim,#5f5f6d);--abk-faint:var(--faint,#8b8b98);--abk-border:var(--border,rgba(16,16,24,.09));
  --abk-border2:var(--border-2,rgba(16,16,24,.16));--abk-accent:var(--accent,#00b877);--abk-accent-soft:var(--accent-soft,#e8f9f1);
  --abk-red:var(--red,#e0334f);--abk-gold:var(--gold,#c88a00);--abk-r:var(--r-md,14px);--abk-rs:var(--r-sm,10px);
  --abk-mono:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  font:14px/1.45 var(--abk-font,'Inter',system-ui,sans-serif);color:var(--abk-text);background:var(--abk-bg);
  border:1px solid var(--abk-border);border-radius:var(--abk-r);padding:16px;max-width:440px;box-sizing:border-box}
.abk *{box-sizing:border-box}
.abk-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.abk-title{font-weight:600;font-size:15px}
.abk-badge{font:500 11px var(--abk-mono);padding:3px 8px;border-radius:999px;background:var(--abk-bg2);color:var(--abk-dim);border:1px solid var(--abk-border)}
.abk-badge.test{color:var(--abk-gold)}
.abk-row{display:flex;gap:8px;align-items:center;margin-top:10px}
.abk-label{font-size:12px;color:var(--abk-dim);margin-bottom:4px;display:flex;justify-content:space-between}
.abk-label b{font-weight:500;color:var(--abk-faint);cursor:pointer}
.abk-label b:hover{color:var(--abk-text)}
.abk-field{width:100%;background:var(--abk-bg2);border:1px solid var(--abk-border);border-radius:var(--abk-rs);
  padding:10px 12px;color:var(--abk-text);font:inherit;outline:none;appearance:none;-webkit-appearance:none}
.abk-field:focus{border-color:var(--abk-border2)}
.abk-amount{display:flex;align-items:center;background:var(--abk-bg2);border:1px solid var(--abk-border);border-radius:var(--abk-rs)}
.abk-amount input{flex:1;background:none;border:0;padding:10px 12px;font:600 18px var(--abk-mono);color:var(--abk-text);outline:none;min-width:0}
.abk-amount .abk-tok{position:relative;border-left:1px solid var(--abk-border)}
.abk-amount .abk-tok select{background:none;border:0;padding:10px 26px 10px 10px;font:600 13px inherit;font-family:inherit;color:var(--abk-text);outline:none;appearance:none;-webkit-appearance:none;cursor:pointer;max-width:120px}
.abk-amount .abk-tok:after{content:"";position:absolute;right:11px;top:50%;width:6px;height:6px;border-right:1.5px solid var(--abk-dim);border-bottom:1.5px solid var(--abk-dim);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.abk-amount button{margin:0 6px}
.abk-sel{position:relative}
.abk-sel:after{content:"";position:absolute;right:12px;top:50%;width:7px;height:7px;border-right:1.5px solid var(--abk-dim);border-bottom:1.5px solid var(--abk-dim);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.abk-seg{display:flex;background:var(--abk-bg2);border:1px solid var(--abk-border);border-radius:var(--abk-rs);padding:3px;gap:3px}
.abk-seg button{flex:1;border:0;background:none;color:var(--abk-dim);padding:7px 8px;border-radius:7px;font:inherit;font-size:13px;cursor:pointer}
.abk-seg button.on{background:var(--abk-bg);color:var(--abk-text);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:500}
.abk-seg button small{display:block;font-size:11px;color:var(--abk-faint)}
.abk-fees{margin-top:12px;font-size:12.5px;color:var(--abk-dim);display:grid;grid-template-columns:1fr auto;row-gap:4px}
.abk-fees .v{font-family:var(--abk-mono);color:var(--abk-text);text-align:right}
.abk-fees .tot{font-weight:600;color:var(--abk-text)}
.abk-fees .via{grid-column:1/-1;font-size:11.5px;color:var(--abk-faint)}
.abk-btn{width:100%;margin-top:14px;padding:12px;border:0;border-radius:var(--abk-rs);background:var(--abk-accent);color:#fff;font:600 14px inherit;font-family:inherit;cursor:pointer}
.abk-btn:disabled{opacity:.55;cursor:not-allowed}
.abk-btn.ghost{background:var(--abk-bg2);color:var(--abk-text);border:1px solid var(--abk-border)}
.abk-mini{padding:4px 8px;border-radius:7px;border:1px solid var(--abk-border);background:var(--abk-bg);color:var(--abk-dim);font:500 11px inherit;font-family:inherit;cursor:pointer}
.abk-mini:hover{color:var(--abk-text)}
.abk-note{margin-top:8px;font-size:12px;color:var(--abk-faint)}
.abk-err{margin-top:10px;font-size:12.5px;color:var(--abk-red);background:rgba(224,51,79,.08);border-radius:var(--abk-rs);padding:8px 10px;word-break:break-word}
.abk-steps{margin-top:14px;border-top:1px solid var(--abk-border);padding-top:12px;display:grid;gap:8px}
.abk-step{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--abk-faint)}
.abk-step .d{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--abk-border2);flex:none;display:grid;place-items:center;font-size:10px;margin-top:1px}
.abk-step.on{color:var(--abk-text)}
.abk-step.on .d{border-color:var(--abk-accent);color:var(--abk-accent)}
.abk-step.on .d:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--abk-accent);animation:abk-pulse 1s infinite alternate}
.abk-step.done{color:var(--abk-text)}
.abk-step.done .d{background:var(--abk-accent);border-color:var(--abk-accent);color:#fff}
.abk-step.done .d:before{content:"\\2713"}
.abk-step.err{color:var(--abk-red)}
.abk-step.err .d{border-color:var(--abk-red);color:var(--abk-red)}
.abk-step.err .d:before{content:"!"}
.abk-step a{color:var(--abk-accent);text-decoration:none;font-family:var(--abk-mono);font-size:12px}
.abk-step a:hover{text-decoration:underline}
.abk-step small{display:block;color:var(--abk-faint);font-size:11.5px}
@keyframes abk-pulse{from{opacity:.4}to{opacity:1}}
.abk-pend{margin-top:14px;border-top:1px solid var(--abk-border);padding-top:10px}
.abk-pend h4{margin:0 0 6px;font-size:12px;color:var(--abk-dim);font-weight:500}
.abk-pend .it{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;padding:6px 0}
.abk-pend .it span{font-family:var(--abk-mono)}
.abk-ok{margin-top:12px;padding:10px 12px;border-radius:var(--abk-rs);background:var(--abk-accent-soft);color:var(--abk-text);font-size:13px}
.abk-ok a{color:var(--abk-accent);font-family:var(--abk-mono);font-size:12px;text-decoration:none}
`;

  function stepsFor(plan, destination) {
    const s = [];
    if (plan && plan.router === "lifi") s.push({ key: "burn", label: "Send via LI.FI" }, { key: "attest", label: "Route to Arc" });
    else {
      if (plan && plan.swap && !plan.swap.identity) s.push({ key: "swap", label: "Swap to USDC on " + plan.source.name });
      s.push({ key: "approve", label: "Approve USDC" }, { key: "burn", label: "Burn on source chain" },
        { key: "attest", label: "Circle attestation" });
    }
    s.push({ key: "mint", label: "USDC on Arc" });
    if (destination) s.push({ key: "dest", label: destination.label || "Swap on Arc" });
    return s;
  }

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null) n.append(c);
    return n;
  }

  function injectCss() {
    if (typeof document === "undefined" || document.getElementById("abk-css")) return;
    const s = document.createElement("style");
    s.id = "abk-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  /**
   * Mount the widget.
   * opts (all of ArcBridge's, plus):
   *   getProvider   () => EIP-1193 provider (called lazily; may return a Promise)
   *   onConnect     async () => address — host's own connect flow (optional)
   *   recipient     string | () => string — default mint recipient (defaults to connected account)
   *   defaultSource key of the pre-selected chain (default: first in list)
   *   defaultAmount string, e.g. "10"
   *   payWith       "usdc" (USDC only, no swap leg) | "any" (default: LI.FI shortlist)
   *   onEvent       (evt) => void — mirrors every step for analytics / host UI
   *   onMinted      (transfer) => void
   *   destination   { label, build, auto=true, buttonLabel, doneLabel } — optional last leg on
   *                 Arc after the USDC lands (see ArcBridge.runDestination). With auto=true the
   *                 wallet is prompted as soon as the USDC lands; otherwise a button appears.
   *   onDestination (transfer) => void — fired when the destination leg is mined
   *   title         override header text
   */
  function mount(container, opts = {}) {
    if (!container) throw new Error("ArcBridgeKit.mount: container missing");
    injectCss();
    const state = {
      core: null, account: null, source: null, speed: "fast", plan: null, planning: null,
      busy: false, error: "", steps: {}, links: {}, done: null, balance: null, pendingTracked: new Set(),
      customRecipient: false, tokens: [], payToken: null, activePlan: null,
    };
    const emit = (e) => { try { opts.onEvent && opts.onEvent(e); } catch {} };

    const core = () => {
      if (state.core) return state.core;
      const provider = opts.provider || (opts.getProvider ? opts.getProvider() : (typeof window !== "undefined" ? window.ethereum : null));
      state.core = new ArcBridge({ ...opts, provider });
      return state.core;
    };
    const c0 = core();
    state.source = c0.source(opts.defaultSource) || c0.sources()[0];
    const payAny = opts.payWith !== "usdc";

    // ---- DOM
    const badge = el("span", { class: "abk-badge" + (c0.network === "testnet" ? " test" : "") }, c0.network === "testnet" ? "TESTNET" : "MAINNET");
    const title = el("div", { class: "abk-title" }, opts.title || "Bridge to " + c0.arc.name);
    const balLbl = el("b", { title: "Use full balance", onclick: () => { if (state.balance != null && state.payToken) { amountIn.value = formatUnits(state.balance, state.payToken.decimals, 6); onAmount(); } } }, "");
    const chainSel = el("select", { class: "abk-field", onchange: () => { state.source = c0.source(chainSel.value); state.balance = null; loadTokens().then(() => { refreshBalance(); replan(); }); } },
      c0.sources().map((s) => el("option", { value: s.key }, s.name)));
    chainSel.value = state.source.key;
    const amountIn = el("input", { inputmode: "decimal", placeholder: "0.00", value: opts.defaultAmount || "", oninput: () => onAmount() });
    const tokSel = el("select", { onchange: () => { state.payToken = state.tokens.find((t) => t.address === tokSel.value) || state.tokens[0]; state.balance = null; refreshBalance(); replan(); } });
    const tokWrap = el("div", { class: "abk-tok" }, tokSel);
    const maxBtn = el("button", { class: "abk-mini", onclick: () => balLbl.onclick() }, "MAX");
    const fastBtn = el("button", { class: "on", onclick: () => setSpeed("fast") }, ["Fast", el("small", {}, "~20 s")]);
    const stdBtn = el("button", { onclick: () => setSpeed("standard") }, ["Standard", el("small", {}, "no protocol fee")]);
    const seg = el("div", { class: "abk-seg" }, [fastBtn, stdBtn]);
    const feesBox = el("div", { class: "abk-fees" });
    const recipIn = el("input", { class: "abk-field", placeholder: "0x… recipient on Arc", style: "font-family:var(--abk-mono);font-size:12.5px", oninput: () => render() });
    const recipWrap = el("div", { style: "display:none;margin-top:10px" }, [el("div", { class: "abk-label" }, "Recipient on Arc"), recipIn]);
    const recipToggle = el("b", { onclick: () => { state.customRecipient = !state.customRecipient; recipWrap.style.display = state.customRecipient ? "" : "none"; if (!state.customRecipient) recipIn.value = ""; render(); } }, "send to another address");
    const btn = el("button", { class: "abk-btn", onclick: () => onMain() }, "Connect wallet");
    const errBox = el("div", { class: "abk-err", style: "display:none" });
    const okBox = el("div", { class: "abk-ok", style: "display:none" });
    const stepsBox = el("div", { class: "abk-steps", style: "display:none" });
    const pendBox = el("div", { class: "abk-pend", style: "display:none" });
    const note = el("div", { class: "abk-note" }, "Pay with what you have; USDC lands on Arc with no gas needed there. Swaps by LI.FI, bridging by Circle CCTP.");

    container.classList.add("abk");
    container.replaceChildren(
      el("div", { class: "abk-head" }, [title, badge]),
      el("div", {}, [el("div", { class: "abk-label" }, ["From", balLbl]), el("div", { class: "abk-sel" }, chainSel)]),
      el("div", { style: "margin-top:10px" }, [el("div", { class: "abk-label" }, ["Pay", recipToggle]),
        el("div", { class: "abk-amount" }, [amountIn, tokWrap, maxBtn])]),
      recipWrap,
      el("div", { style: "margin-top:10px" }, [el("div", { class: "abk-label" }, "Bridge speed"), seg]),
      feesBox, btn, note, errBox, okBox, stepsBox, pendBox
    );

    // ---- logic
    async function loadTokens() {
      const src = state.source;
      const usdcOnly = [{ address: src.usdc, symbol: "USDC", name: "USD Coin", decimals: USDC_DECIMALS }];
      state.tokens = payAny ? await c0.payTokens(src).catch(() => usdcOnly) : usdcOnly;
      if (state.source !== src) return; // user moved on while we were loading
      const keep = state.payToken && state.tokens.find((t) => t.symbol === state.payToken.symbol);
      state.payToken = keep || state.tokens.find((t) => t.symbol === "USDC") || state.tokens[0];
      tokSel.replaceChildren(...state.tokens.map((t) => el("option", { value: t.address }, t.symbol)));
      tokSel.value = state.payToken.address;
      render();
    }
    function recipient() {
      if (state.customRecipient) return recipIn.value.trim();
      const r = typeof opts.recipient === "function" ? opts.recipient() : opts.recipient;
      return r || state.account || "";
    }
    function setSpeed(s) {
      state.speed = s;
      fastBtn.classList.toggle("on", s === "fast"); stdBtn.classList.toggle("on", s !== "fast");
      replan();
    }
    function amountMinor() { try { return state.payToken ? parseUnits(amountIn.value, state.payToken.decimals) : null; } catch { return null; } }
    let amountTimer = null;
    function onAmount() { clearTimeout(amountTimer); amountTimer = setTimeout(replan, 700); render(); }

    let lastPlanKey = "";
    async function replan(force) {
      const amt = amountMinor();
      if (!amt || amt === 0n || !state.payToken) { state.plan = null; lastPlanKey = ""; render(); return; }
      const key = [state.source.key, state.payToken.address, amt.toString(), state.speed, state.account || "", recipient()].join("|");
      if (!force && key === lastPlanKey && state.plan) { render(); return; } // nothing changed, no new LI.FI call
      lastPlanKey = key; state.plan = null;
      const my = state.planning = Symbol();
      render();
      const p = await c0.plan({ source: state.source, payToken: state.payToken.address, fromAmount: amt, speed: state.speed,
        fromAddress: state.account, recipient: recipient() }).catch((e) => ({ available: false, reason: msgOf(e) }));
      if (state.planning !== my) return;
      state.plan = p; render();
    }

    async function refreshBalance() {
      if (!state.account || !state.payToken) { render(); return; }
      const tok = state.payToken;
      const b = await c0.tokenBalance(state.source, tok.address, state.account);
      if (state.payToken === tok) { state.balance = b; render(); }
    }

    async function connect() {
      if (opts.onConnect) { state.account = await opts.onConnect(); state.core = null; core(); }
      else state.account = await c0.requestAccount();
      emit({ type: "connected", account: state.account });
      refreshBalance(); resumePending(); replan(); render();
    }

    function setStep(key, status, link) {
      state.steps[key] = status;
      if (link) state.links[key] = link;
      render();
    }

    async function onMain() {
      state.error = ""; state.done = null;
      if (!state.account) { try { await connect(); } catch (e) { state.error = msgOf(e); } render(); return; }
      const amt = amountMinor();
      const to = recipient();
      if (!amt) { state.error = "Enter an amount."; render(); return; }
      if (!isAddress(to)) { state.error = "Recipient must be a valid 0x address."; render(); return; }
      state.busy = true; state.steps = {}; state.links = {}; state.activePlan = state.plan; render();
      const cr = core();
      try {
        const tr = await cr.bridge({
          source: state.source, amount: amt, payToken: state.payToken.address, recipient: to, speed: state.speed, dest: !!opts.destination,
          onStep: (s) => {
            emit({ type: s.step, ...s });
            if (s.step === "approving" || s.step === "approve_sent") setStep(s.label === "swap" ? "swap" : (s.label === "lifi" ? "burn" : "approve"), "on", s.url);
            if (s.step === "approved") { if (s.label === "bridge") setStep("approve", "done"); }
            if (s.step === "swapping") setStep("swap", "on");
            if (s.step === "swap_sent") setStep("swap", "on", s.url);
            if (s.step === "swapped") setStep("swap", "done");
            if (s.step === "burning") { if (!state.steps.approve) setStep("approve", "done"); setStep("burn", "on"); }
            if (s.step === "burn_sent" || s.step === "lifi_sent") setStep("burn", "on", s.url);
            if (s.step === "lifi_sending") setStep("burn", "on");
            if (s.step === "burned") setStep("burn", "done");
          },
        });
        await follow(tr);
      } catch (e) {
        state.error = msgOf(e); emit({ type: "error", error: state.error });
        // whatever step was live when it broke is the failed one; nothing keeps pulsing
        for (const k of Object.keys(state.steps)) if (state.steps[k] === "on") state.steps[k] = "err";
      } finally { state.busy = false; render(); refreshBalance(); }
    }

    async function follow(tr) {
      if (state.pendingTracked.has(tr.id)) return;
      state.pendingTracked.add(tr.id);
      const cr = core();
      const src = cr.source(tr.sourceKey) || { explorer: "" };
      if (!state.activePlan || state.activePlan.router !== tr.router) state.activePlan = { router: tr.router, source: src, swap: tr.swapTx ? {} : null };
      if (tr.swapTx) { state.steps.swap = "done"; state.links.swap = cr.explorerTx(src, tr.swapTx); }
      state.links.burn = cr.explorerTx(src, tr.burnTx);
      state.steps.approve = "done"; state.steps.burn = "done";
      setStep("attest", "on");
      const out = await cr.track(tr, (s) => {
        emit({ type: s.step, transfer: s.transfer });
        if (s.step === "attested") { setStep("attest", "done"); setStep("mint", "on"); }
        if (s.step === "minted") {
          setStep("attest", "done");
          setStep("mint", "done", s.transfer.mintTx ? cr.explorerTx(cr.arc, s.transfer.mintTx) : cr.explorerAddress(cr.arc, s.transfer.recipient));
          state.done = s.transfer; opts.onMinted && opts.onMinted(s.transfer);
          if (opts.destination && s.transfer.dest && s.transfer.dest.status !== "done") {
            if (opts.destination.auto !== false) runDest(s.transfer);
            else setStep("dest", "wait");
          }
        }
        if (s.step === "failed") { state.error = "The route failed (" + (s.transfer.error || "unknown") + "). LI.FI refunds to the sender on failure."; setStep("attest", "err"); }
        if (s.step === "stalled") { state.error = "Circle attested the transfer but the mint on Arc is late. Your USDC is safe; you can mint it yourself below."; }
        renderPending();
      });
      state.pendingTracked.delete(tr.id);
      if (out.status === "stalled") { renderPending(); }
    }

    function resumePending() {
      for (const tr of c0.pending()) {
        if (["planned", "burning", "swapping", "sending", "swapped"].includes(tr.status)) continue; // needs the user (listed with a button or left for inspection)
        follow(tr);
      }
      renderPending();
    }

    async function continueSwapped(tr) {
      state.error = ""; state.busy = true; state.steps = { swap: "done" }; state.links = {}; state.activePlan = { router: "cctp", source: c0.source(tr.sourceKey), swap: {} }; render();
      try {
        const out = await core().continueBridge(tr, (s) => {
          emit({ type: s.step, ...s });
          if (s.step === "approving" || s.step === "approve_sent") setStep("approve", "on", s.url);
          if (s.step === "approved") setStep("approve", "done");
          if (s.step === "burning") { if (!state.steps.approve) setStep("approve", "done"); setStep("burn", "on"); }
          if (s.step === "burn_sent") setStep("burn", "on", s.url);
          if (s.step === "burned") setStep("burn", "done");
        });
        await follow(out);
      } catch (e) {
        state.error = msgOf(e);
        for (const k of Object.keys(state.steps)) if (state.steps[k] === "on") state.steps[k] = "err";
      } finally { state.busy = false; render(); renderPending(); }
    }

    async function runDest(tr) {
      state.error = ""; setStep("dest", "on");
      try {
        await core().runDestination(tr, opts.destination, (s) => {
          emit({ type: s.step, ...s });
          if (s.step === "dest_sent") setStep("dest", "on", s.url);
          if (s.step === "dest_done") { setStep("dest", "done", s.url); state.done = s.transfer; opts.onDestination && opts.onDestination(s.transfer); }
        });
      } catch (e) {
        state.error = msgOf(e); emit({ type: "error", error: state.error });
        setStep("dest", "err");
      }
      renderPending(); render(); refreshBalance();
    }

    async function manual(tr) {
      state.error = "";
      try {
        await core().manualMint(tr, (s) => emit({ type: "manual_" + s.step, ...s }));
        state.done = tr; renderPending(); render();
      } catch (e) { state.error = msgOf(e); render(); }
    }

    function renderPending() {
      const list = c0.pending().filter((t) => t.id !== (state.done && state.done.id) && t.status !== "planned");
      pendBox.style.display = list.length ? "" : "none";
      pendBox.replaceChildren(el("h4", {}, "In flight"), ...list.map((t) => {
        const src = c0.source(t.sourceKey) || { name: t.sourceKey, explorer: "" };
        const amountTxt = t.amount ? formatUsdc(t.amount) + " USDC" : "transfer";
        const hash = t.burnTx || t.swapTx;
        const statusTxt = t.status === "minted" && t.dest ? "on Arc, " + t.dest.status : t.status;
        return el("div", { class: "it" }, [
          el("div", {}, [amountTxt + " from " + src.name + " · ", el("span", {}, statusTxt)]),
          el("div", { style: "display:flex;gap:6px" }, [
            hash ? el("a", { href: c0.explorerTx(src, hash), target: "_blank", rel: "noopener", class: "abk-mini" }, "tx") : null,
            t.status === "swapped" ? el("button", { class: "abk-mini", onclick: () => continueSwapped(t) }, "Bridge now") : null,
            t.status === "stalled" ? el("button", { class: "abk-mini", onclick: () => manual(t) }, "Mint on Arc") : null,
            t.status === "minted" && opts.destination && t.dest && t.dest.status !== "done"
              ? el("button", { class: "abk-mini", onclick: () => runDest(t) }, opts.destination.buttonLabel || "Run on Arc") : null,
            el("button", { class: "abk-mini", title: "Hide", onclick: () => { c0.dismiss(t.id); renderPending(); } }, "×"),
          ]),
        ]);
      }));
    }

    function msgOf(e) {
      const m = (e && (e.shortMessage || e.reason || e.message)) || String(e);
      if (/user rejected|denied|ACTION_REJECTED/i.test(m)) return "Transaction rejected in wallet.";
      return m.length > 220 ? m.slice(0, 220) + "…" : m;
    }

    function render() {
      const amt = amountMinor();
      const tok = state.payToken;
      balLbl.textContent = state.account && tok ? (state.balance == null ? "balance …" : "balance " + formatUnits(state.balance, tok.decimals, 6) + " " + tok.symbol) : "";
      fastBtn.disabled = !state.source.fast;
      fastBtn.title = state.source.fast ? "" : state.source.name + " finalizes quickly; standard is already fast here";
      if (!state.source.fast && state.speed === "fast") { state.speed = "standard"; fastBtn.classList.remove("on"); stdBtn.classList.add("on"); }
      // plan / fees
      const p = state.plan;
      if (p && p.available) {
        const rows = [];
        if (p.router === "lifi") {
          rows.push(el("div", { class: "via" }, "One LI.FI route straight into Arc (" + p.lifi.tool + ")"));
          rows.push(el("div", {}, "Fees + gas"), el("div", { class: "v" }, "$" + (p.lifi.feeUsd + p.lifi.gasUsd).toFixed(3)));
        } else {
          if (p.swap && !p.swap.identity) {
            rows.push(el("div", {}, "Swap " + tok.symbol + " → USDC (LI.FI · " + p.swap.tool + ")"), el("div", { class: "v" }, "≈ " + formatUsdc(p.swap.toAmount) + " USDC"));
            rows.push(el("div", {}, "Swap min after " + (c0.slippage * 100) + "% slippage"), el("div", { class: "v" }, formatUsdc(p.swap.toAmountMin)));
          }
          rows.push(el("div", {}, "Circle protocol fee" + (p.bridge.feeBps ? " (" + p.bridge.feeBps + " bps)" : "")), el("div", { class: "v" }, formatUsdc(p.protocolFee, 4)));
          rows.push(el("div", {}, "Forwarding fee"), el("div", { class: "v" }, formatUsdc(p.forwardFee, 4)));
        }
        rows.push(el("div", { class: "tot" }, "You receive on Arc ≈"), el("div", { class: "v tot" }, formatUsdc(p.expectedReceive) + " USDC"));
        rows.push(el("div", {}, "Estimated time"), el("div", { class: "v" }, p.estSeconds < 60 ? "~" + p.estSeconds + " s" : "~" + Math.round(p.estSeconds / 60) + " min"));
        feesBox.replaceChildren(...rows);
        feesBox.style.display = "";
      } else if (p && !p.available) {
        feesBox.replaceChildren(el("div", { style: "grid-column:1/-1;color:var(--abk-red)" }, p.reason));
        feesBox.style.display = "";
      } else if (state.planning && amt) {
        feesBox.replaceChildren(el("div", { class: "via" }, "Getting quotes…")); feesBox.style.display = "";
      } else feesBox.style.display = "none";
      // button
      let label = "Connect wallet", disabled = false;
      if (state.account) {
        if (state.busy) { label = "Working…"; disabled = true; }
        else if (!amt || amt === 0n) { label = "Enter amount"; disabled = true; }
        else if (state.balance != null && state.balance < amt) { label = "Insufficient " + (tok ? tok.symbol : "balance") + " on " + state.source.name; disabled = true; }
        else if (!p) { label = "Getting quotes…"; disabled = true; }
        else if (!p.available) { label = "Route unavailable"; disabled = true; }
        else if (state.customRecipient && !isAddress(recipIn.value.trim())) { label = "Enter recipient"; disabled = true; }
        else label = (p.swap && !p.swap.identity ? "Swap & bridge → " : "Bridge → ") + c0.arc.name + (opts.destination ? " & " + (opts.destination.buttonLabel || "swap") : "");
      }
      btn.textContent = label; btn.disabled = disabled;
      // error / ok
      errBox.style.display = state.error ? "" : "none"; errBox.textContent = state.error;
      if (state.done) {
        const d = state.done;
        const url = d.mintTx ? c0.explorerTx(c0.arc, d.mintTx) : c0.explorerAddress(c0.arc, d.recipient);
        const destDone = d.dest && d.dest.status === "done";
        okBox.replaceChildren(
          (destDone ? "Done. " : "USDC landed. ") + formatUsdc(c0.receivedOf(d)) + " USDC arrived on " + c0.arc.name + " (" + short(d.recipient) + ")" +
          (destDone ? " and " + ((opts.destination && opts.destination.doneLabel) || "the swap on Arc went through") + ". " : ". "),
          destDone && d.dest.tx ? el("a", { href: c0.explorerTx(c0.arc, d.dest.tx), target: "_blank", rel: "noopener" }, "swap tx") : null,
          destDone && d.dest.tx ? " · " : null,
          url ? el("a", { href: url, target: "_blank", rel: "noopener" }, "mint on explorer") : null);
        okBox.style.display = "";
      } else okBox.style.display = "none";
      // steps
      const anyStep = Object.keys(state.steps).length > 0;
      stepsBox.style.display = anyStep ? "" : "none";
      if (anyStep) {
        stepsBox.replaceChildren(...stepsFor(state.activePlan, opts.destination).map((s, i) => {
          const st = state.steps[s.key];
          const link = state.links[s.key];
          const sub = s.key === "mint" && st === "on" ? "Circle's forwarder submits the mint — nothing to sign." :
                      s.key === "attest" && st === "on" ? (state.activePlan && state.activePlan.router === "lifi" ? "LI.FI is moving the funds; nothing to sign." : "Waiting for source-chain finality + Circle signature.") :
                      s.key === "swap" && st === "on" ? "Confirm the swap in your wallet." :
                      s.key === "dest" && st === "on" ? "Confirm in your wallet on " + c0.arc.name + "." : null;
          const waitBtn = s.key === "dest" && st === "wait" && state.done
            ? el("button", { class: "abk-mini", style: "margin-left:8px", onclick: () => runDest(state.done) }, opts.destination.buttonLabel || "Run on Arc") : null;
          return el("div", { class: "abk-step " + (st === "wait" ? "" : (st || "")) }, [
            el("div", { class: "d" }, st && st !== "wait" ? "" : String(i + 1)),
            el("div", {}, [s.label, link ? [" ", el("a", { href: link, target: "_blank", rel: "noopener" }, "tx ↗")] : null, waitBtn, sub ? el("small", {}, sub) : null]),
          ]);
        }));
      }
    }

    // initial
    (async () => {
      try { state.account = await c0.account(); } catch {}
      await loadTokens();
      if (state.account) { refreshBalance(); resumePending(); }
      if (amountIn.value) replan();
      render();
    })();

    // react to wallet account changes
    try {
      const p = c0.provider;
      if (p && p.on) {
        p.on("accountsChanged", (a) => { state.account = a && a[0] ? c0.ethers.getAddress(a[0]) : null; state.balance = null; refreshBalance(); replan(); render(); });
      }
    } catch {}

    return {
      core: c0,
      get account() { return state.account; },
      setAccount(a) { state.account = a; state.balance = null; refreshBalance(); resumePending(); replan(); render(); },
      setSource(key) { const s = c0.source(key); if (s) { state.source = s; chainSel.value = s.key; loadTokens().then(() => { refreshBalance(); replan(); }); } },
      setPayToken(addr) { tokSel.value = addr; tokSel.dispatchEvent(new Event("change")); },
      setAmount(v) { amountIn.value = v; onAmount(); },
      refresh() { refreshBalance(); replan(true); renderPending(); },
      destroy() { container.replaceChildren(); container.classList.remove("abk"); },
    };
  }

  return {
    VERSION, ARC_DOMAIN, FORWARD_HOOK, FINALITY, NATIVE, CCTP, LIFI, ARC, SOURCES, ABI, PAY_SYMBOLS,
    ArcBridge, mount,
    utils: { parseUsdc, formatUsdc, parseUnits, formatUnits, toBytes32Address, computeFees, isAddress, jsonRpc, fetchJson, toTxRequest, payShortlist, explainLifi },
  };
});
