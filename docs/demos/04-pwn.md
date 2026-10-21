# Demo 4: Pwn — a report title opens the vault (no AI)

**Bugs:** V10 (command injection in a reporting tool), V13 (the audit log cannot tell a stolen key from a human click; an audit-trail gap with no switch). Related: V29 (approval not bound to the human's session).
**Hints:** [hints/04-pwn.md](../../hints/04-pwn.md) · **Tests:** `test/coda.test.ts`, `tooling/tests/test_coda.py`

## The story
Globex still holds only the read-only portal token. The payments server has an innocent-looking `export_report` tool that saves a one-line summary and takes a `title`. It builds a shell command from that title (V10). A title containing `$(cat keys.json)` makes the server's shell expand it, and the response carries **every secret the server holds**: the service key and the CFO's signing key.

With the CFO signing key Globex signs its own pending $9,500 payment **directly at the ledger**, with no browser and no human click. The ledger sees a valid CFO signature, and the audit log says the CFO approved it, and nothing records that no human did (V13). Demo 2 fooled the approver; this one steals the approver.

## Run it (Docker)
```bash
make d-up-attack
make d-reset
make d-ch2                      # queue a payment (the Demo 2 steps), so there is something to approve
make d-coda                     # leak the keys, sign it as the CFO
make d-status                   # Globex +$9,500; audit: payment.approved and payment.settled under cfo
```
What you should see:
```
[1/3] V10 leaked secrets via export_report: service key svc_…, CFO signing key …
[2/3] signed pay_… with the stolen CFO key (0x…) -> settled, approvedBy=cfo
[3/3] V13 the audit log attributes this to 'cfo'. Nothing records that no human clicked.
```

## Run it (local)
```bash
npm run dev                                                    # terminal A
python3 tooling/status.py --tokens                             # portal token
python3 tooling/exploits/chapter2_escalate.py http://127.0.0.1:4100/mcp <portal_token>   # a pending payment
python3 tooling/exploits/coda_pwn.py http://127.0.0.1:4100/mcp http://127.0.0.1:4000 <portal_token> "$PWD/.dvap-data" <payment_id>
```
The payment id is in `make status`.

## The fix
```bash
make d-reset
make d-ch2
make d-harden H=V10
make d-coda                     # "V10 blocked": the tool no longer runs a shell
```
V10 removes the shell. The audit gap (V13) is a design lesson, not a switch: bind approvals to the human's session (V29) and keep secrets out of anything a tool can read.

## Related public incident (pattern, not the same attack)
Ronin bridge, March 2022: attackers obtained five of nine validator keys through the systems around them and signed withdrawals that looked legitimate; it went unnoticed for about a week. [Ronin's post-mortem](https://roninchain.com/blog/posts/back-to-building-ronin-security-breach-6513cc78a5edc1001b03c364).
