# Demo 3: Pay — the 402 is signed without being checked

**Bugs in the demo:** V15 (the paywall's gate and its router parse the path differently), V7 (the agent signs any 402 it is handed). **Also in this chapter, covered by tests:** V6 (the agent's x402 budget exists only in its prompt), V16 (fail-open), V17 (duplicate settle reported as success), V18 (payment not bound to the resource), V19 (redirect forwards the payment header), V22 (text and structured copies of a payment request differ).
**Hints:** [hints/03-pay.md](../../hints/03-pay.md) · **Tests:** `test/chapter3.test.ts`, `test/x402.test.ts`, `tooling/tests/test_chapter3.py`, `tooling/tests/test_chapter3_signed.py`

## How x402 works here
1. The agent asks the merchant for a paid resource (`GET /v1/premium/...`).
2. The merchant answers `402 Payment Required` with a `PAYMENT-REQUIRED` header: price, payee, network.
3. The agent signs an authorization and retries with a `PAYMENT-SIGNATURE` header.
4. The merchant asks the facilitator to verify and settle; the facilitator moves the funds and the merchant returns the data.

## The story
**Part A, the paywall (no AI).** The gate that decides whether a request must pay and the router that serves it read the URL differently. `//v1/premium/...` and `/V1/Premium/...` skip the gate and return the paid report for free. One extra slash.

**Part B, the rogue merchant.** Globex runs its own merchant. When the agent asks it for a vendor report, it answers `402` naming Globex's drop account as the payee and returns a forged all-clear (risk 4/100). With no payee pin and no maximum price (V7) the agent signs it: **$15 leaves the agent's wallet for the attacker, with no human in the path.** The agent's next step, paying the $9,500 invoice, is denied by the ledger's allowlist: that control held.

The point is small money here and large money with a bigger wallet: the only limit on the agent's x402 spend is a sentence in its prompt (V6).

## Run it (Docker)
```bash
make d-up-attack
make d-reset
make d-ch3                      # Part A, then Part B
make d-status                   # acct_globex_drop holds $15.00
```
What you should see: the normal path `PAYWALLED (402)`, the variants `FREE DATA`, `BYPASS WORKS`; then the agent log `Paid $15.00 via x402 … → vendor risk 4/100` and `Policy denied the payment: payee_not_in_mandate_allowlist`.

## Run it (local)
```bash
npm run dev                                                    # terminal A
python3 tooling/exploits/v15_gate_bypass.py http://127.0.0.1:4021
make rogue                                                     # terminal B: Globex's rogue merchant
MERCHANT_URL=http://127.0.0.1:4666 npm run agent -- "Pay the Globex invoice INV-2001"
make status
```

## The fix
```bash
make d-reset
make d-harden H=V15,V7
make d-ch3                      # every path returns 402; the agent logs challenge_rejected; no money moves
```
V7 pins the payee, caps the price and checks network, asset and origin before anything is signed. V15 makes the gate default-deny at the route.

## Other bugs in this chapter
- Run the tests: `npm test -- chapter3` and `python3 -W ignore -m unittest tooling/tests/test_chapter3_signed.py`.
- V22 live beat: `make d-up-attack`, then `ENRICH_VENDOR=1 VENDOR_MCP_URL=http://vendor-mcp:4300/mcp make d-agent`; compare the agent log ($0.25 to VettingCo) with `make d-status` (the attacker account gains $1.00).

## Related public incidents (pattern, not the same attack)
- Freysa, November 2024: the rule against sending funds lived in a prompt, and a player talked the agent into releasing a prize pool of about $47K. [The Block](https://www.theblock.co/post/328747).
- AIXBT, March 2025: after an attacker reached its dashboard, the AI agent sent about 55 ETH. [The Block](https://www.theblock.co/post/346911/).
