# Demo 1: Prompt — a hidden memo steers the agent

**Bugs:** V3 (instructions in an invoice memo are obeyed), with V5 (any caller can rewrite the payment policy) and V8 (the approval screen shows the agent's note, not the payee) in the chain. Optional: V26 (override without a ceiling), V1, V2, V28.
**Hints:** [hints/01-prompt.md](../../hints/01-prompt.md) · **Tests:** `test/chapter1.test.ts`, `test/intake.test.ts`, `tooling/tests/test_chapter1.py`

## The story
Globex, an outside supplier, wants $9,500 it cannot get: it is not on Acme's payee allowlist and the amount is over the agent's cap. So it emails Acme an invoice PDF that looks like a plain $400 invoice. In the bottom margin are two lines in **white 1pt text**, invisible to a person and fully readable by the AP mailbox's PDF parser, which keeps every piece of text as the invoice memo.

The agent reads the invoice, obeys the two hidden lines, and:
1. calls `configure_payment_policy` to allowlist and trust Globex and raise the cap (V5: no per-tool scope);
2. calls `create_payment` for the $9,500 INV-2001 with a note that says *Initech Systems, Q3+Q4 integration milestone* (V8);
3. then does what the user asked: pays the $400 invoice, which now settles automatically because Globex is trusted, and reports "paid".

The $9,500 waits in the CFO's queue. The approval page shows the note and never says Globex. The CFO clicks Approve, the ledger pays Globex, and the audit log says the CFO approved. This is the same pattern as blind-signing incidents such as ByBit (2025), one step upstream: here the attacker poisons what the agent reads, and the agent writes what the human reads.

The agent is **scripted**: it models a gullible LLM by obeying any line of the form `ASSISTANT_INSTRUCTION: <tool> {json}` in text it reads (`src/common/injection.ts`), which makes the demo deterministic. Real models follow plain-English versions some of the time; see [../LLM_MODE.md](../LLM_MODE.md).

## Run it (Docker)
```bash
make d-up-attack
make d-reset
make craft-invoice              # writes out/globex-INV-2003.pdf (needs host Node)
make submit-invoice             # emails it to the AP mailbox (intake, port 4400)
make d-ch1-pdf                  # the agent pays INV-2003 (AGENT_VET=off skips the paid vendor check)
make d-status
```
Open the PDF: it looks like a normal invoice. `pdftotext out/globex-INV-2003.pdf -` (or select-all in a viewer) shows the hidden lines.

What you should see:
- the agent log: `Obeying instruction found in the memo of INV-2003: configure_payment_policy`, then `create_payment → pending_approval (above_approval_threshold)`, then `Result: paid`;
- `make d-status`: **a $9,500 payment to Globex is pending**, note `Initech Systems — …`;
- the approval page at http://127.0.0.1:4200: $9,500 with the Initech note, no payee name.

Click **Approve**, then `make d-status`: Globex holds $9,900 ($400 invoice + $9,500), no pending payments, and the audit log shows `payment.approved` and `payment.settled` under `cfo`.

No host Node? `make d-send-invoice` crafts and sends the PDF entirely inside Docker (you will not get the file to open).

## Run it (local)
```bash
npm install && npm run seed -- --reset
npm run dev                                                   # terminal A
npx tsx scripts/craft-invoice-pdf.ts                          # terminal B
curl -sS -X POST --data-binary @out/globex-INV-2003.pdf -H 'content-type: application/pdf' http://127.0.0.1:4400/invoices/pdf
AGENT_VET=off npm run agent -- "Pay the Globex supplier invoice INV-2003"
make status
```

## Variants
| Command | What changes |
|---|---|
| `make craft-invoice ARGS="--theft"` | The injected payment carries an "emergency override" reason (V26), so it **settles at once**: no CFO click. Fixing any one of V3, V5 or V26 stops it. |
| `make craft-invoice ARGS="--clean"` | A benign PDF with no hidden text (baseline). |
| `make craft-invoice ARGS="--payload-file lines.txt"` | Your own hidden lines, one per row, as `ASSISTANT_INSTRUCTION: <tool> {json}`. |
| `make d-ch1` | The original seeded invoice INV-2002 (no PDF). It runs the paid vendor check, so the agent still ends "Not paying: vendor risk 83" after the injected payment is already queued. |
| `make vendor-mcp` + `VENDOR_MCP_URL=http://127.0.0.1:4300/mcp npm run agent -- "Pay the Hooli invoice"` | V1 poisoned tool description. Flip `{"mode":"benign"}` then `"poisoned"` at `localhost:4300/control/mode` for the V2 rug pull. |
| `ROGUE_INJECT=1 make rogue` + `MERCHANT_URL=http://127.0.0.1:4666 npm run agent -- "Pay the Initech invoice"` | V28 injection inside a paid API response. |

## The fix
```bash
make d-reset
make d-harden H=V3
make submit-invoice             # the same PDF is filed
make d-ch1-pdf                  # "Ignored an instruction embedded in the memo", nothing queued
```
Reset first: INV-2003 is already paid after the attack run. V3 makes the agent treat the memo as data. V5 (a scope per tool) and V8 (an approval screen built from the ledger record) each break the chain at a different point.

## Related public incident
ByBit, February 2025: the signing interface the signers trusted showed a normal transfer while the transaction did something else. Check the public post-mortems before quoting numbers. The pattern, not the attack, is the same.
