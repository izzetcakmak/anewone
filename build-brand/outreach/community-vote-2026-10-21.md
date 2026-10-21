# Community vote: weekly USDC prizes vs buyback & burn (AnewOne.Fun)

Poll: `ecosystem-budget-2026-10` · opens **Thu 22 Oct 2026, 12:00 Türkiye time (09:00 UTC)**, closes **Sat 24 Oct, 12:00 Türkiye time (09:00 UTC)** (constants `opensAt` / `closesAt` in `api/_vote.js`; the page and the API both follow them, so the vote appears by itself at the start)
Link for every post: `https://anewone.xyz/fun/?vote=1` (opens the pop-up straight away)

## Decide before launch

These are not in the brief, so the copy stays neutral on them. Each one is a line to edit if you decide.

1. **Hybrid split.** The pop-up says "the exact split is announced before the first draw". A 50/50 split is the easy thing to say out loud.
2. **Prize size.** Equal share of the prize part of the budget, 3 winners. Say the number once it exists.
3. **Decision rule.** The pop-up says: the program goes ahead only if more than half of all votes are Yes, then the model with the most votes wins, and Classic winning means nothing changes. Change it if you want something else.
4. **Minimum volume to qualify** for the Top 10 (a floor, so a $5 wallet cannot land in a quiet week). Not mentioned yet.
5. **Legal check on a random draw among traders.** Prize draws can count as lotteries in some countries. Worth a short opinion and a country exclusion list before the first payout, not before the vote.
6. **Docs.** If a model other than Classic wins, `docs.html#noah-burn` must change first: today it says half of the platform's 1% slice buys and burns $NOAH.

---

## 1. Campaign architecture and mechanics

**What is voted on.** The Ecosystem Budget: today, half of the platform's 1% fee slice, spent every week on buying $NOAH and burning it. No new fee, no new token. The vote only decides how the same budget is spent.

**Weekly snapshot.**
- A week is Monday 00:00 to Sunday 23:59:59 UTC.
- Volume per wallet = every USDC buy and sell on AnewOne.Fun that week, read from Arc events (the same ledger the "Most active" board is built from, but counted in USDC instead of number of actions).
- Left out: team wallets, and wallets that only trade against themselves. Trading in circles also costs the 1.5% fee each way, so it is an expensive way to get a ticket.

**Top 10.** The ten wallets with the highest USDC volume qualify. Being in the Top 10 is the only entry condition: no sign-up, no form, no holding requirement.

**The draw (3 of 10), checkable by anyone.**
1. When the week closes, take the hash of the first Arc block after Sunday 23:59:59 UTC. It did not exist while the week was running, so nobody could steer it.
2. For each Top 10 wallet compute `keccak256(blockHash ‖ weekNumber ‖ wallet)`.
3. The 3 lowest values win. No operator, no discretion, no re-draws.
4. Publish within 24 hours: the snapshot file, the block number, the 3 winners, and the USDC payout transactions. A small script in the repo lets anyone recompute steps 2 and 3.

**Models.**
| Model | Week 1 | Week 2 | Every week after |
|---|---|---|---|
| Alternating | 100% buy & burn | 100% USDC to the 3 winners, equal shares | repeats |
| Hybrid | buy & burn + USDC to 3 winners | same | split fixed before the first draw |
| Classic | 100% buy & burn | same | unchanged |

**Voting mechanics (built).**
- Walletless and gas-free: nothing to connect, nothing to sign.
- One vote per browser (a random ID kept in the browser), changeable until the window closes.
- At most 5 browsers per network, so a household or an office is fine and a script is not. The network address is stored only as a keyed hash and expires with the poll.
- This is a community signal, not an onchain vote. The pop-up says so, and says how the result decides.

---

## 2. Web UI copy (live on `/fun`, source `docs/fun/vote.js`)

**Banner (page)**: *Should trading on AnewOne.Fun earn weekly USDC?* · You decide how the Ecosystem Budget is spent. 30 seconds, no wallet, no gas. · **Cast your vote**
After voting: *Your vote is in* · Thank you. N votes so far. You can change yours until it closes. · **View results**
After close: *Community vote closed* · Final count · **See results**

**Step 1**
- Label: COMMUNITY VOTE · Closes in 1d 23h
- Title: **Should we launch the new community incentive program?**
- Body: Today the **Ecosystem Budget**, the share of platform fees we set aside, has one job: buying **$NOAH** every week and burning it. You decide whether part of it should also go back to the people who trade here, as **weekly USDC prizes**.
- Facts: **No wallet**, nothing to connect or sign · **Zero gas**, voting costs you nothing · **Same budget**, no new fees, no new token
- CTAs: **Yes, launch it** / **No, keep things as they are**
- Footer: N votes so far · closes 24 Oct, 09:00 UTC

**If No**
- **Thank you for voting.** Nothing changes for now: the Ecosystem Budget keeps buying and burning $NOAH every week unless the community decides otherwise.
- Live results, **Close**.

**Step 2**
- Title: **How should the Ecosystem Budget work?**
- Sub: Pick one model. Prizes are drawn from the **weekly Top 10 by trading volume**, and every draw can be checked by anyone.
- **Alternating** · Burn week, then prize week. One week the whole budget buys and burns $NOAH. The next week the whole budget is paid out in USDC, split equally between 3 wallets drawn from the Top 10 by trading volume. Then it repeats.
- **Hybrid** · Burn and prizes, every week. Every week the budget is split. One part keeps buying and burning $NOAH, the other is paid in USDC to 3 wallets drawn from the Top 10 by trading volume. The exact split is announced before the first draw.
- **Classic** · Keep it as it is. The whole Ecosystem Budget stays on the weekly $NOAH buy-and-burn. No cash prizes, nothing new to run.
- Disclosure, *How the weekly draw stays fair*: Snapshot · Top 10 · Random draw · Proof (the four steps above, in plain words).
- CTAs: **Back** / **Cast my vote**
- Footer: No wallet, no gas. Voting is open to everyone: one vote per browser, and you can change it until 24 Oct, 09:00 UTC.

