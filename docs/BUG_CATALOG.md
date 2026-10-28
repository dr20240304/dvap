# DVAP bug catalog (what is actually implemented)

All bugs are **vulnerable by default**. `DVAP_HARDEN=V15` (comma list, or `all`) turns on the fix. IDs follow [`PUBLIC_BUG_LESSONS.md`](PUBLIC_BUG_LESSONS.md).
The OWASP column is **our own judgement** of the closest item (OWASP MCP Top 10 2025 beta / Agentic Top 10 2026), not an official mapping.

| ID | Chapter | Flow step | Bug | Closest OWASP | Code | Regression tests |
|---|---|---|---|---|---|---|
| V1 | 1 Prompt | 2 Plan | Hidden instructions in a third-party tool description are obeyed | MCP03, ASI01 | `src/vendor-mcp`, `agent/runner.ts` | `chapter1.test.ts`, `test_chapter1.py` |
| V2 | 1 Prompt | 2 Plan | Rug pull: tool changes after approval; no pinning | MCP03/MCP04, ASI04 | `agent/runner.ts` (`pinOk`) | same |
| V3 | 1 Prompt | 1 Ingest | Instructions in an invoice memo are obeyed | MCP06, ASI01 | `ledger/seed.ts` (INV-2002), `intake/` (PDF route, INV-2003), `agent/runner.ts` | same |
| V28 | 1 Prompt | 6 Pay | Instructions inside a paid API response are obeyed | MCP06/MCP10, ASI01 | `attacker/rogue-merchant.ts` | same |
| V4 | 2 Approve | 3 Identity | `X-Agent-Id` header overrides the identity the token proves | MCP07, ASI03 | `payments-mcp` auth | `chapter2.test.ts`, `test_chapter2.py` |
| V5 | 2 Approve | 4 Policy | Any caller can use any tool, incl. `configure_payment_policy` (no per-tool scope) | MCP02, ASI03 | `payments-mcp` `guard()` | same |
| V8 | 2 Approve | 5 Approve | Approval screen shows the agent's summary, not the real payee | ASI09 | `approval-ui` `describePayment` | same |
| V15 | 3 Pay | 6 Pay | Paywall gate and router parse the path differently (case, `//`) | (no direct item) | `merchant/index.ts` | `chapter3.test.ts`, `test_chapter3.py` |
| V7 | 3 Pay | 6 Pay | Agent signs any 402 it is handed: no payee pin / max price (the same gap as the x402 SDK's "no default spending limit": a hostile API can ask for the wallet's whole balance) | ASI02 (closest) | `agent/x402-client.ts` `guardChallenge` | same + `x402.test.ts` |
| V18 | 3 Pay | 6 Pay | Payment not bound to the resource it was signed for | (no direct item) | `facilitator/index.ts` | `chapter3.test.ts` |
| V19 | 3 Pay | 6 Pay | Payer follows redirects and forwards its payment header | MCP01-ish (credential leak) | `agent/x402-client.ts` | `chapter3.test.ts` |
| V16 | 3 Pay | 6 Pay | Resource server fails open on facilitator errors and releases the body when settle fails (overdraft race) | (no direct item) | `merchant/paywall.ts` | `chapter3.test.ts` |
| V17 | 3 Pay | 7 Settle | Facilitator reports a duplicate settle (`nonce_used`) as success, so one payment header buys many responses | (no direct item) | `facilitator/index.ts` | `chapter3.test.ts` |
| V6 | 3 Pay | 6 Pay | The agent's $5/day x402 budget exists only in its system prompt (`agent/prompt.ts`); the ledger never enforces it | ASI02 | `ledger/service.ts` (`transfer`) | `chapter3.test.ts`, `test_chapter3_signed.py` |
| V22 | 3 Pay | 6 Pay | MCP payment-required result: the text copy says VettingCo $0.25, `structuredContent` says attacker $1.00; the agent vets one and signs the other | MCP07-ish, ASI02 | `vendor-mcp`, `agent/runner.ts` | `chapter3.test.ts`, `test_chapter3_signed.py` |
| V29 | 2 Approve | 5 Approve | Approve/reject endpoints are not bound to the CFO's browser session (no cookie/CSRF token/Origin check) | ASI09 | `approval-ui/index.ts` | `chapter2.test.ts`, `test_chapter2.py` |
| V9 | 2 Approve | 8 Audit | Bearer tokens and identity headers written to the request log | MCP01-ish (secret exposure) | `payments-mcp` request logger | `beyond.test.ts`, `test_beyond.py` |
| V11 | 1 Prompt | 2 Plan | One shared assistant memory: planted notes are obeyed by the payments agent; notes readable across identities | MCP06, ASI06-ish | `payments-mcp` `save_note`/`recall_notes`, `agent/runner.ts` | same |
| V12 | 2 Approve | 4 Policy | Batch payments check the daily cap against one stale snapshot | ASI02 | `ledger/service.ts` `createPaymentsBatch` | same |
| V14 | 1 Prompt | 2 Plan | Shadow MCP: any configured server is connected, no approved list | MCP04, ASI04-ish | `agent/runner.ts` | same |
| V20 | 3 Pay | 6 Pay | Price cap read in the wrong unit; a malformed value switches the cap off silently | ASI02 | `agent/x402-client.ts` `parseMaxPrice` | same |
| V21 | 3 Pay | 6 Pay | Payment validity window not bounded; a signed payment never expires | (no direct item) | `facilitator/index.ts` | same |
| V23 | 2 Approve | 3 Identity | ReDoS: caller-supplied regex runs on the server's event loop | MCP05-ish | `payments-mcp` `validate_invoice_ref` | same |
| V24 | 3 Pay | 7 Settle | Receipt (transaction id) accepted without checking payee, amount, resource or reuse | (no direct item) | `merchant/paywall.ts` | same |
| V25 | 3 Pay | 7 Settle | Facilitator sponsors the network fee for every attempt, so failing settlements drain it | (no direct item) | `facilitator/index.ts`, `ledger/service.ts` | same |
| V26 | 2 Approve | 4 Policy | "Emergency override" skips human approval but its $1,000 ceiling is not enforced (chapter 1 PDF `--theft` variant uses it: the injected payment settles with no CFO click) | ASI02, ASI09 | `ledger/service.ts` | same, `intake.test.ts` |
| V27 | 2 Approve | 3 Identity | Services trust any Host header (DNS rebinding) | MCP07 | `common/hostGuard.ts` | same |
| V30 | 2 Approve | 3 Identity | SSRF: server-side fetch of any URL with the internal service key attached, redirects followed | MCP05/MCP07-ish | `payments-mcp` `fetch_remittance_advice` | same |
| V32 | 3 Pay | 1 Ingest | Ambient authority: a project-local `.paypilot.json` is trusted like operator config | MCP04-ish, ASI03 | `agent/settings.ts` | same |
| V33 | 3 Pay | 7 Settle | Facilitator accepts a signed token *approval* as a payment: it checks the instruction belongs to the token program, not which one. Verify passes with no balance, settle moves nothing, the merchant releases the resource | (no direct item) | `facilitator/index.ts` | `sdk-flaws.test.ts` |
| V34 | 3 Pay | 6 Pay | Agent signs a "sign in with your wallet" (SIWx) message from a 402 without checking it names the site it is talking to; a hostile server relays a login message from another site and replays the signature there | MCP07, ASI03 | `agent/x402-client.ts` `buildSignIn`, `merchant/index.ts`, `attacker/rogue-merchant.ts` | `sdk-flaws.test.ts` |
| V10 | Coda Pwn | 8 Report | Command injection in `export_report`; leaks `keys.json` | MCP05, ASI05 | `payments-mcp` | `coda.test.ts`, `test_coda.py` |

Observable but not a switchable bug: **V13**-style audit blindness. After the coda the audit log attributes the approval to `cfo`, and nothing
records that no human clicked.

## Not built
V31 (CI control rot) is documented only and not built. Every other bug in `PUBLIC_BUG_LESSONS.md` is implemented. V33 and V34 come from the October 2026 x402 SDK advisory (see `PUBLIC_BUG_LESSONS.md` L16).

## On-chain bugs (Foundry, `onchain/`)
O1 re-callable initializer -> router takeover -> drain of all allowances; O2 daily-cap bucket chosen by the signer; O3 config signature without
chain/contract binding (cross-deployment replay); O4 reentrancy via a token receiver hook; O5 signed intents never expire; O6 `ecrecover` zero address accepted as a signer; O7 the agent's signature does not cover the amount. Each has a test for the exploit and for the fix. See
`onchain/README.md`. A small example contract, not audited code.

## How the "injection" works (honesty note)
The demo agent is a scripted stand-in for an LLM so live demos never flake. It obeys any line `ASSISTANT_INSTRUCTION: <tool> <json>` found in
text it reads (`src/common/injection.ts`). A real model follows natural-language versions of the same thing, but frontier models often refuse crude
ones, so do not claim "this exact payload works on model X" without testing it.
