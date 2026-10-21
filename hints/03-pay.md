# Step 6: the 402
1. The paid report has a premium tier. Fetch it normally, then fetch the same URL spelled differently.
2. Who tells the agent *whom* to pay and *how much*? What does the agent check before signing?
3. A payment is a signed message. What does the signature cover, and what does it not cover (think: which URL)?

## More Pay bugs (V16, V17, V6, V22)
- V16: what does the merchant do when the facilitator errors, or when settlement fails after verification passed? Try more parallel requests than the wallet can afford.
- V17: send one signed payment header many times at once. How many answers do you get, and how many times is the merchant paid?
- V6: the system prompt says "$5/day". Where is that enforced? Loop the paid call ten times.
- V22: an MCP tool returns the payment request twice (text and structured). Which one does the agent show, and which one does it sign?

## More Pay bugs (V20, V21, V24, V25, V32)
- V20: set the price cap to the number the docs say. What cap does the code actually apply? Then set it to `$1`.
- V21: how long can a signed payment stay valid? Who checks?
- V24: pay for the cheap endpoint, then show only the receipt (`x-payment-receipt`) to the expensive one.
- V25: who pays the network fee when a settlement attempt fails? Send more attempts than the wallet can cover.
- V32: what happens if the folder the agent starts in contains a config file?
