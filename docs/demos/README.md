# Demos

Four demos, one attack chain: **Prompt → Approve → Pay → Pwn**. Each demo enters the chain at a different place, ends with money moving, and has a one-flag fix.

| Demo | Page | Enters at | Needs AI? |
|---|---|---|---|
| 1 Prompt | [01-prompt.md](01-prompt.md) | an invoice PDF the agent reads | the scripted agent obeys a fixed grammar; a real model can be used |
| 2 Approve | [02-approve.md](02-approve.md) | a read-only supplier token | no |
| 3 Pay | [03-pay.md](03-pay.md) | a paywall and a merchant's 402 | the paywall bypass needs none; the rogue-merchant run uses the agent |
| 4 Pwn | [04-pwn.md](04-pwn.md) | a reporting tool | no |

Tip: open the live ledger dashboard at http://127.0.0.1:4500 next to the CFO page (http://127.0.0.1:4200) while you run a demo. It shows balances, payments and the audit log as they change, so you rarely need `make d-status`.

Before every demo run `make d-reset` (Docker) or `npm run seed -- --reset` (local). The ledger allows one active payment per invoice, so a second run on a dirty stack ends in `duplicate_payment`.

For every bug see [../BUG_CATALOG.md](../BUG_CATALOG.md). `make rehearse` runs every demo beat in Docker, vulnerable and hardened, and checks the results.

## Command and file names
Some names predate the "Demo" numbering and say "chapter" or "coda". They still work and are listed here.

| Demo | Make target | Exploit script | Tests |
|---|---|---|---|
| 1 Prompt | `make d-ch1-pdf` (PDF route), `make d-ch1` (seeded invoice) | `scripts/craft-invoice-pdf.ts` | `test/chapter1.test.ts`, `test/intake.test.ts`, `tooling/tests/test_chapter1.py` |
| 2 Approve | `make d-ch2` | `tooling/exploits/chapter2_escalate.py` | `test/chapter2.test.ts`, `tooling/tests/test_chapter2.py` |
| 3 Pay | `make d-ch3` | `tooling/exploits/v15_gate_bypass.py` | `test/chapter3.test.ts`, `tooling/tests/test_chapter3.py`, `tooling/tests/test_chapter3_signed.py` |
| 4 Pwn | `make d-coda` | `tooling/exploits/coda_pwn.py` | `test/coda.test.ts`, `tooling/tests/test_coda.py` |
