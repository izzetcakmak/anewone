// Browser surface of @circle-fin/unified-balance-kit (Circle Gateway: one balance of USDC, EURC
// and cirBTC across chains, spent onto Arc), with the ethers v6 adapter, bundled so the bridge
// page keeps loading scripts from its own origin alone. No API key is bundled or needed.
export {
  createUnifiedBalanceKitContext, deposit, estimateDeposit, spend, estimateSpend, getBalances,
  getSupportedChains, getErrorMessage, KitError,
} from "@circle-fin/unified-balance-kit";
export { createEthersAdapterFromProvider } from "@circle-fin/adapter-ethers-v6";
