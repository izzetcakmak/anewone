**To:** the Dinari partnerships / business contact you wrote to before
**Subject:** Re: Partner access for A NEW ONE on Arc — follow-up now that dShares are live on Arc

Hi Dinari team,

Following up on my earlier mail about production access for A NEW ONE (anewone.xyz), the real-world-asset distribution front end on Arc, Circle's USDC L1.

Two things changed since I wrote:

1. dShares went live on Arc mainnet on 16 September. That removes the chain question from my first mail: we would settle on Arc (chain id 5042) directly, no CCTP leg.
2. Our Arc Assets page is live with Centrifuge's funds (JTRSY, JAAA, HYB) since 1 October, so stocks would join an existing, working RWA front end rather than a plan. Tokenized stocks are also being announced by other Arc front ends right now, so timing matters to us.

Where we stand on the integration: the full non-custodial flow is built and passing against your sandbox with @dinari/api-sdk 0.15.0. Wallet sign-in, Dinari-managed KYC, wallet ownership proof, gasless proxied orders with EIP-712 permit, dShares settling to the user's own wallet, our server holding only the partner key. We are ready to switch to production the day we have access.

What we need from you to go live:

- Production API access and business verification. Which path applies to an individual / sole proprietor, and if a corporate entity is required, which jurisdictions you accept. We can incorporate if that is the blocker, so a clear answer lets us start today.
- Confirmation that Arc (5042) is enabled for partner order flow in production, and the dShare contract addresses or registry on Arc.
- How the order `fee` field settles to the partner and whether a revenue share exists.
- Rate and order-size limits on the partner tier.

Happy to do a short call this week if easier. Thank you.

İzzet Çakmak
A NEW ONE · anewone.xyz · izzetcakmak35700@gmail.com
