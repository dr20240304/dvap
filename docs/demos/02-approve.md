# Demo 2: Approve — a read-only token and a spoofed approval screen (no AI)

**Bugs:** V4 (a header overrides the identity the token proves), V5 (no per-tool scope), V8 (the approval screen shows the caller's note, not the payee), V29 (approve endpoints are not bound to the CFO's session).
**Hints:** [hints/02-approve.md](../../hints/02-approve.md) · **Tests:** `test/chapter2.test.ts`, `tooling/tests/test_chapter2.py`

## The story
Every supplier is given a **read-only portal token** for invoice status. It has no mandate and no funds. Globex uses it to:
1. **V4:** send `X-Agent-Id: agent-1` along with the token. The payments server lets that header override the identity the token proves, so Globex now acts as the payments agent and sees all its tools.
2. **V5:** call `configure_payment_policy`. No tool needs its own scope, so Globex allowlists and trusts itself and raises the cap.
3. **V8:** call `create_payment` for $9,500 with a note that impersonates a routine Initech milestone. The CFO's approval screen is built from that note and never names Globex.

The CFO approves, the ledger pays Globex, and the audit log records `policy.updated` and `payment.pending_approval` under **agent-1**, then the approval under **cfo**. The supplier appears nowhere. No AI, no exploit: a low-privilege credential and a screen that tells a story.

## Run it (Docker)
```bash
make d-up-attack
make d-reset
make d-ch2                      # runs tooling/exploits/chapter2_escalate.py with the portal token
make d-status                   # a $9,500 payment to Globex is pending
```
What you should see from the script:
```
[1/3] V4  impersonating agent-1 with a portal-only token (tools visible: …)
[2/3] V5  widen policy -> allowed payees now ['p_initech', 'p_hooli', 'p_globex']
[3/3] V8  create_payment -> pending_approval pay_…
```
Open http://127.0.0.1:4200: the CFO sees only the Initech note. Click **Approve & sign**, then `make d-status`: Globex +$9,500.

## Run it (local)
```bash
npm run dev                                                   # terminal A
python3 tooling/status.py --tokens                            # shows the supplier's portal token
python3 tooling/exploits/chapter2_escalate.py http://127.0.0.1:4100/mcp <portal_token>
```

## The fix
```bash
make d-reset
make d-harden H=V4,V5,V8
make d-ch2                      # stops at step 1: forbidden: missing scope mandate:write
```
With V4, V5 and V8 on, identity comes from the token only, each tool needs a scope, and the approval screen reads `PAY $9,500.00 TO GLOBEX TRADING (… UNVERIFIED PAYEE)`. V29 (approve endpoints bound to the CFO's browser session) is covered by tests.

## Related public incidents (pattern, not the same attack)
- Poly Network, 2021: a privileged call replaced the keys that approve cross-chain transfers, with no stolen key. [Halborn write-up](https://halborn.com/explained-the-poly-network-hack-august-2021/).
- DMM Bitcoin, 2024: per the FBI, a hijacked employee session was used to manipulate a legitimate transaction request. [The Hacker News](https://thehackernews.com/2024/12/north-korean-hackers-pull-off-308m.html).
- Radiant Capital, 2024: signers approved transactions that looked legitimate on screen while malware changed what they signed. [Halborn write-up](https://www.halborn.com/blog/post/explained-the-radiant-capital-hack-october-2024).