**Result**
- **Your vote is in.** You chose Hybrid. Share it, and every vote counts: more voices make a stronger signal.
- Bars: Launch the program? Yes / No · Preferred model among yes-votes.
- *How it is decided.* The program goes ahead only if more than half of all votes are Yes. The model with the most votes then wins; if that is Classic, nothing changes. The final count is published here and in the docs, and any change is announced before it starts.
- CTAs: **Share on X** / **Copy link** / *Change my vote*

---

## 3. AI image prompts

AI image models misspell text, so ask for none and add the words in Figma. Palette is the site's: near-black `#0d0d10`, fun pink `#ff7aa8`, mint `#3ee8a3`.

**16:9 banner (Midjourney)**
```
Dark-mode cyber fintech key visual, wide cinematic composition. Center: a glowing glass-and-steel decentralized voting vault, an open ballot slot on top with luminous pink light spilling out, a stream of 3D glossy USDC-style coins (blue-white metallic discs with a simple dollar-sign emboss, no text) swirling up out of the vault in a spiral. Behind it, a holographic trading-volume bar chart climbing left to right with thin neon grid lines and a faint candlestick wave, ten glowing pillars highlighted among many dim ones. Near-black background #0d0d10, accent light in hot pink #ff7aa8 and mint #3ee8a3, subtle volumetric fog, shallow depth of field, specular reflections, bokeh particles, premium crypto product launch aesthetic, octane render, 8k, clean negative space on the left third for a headline. No text, no letters, no logos --ar 16:9 --style raw --v 7 --no text watermark people faces
```
For Flux: drop the `--` flags, add "16:9, 1792x1008".

**1:1 square (Midjourney)**
```
Bold split-screen concept art, square composition, "weekly USDC rewards versus buyback and burn". Left half: a rain of glossy 3D USDC-style coins falling into three glowing pink spotlights. Right half: a single coin being pulled into a swirling black hole furnace, thin mint-green flames, ash particles rising. A sharp luminous vertical seam divides the two halves, tiny lightning at the seam. Dark graphite background #0d0d10, hot pink #ff7aa8 and mint #3ee8a3 rim lighting, ultra-high contrast, glossy product-render look, dramatic top light, crisp, scroll-stopping social media tile, empty bands at top and bottom for added text. No text, no letters, no logos --ar 1:1 --style raw --v 7 --no text watermark people faces
```
For Flux: drop the flags, add "1:1, 1536x1536".

Text to add over the images: banner **"Should trading earn weekly USDC?  You decide."** with the small line *No wallet. No gas.* · square **"USDC prizes vs Buyback"** with *Vote now · anewone.xyz/fun*.

---

## 4. Social copy

### X thread (post 1 carries the news in its first 280 characters)

**1/**
You decide how A NEW ONE spends its Ecosystem Budget.

Weekly USDC prizes for active traders, or 100% buyback & burn?

No wallet. No gas. 30 seconds.

Vote: anewone.xyz/fun/?vote=1

Voting closes 24 Oct, 12:00 Türkiye time (09:00 UTC). 🧵

*(attach the 16:9 banner)*

**2/**
Today the Ecosystem Budget has one job: it buys $NOAH every week and burns it.

The question: should part of it also go back to the people who trade on AnewOne.Fun?

Same budget. No new fees. No new token.

**3/**
Step 1 is a simple yes or no. If yes, you pick one of three models:

**Alternating**: one week full buy & burn, next week full USDC prizes, then repeat.
**Hybrid**: every week, the budget is split between burning and prizes.
**Classic**: nothing changes. 100% buy & burn.

**4/**
How prizes would work if the community says yes:

→ Every week we snapshot trading volume (Mon to Sun, UTC)
→ The Top 10 wallets by USDC volume qualify
→ 3 of them are drawn using the hash of an Arc block that did not exist when the week closed
→ Snapshot, block and payouts are published. Anyone can recompute the draw.

**5/**
No wallet to connect. Nothing to sign. Zero gas.
One vote per browser, and you can change it until the window closes.

It takes 30 seconds, and every vote you do not cast is one somebody else casts for you.

**6/**
Voting closes 24 Oct, 12:00 Türkiye time (09:00 UTC). The program only goes ahead if most votes are Yes, and the count is published either way.

Cast your vote: anewone.xyz/fun/?vote=1

Prizes are a draw, not a return. $NOAH is a memecoin with no claim on the platform; a smaller supply sets no price. Nothing here is investment advice.

*(attach the 1:1 square)*

### Telegram announcement

🗳 **Community vote is open: should trading earn weekly USDC?**

Right now the Ecosystem Budget (our platform-fee share) does one thing: it buys $NOAH every week and burns it.

Now you decide if part of it should also be paid out in USDC to active traders:

1️⃣ **Alternating**: burn week, then USDC prize week
2️⃣ **Hybrid**: split every single week, burn + prizes
3️⃣ **Classic**: keep it as it is, 100% buy & burn

🎯 How a prize draw would work: weekly snapshot → Top 10 wallets by USDC volume → 3 drawn with an Arc block hash anyone can verify.

✅ No wallet connection
✅ Zero gas
✅ 30 seconds, one vote per browser, changeable until the end

⏳ Voting closes **24 Oct, 12:00 Türkiye time (09:00 UTC)**.

👉 anewone.xyz/fun/?vote=1

*Prizes are a draw, not a return. Nothing here is investment advice.*
