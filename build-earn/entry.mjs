// Browser surface of @circle-fin/earn-kit plus the ethers v6 adapter, bundled so the page keeps
// loading scripts from its own origin alone. Permissionless mode: no API key is bundled.
export { EarnKit, KitError, getErrorMessage } from "@circle-fin/earn-kit";
export { BorrowKit, isRetryableError } from "@circle-fin/borrow-kit";
export { createEthersAdapterFromProvider } from "@circle-fin/adapter-ethers-v6";
// Borrow writes need an atomic batch. The viem "next" adapter can give one to a plain wallet
// (EOA) on Arc through the sender-preserving batcher the chain publishes; the ethers adapter
// cannot, so Borrow runs on this one while Earn keeps ethers.
export { createViemAdapterFromProvider as createViemNextAdapterFromProvider } from "@circle-fin/adapter-viem-v2/next";
