# Arc Mainnet, Day 48 — X article

Update of the day-25 report. Data as of November 3, 2026.

---

## Arc Mainnet, Day 48: What the Data Says After the Launch Rush

On August 22nd, we mapped out Arc's architectural pillars and the road to the September 16th Public Mainnet. At day 25, we reported on how the testnet debates were holding up under live capital. Today, November 3rd, Arc has been live for 48 days. That is long enough for the launch-day noise to clear and for the onchain data to tell its own story.

Some of what we expected held. Some of it needs correcting. Here is the update.

### 0. The Numbers First

- **Stablecoins:** USDC on Arc crossed $1B on October 27, up ~109% in 30 days. In early November, Arc holds ~$1.088B USDC out of ~$1.098B in total stablecoins. For now, it is effectively a single-stablecoin chain.
- **Concentration:** At the $1B mark, four addresses held ~73% of the USDC supply. The headline is real; the distribution is not broad yet.
- **Users:** 406,006 active wallets on launch day versus a week-four daily average of ~24.7K (Bitquery). Strip out wallet farms and bots, and roughly 20K real senders remain. The airdrop tourists left. The base that stayed is the one to build for.
- **Credit:** Aave V4 and Morpho anchored lending from day one. Aave V4's Arc deployment held $180.9M (27.7% of all V4 TVL) by September 30. By October 13, $190M of USDC was borrowed against cirBTC on Morpho, against $195M supplied: ~97% utilization.

### 1. Oracle & Liquidity Discipline: Testnet Leniency Is Over

The day-25 thesis holds, with one addition: liquidity risk now matters as much as price risk.

- **Chainlink is fully live:** Data Feeds (Sep 9), Data Streams (Sep 15) and CCIP (Sep 16). Low-latency streams plus onchain feeds make the hybrid pattern the default: offchain market intelligence (including x402-metered endpoints) cross-checked against onchain feeds before any non-reversible action, whether a liquidation, an escrow settlement or a mission start.
- **Staleness defenses stay non-negotiable:** strict `lastUpdated` bounds, 1.5–2% deviation thresholds and multi-source medians.
- **New lesson, utilization:** a USDC market at 97% utilization means suppliers may not be able to exit when they want to, and a sharp cirBTC move becomes a liquidation event. Check available liquidity and utilization, not just price, before routing user funds, and design withdrawal paths that handle a full pool.

### 2. Agentic Commerce: The Standards Are Set, the Rails Are Converging

- **ERC-8183 is Arc's job standard:** define the job, escrow USDC, submit work, evaluate, then settle or refund. ERC-8004 carries identity and reputation, so job outcomes become reusable trust signals.
- **What production shows:** there is no single canonical ERC-8183 deployment the whole ecosystem settles against yet; teams run their own instances. Expect consolidation. Until then, verify exactly which escrow contract you are integrating with.
- **The day-25 conclusion stands:** identity without escrow does not prevent non-delivery. Hash verification works for deterministic code and data outputs; analytical work still needs secondary agent arbiters or onchain attestations before funds are released.
- **Audit trails, stated precisely:** permission-check telemetry (verdict, dynamic constraints, structured rationale) logged onchain, with spending allowances routed through ERC-1271 smart accounts, is the most practical way to make agent actions reviewable, including for teams mapping to EU AI Act high-risk obligations. This is a design pattern builders implement, not a property the network hands you for free.

### 3. Unified Liquidity: CCTP Opens Beyond USDC

- **Native by default:** USDC enters through CCTP burn-and-mint and Gateway's unified balance. No wrapped USDC.
- **The biggest update since day 25:** Circle has extended CCTP to issuer-controlled ERC-20s on Arc. An issuer can register an existing token as a custom token, keep control of its crosschain connection, and choose burn-and-mint or lock-and-unlock. For fiat stablecoins and RWAs, that is a path to multichain without bespoke bridges.
- **StableFX:** 24/7 cross-currency settlement, with 20+ local-currency stablecoins (JPYC, MXNB, BRLA, AUDD, ZARU and others) being onboarded. This is the route out of the single-stablecoin phase.
- **Reality check:** native rails make capital mobile in both directions. Bitquery traced ~$142M of USDC moved off Arc by five large Morpho borrowers, mostly to Ethereum. Liquidity does not stay because it arrived; Arc has to keep earning it.

### 4. Post-Quantum & Validators: A Correction

At day 25, we described post-quantum consensus. That overstated it. Precisely:

- **Live now:** native verification of SLH-DSA-SHA2-128s signatures through a precompile, so contracts can check post-quantum signatures today, plus opt-in post-quantum wallet signatures in beta. Each signature is ~7.8 KB, which is why signature aggregation matters.
- **Next:** Arc Privacy, with encrypted state and private flows on post-quantum key exchange (X-Wing: X25519 + ML-KEM-768).
- **Later:** post-quantum validator signatures, phased in carefully to protect throughput and latency. Consensus today is not post-quantum.
- **Validators:** the founding cohort, including BlackRock, DTCC, ICE, Mastercard, Standard Chartered and Visa, is being onboarded in phases on a permissioned set. A move toward Proof of Stake is being explored for 2027. DTCC plans to enable tokenization of DTC-custodied assets on Arc from the second half of 2027.
- **ARC token:** a 10B genesis mint, with no commitment to a public launch. Do not build roadmaps on it.

### 5. Builder Outlook: From Launch to Retention

- **Rails live:** CCTP (now including issuer ERC-20s), Gateway, Chainlink Data Feeds, Data Streams and CCIP, Aave V4, Morpho, and post-quantum signature verification.
- **Where the gaps are:** USDC supply depth in lending (97% utilization says demand for credit outruns supply), stablecoin diversity beyond USDC, retention of the ~20K real users, and convergence on shared agent-escrow deployments.
- **Where to build:** agent-to-agent micro-settlement on ERC-8183, aggregated signature verification to cut relayer overhead as post-quantum signatures grow, USDC supply-side products for the lending markets, and compliant RWA tokenization on issuer-controlled CCTP.

Day 25 asked whether the rails would hold. They did. Day 48 asks whether usage holds. The next fifty days are about turning a $1B headline into a deep, distributed, sticky economy.

Keep building.

Build on ARC
@arc
@samconnerone @bobbilee @silencexlm

*Data: Circle, Arc Docs, Chainlink changelog, DefiLlama, Bitquery. As of November 3, 2026.*
