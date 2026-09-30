// Browser surface of @circle-fin/earn-kit plus the ethers v6 adapter, bundled so the page keeps
// loading scripts from its own origin alone. Permissionless mode: no API key is bundled.
export { EarnKit, KitError, getErrorMessage } from "@circle-fin/earn-kit";
export { BorrowKit, isRetryableError } from "@circle-fin/borrow-kit";
export { createEthersAdapterFromProvider } from "@circle-fin/adapter-ethers-v6";
