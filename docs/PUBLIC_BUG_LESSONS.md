# Lessons from public agentic-payment bugs → DVAP bug catalog

Scope: **learning only.** Everything here comes from already-public advisories, merged/open PRs, issues, specs and public code (x402 core, x402 clients/MCP wrappers, MCP SDK advisories). No zero-day hunting, no disclosure, no live traffic. Evidence date: x402 main @ `faa1c69` (2026-10-15).

Naming rule: when you talk or write about these, name the **bug class and the public issue/PR number**, not small downstream projects. Pointing at a hobby repo adds nothing and isn't fair to maintainers.

OWASP mapping legend — MCP = [OWASP MCP Top 10 2025 beta](https://owasp.org/www-project-mcp-top-10/); ASI = OWASP Top 10 for Agentic Applications 2026. Neither list has an item for classic web/protocol bugs (replay, parser differentials, malleability), so those say **no direct item** with the closest fit. Mapping is my judgement, not an official one.

## 1. What the public record teaches (bug classes)

| # | Class | Public evidence | Lesson |
|---|---|---|---|
| L1 | **Gate/router parser differential** — the paywall decides "needs payment?" from a different view of the URL than the router that serves it | GHSA-3j63-5h8p-gf7c (x402-express/hono/next <0.5.2, route-matching bypass, inferred from fix commits); #967 (malformed `%` in query fails open); #3036, #3044, #3073, #3116, #3502, #3542, #3577 (absolute-form target), #3796 (HEAD vs GET), #2475 (Java) — **11+ fixes** | The single most common real payment bug. Authorization computed on a different parse than the one that executes. |
| L2 | **Duplicate settlement / replay window** | GHSA-qr2g-p6q7-w82m (Solana facilitator, same signed tx settled repeatedly in confirmation window; fix = in-memory 120s cache); open: #803, #808, #1645 (verify → handler → settle, `payment-identifier` only declared) | Check-then-act race on a single-use credential. |
| L3 | **Verification result ignored / content before settlement** | #2476 (Go server ignored `isValid:false` on HTTP 200 = full bypass); #2356, #3074, #3392 (body served before settle succeeded) | A `verify` that isn't enforced is decoration. |
| L4 | **Fail-open on error** | #967, #3661, #3697 (batch-settlement store errors swallowed) | Exceptions and backend failures must deny, not allow. |
| L5 | **Silently ineffective control** | #2478 (cap read `parsed.microLamports` instead of `parsed.data.microLamports`; `undefined > n` is false → never fired for months); #3334/#3338 (documented "override ≤ amount" never enforced, still open on main) | A check that is never tested to *fail* gives false assurance. |
| L6 | **Weak binding of signed payload ↔ requirements** | #162 (`authorization.to` not compared to `payTo`); #1388 (`<` instead of `!==` accepted overpay); #3461 (client pays whatever `PAYMENT-REQUIRED` says, no payee pinning anywhere in TS/Go/Py); #3838 (`PaymentPayload.resource` unsigned → SIWX paywall bypass) | The payment is valid for *something*; nothing ties it to *this* resource, payee and price. |
| L7 | **Trusting effects from receipt status** | #3057/#3058/#3059 (Permit2 settle: no Transfer-event check, fee-on-transfer/non-conforming token underpays yet "success"); #3061 (a non-EVM chain), #3063 (SVM) | Success ≠ value delivered. |
| L8 | **Verify/settle mismatch & sponsor draining** | #2701/#2707 (a non-EVM verify path passed unsigned/wrong-key tx); #2477, #2478 (fee-payer drained via gas/CU price) | Facilitator pays gas; unbounded client-chosen fee fields drain it. |
| L9 | **Attacker-controlled schema/pattern consumed by server** | #3039 (Bazaar schema `$ref` SSRF); #3169/#3422 (double-encoded `../`, check-then-canonicalise); #2090/#2340 (ReDoS in amount parsing) | Never fetch, compile or regex attacker input without bounds. |
| L10 | **Trusting request-derived origin** | #2859 (SIWX domain from Host / X-Forwarded-*) | Confused deputy via headers. |
| L11 | **Unsafe numerics** | #2962 (Go percent-override overflow); #3510/#3660 (amount format) | Money math needs big-int and strict grammar. |
| L12 | **Agent-side auto-pay without authenticating the challenge** | #3461, #3463 (MCP client signs `structuredContent` without comparing to text; text-only challenge also auto-signs), #3438 (fresh authorization minted per 402), #3614 (`validBefore` taken from server's `maxTimeoutSeconds`, ~10-year window possible), #3812 | The agent is the weakest link: it trusts the server it is paying. |
| L13 | **Ambient authority / default-allow** | public client designs: default auto-approve callbacks; cap compared on LLM-supplied option while signer uses server's fresh 402; `startsWith` allowlist matching `api.example.com.evil.io`; raw-unit caps compared across assets; redirect followed and payment header replayed to the final URL | Cap/allowlist implemented *beside* the signing path instead of *in* it. |
| L14 | **MCP SDK transport/auth advisories** | python-sdk: GHSA-w4fh-qvv9-3v23 (bearer token for *another* resource accepted), GHSA-jpw9-pfvf-9f58 (session served without verifying principal), GHSA-qx49-fqc8-xw99 (OAuth client sends credentials to server-chosen AS), GHSA-5h93-6whr-6q8j (cross-origin redirect re-sends headers/body), GHSA-9h52-p55h-vw2f (DNS rebinding off by default); typescript-sdk: GHSA-jm63-cq47-j5jp / GHSA-345p-7cg4-v4c7 (shared transport leaks one client's messages to another), GHSA-22jm-h49p-29qw (tasks not bound to session) | MCP-layer identity/session binding bugs are real and recent. |
| L15 | **CI/supply-chain control rot** | #3745/#3791 (commit-signing check silently stops when GitHub blocks `pull_request_target`) | Controls can decay without any code change. |

Also worth noting: **spec-level trust assumptions** the protocol states openly (`upto`/batch amounts are server-declared, #3001/#3003; facilitator must be trusted). Not bugs — but they are exactly where a malicious facilitator or resource server lives.

## 2. DVAP catalog entries drawn from the public record

V1–V14 are the original catalog (see `BUG_CATALOG.md`). Added/refined from the public record (all toggled by `DVAP_HARDEN=<id>`):

| ID | DVAP bug | Modeled on | OWASP MCP | OWASP ASI | Tier |
|---|---|---|---|---|---|
| V7+ | **Unauthenticated 402: no payee pin, no max price, no challenge signature** (extends V7) | L6/L12 #3461 | MCP07 | ASI02 | **Demo 3** |
| V15 | **Paywall gate/router differential** — gate matches regex on raw path; `//premium`, `/%70remium`, `HEAD`, malformed `%` all skip it | L1 | MCP07 | no direct item (ASI02 closest) | **Demo 3 opener** (pure `curl`, zero LLM) |
| V16 | **Verify ignored / fail-open** — resource server serves content when verify errors or returns `isValid:false` | L3, L4 | MCP07 | no direct item | Lab |
| V17 | **Duplicate settlement** — no dedupe; 5 concurrent `/settle` → 5 deliveries for 1 payment | L2 | MCP07 | no direct item (ASI08 closest) | Lab (was V12) |
| V18 | **Payment not bound to resource** — payload valid across routes/tools | L6 #3838 | MCP07 | ASI02 | **Demo 3** |
| V19 | **Redirect-following payer** — pays the 402 from the final URL and replays the payment header along the redirect chain | L13 | MCP07 | ASI02 | **Demo 3** |
| V20 | **Silent cap / unit-confused cap** — cap reads wrong field (`undefined > n`) or compares raw units across assets | L5, L13 | MCP02 | ASI02 | Lab (strong teaching bug) |
| V21 | **Unbounded validity window** — `validBefore` taken from server's `maxTimeoutSeconds` | L12 #3614 | no direct item | ASI02 | Lab |
| V22 | **MCP auto-pay: default-approve + structured/text challenge mismatch** — text says 1 USDC, structured field says 100 | L12 #3463 | MCP06 | ASI01, ASI09 | **Demo 1/3 bridge** |
| V23 | **Facilitator input handling** — client-supplied schema with `$ref` SSRF; ReDoS amount regex | L9 | MCP05 (closest) | ASI05 (closest) | Lab |
| V24 | **Settle success without transfer check** — fee-on-transfer token underpays but ledger books success | L7 | no direct item | no direct item | Lab |
| V25 | **Sponsor draining** — facilitator pays fees; client sets huge fee field | L8 | no direct item | ASI08 (closest) | Lab |
| V26 | **Settlement override ceiling unenforced** | L5 #3334 | MCP02 | ASI02 | Lab |
| V27 | **Host-header-derived identity binding** | L10 | MCP07 | ASI03 | Lab |
| V28 | **Paid-response injection** — paid content flows straight into the model | L12 | MCP06 | ASI01 | with Demo 1 |
| V29 | **MCP session/token binding** — bearer accepted for any audience; session not bound to authenticated principal; shared transport leaks across clients | L14 | MCP07, MCP10 | ASI03 | **Demo 2** |
| V30 | **Cross-origin redirect leaks credentials/headers** in MCP client | L14 | MCP01 | ASI03 | Lab |
| V31 | **CI control rot** — signature/policy check silently stops running (workflow trigger change) | L15 | MCP04 | ASI04 | Slide only (no demo) |
| V32 | **Ambient authority in agent config** — pre-approved wildcard `Bash(curl *)`-style permissions; agent signs by hand with a raw key, taking payTo/amount from the 402 | L13 | MCP02 | ASI02, ASI03 | Lab |

Already in the original catalog and confirmed by the public record: V5/V6 (agent can change or bypass its own limits), V1–V3 (tool poisoning/injection), V8 (approval spoofing).

## 3. How the bugs map to the four demos

1. **Demo 1, Prompt:** V3 (instructions in an invoice memo), with V5 and V8 in the chain; optional V1, V2, V28 (poisoned tool, rug pull, injection in a paid response) and V26 (override without a ceiling).
2. **Demo 2, Approve (no AI):** V4, V5, V8, V29 (header identity, self-editable limits, spoofed approval screen, approval not bound to the approver's session).
3. **Demo 3, Pay:** V15 (`//premium` path bypass, zero AI) then V7 (payee swap); V6, V16 to V19 and V22 are covered by tests.
4. **Demo 4, Pwn (no AI):** V10 (command injection leaking keys) and the audit gap V13.

Other switchable bugs (the "lab tier"): V9, V11, V12, V14, V20, V21, V23 to V25, V27, V30, V32. Not built: V31 and the spec-level trust assumptions, which are documented only.

## 4. Why these bugs

- **They are real and recent.** Every item cites a public advisory, PR or issue number anyone can look up.
- **Hardening is visible in the record.** x402 core now defaults to a $1 per-payment cap and default assets; the open #3461 (no payee pin) shows the gap that remains. "Even the reference implementation is mid-fix" is a useful, honest message.
- **Pattern for defenders:** put the control *in* the signing path (cap, allowlist, binding, challenge authentication), test that it fails when it should (L5), fail closed (L4), and bound every attacker-supplied number, string and URL (L9, L11).

## 5. Caveats

- Advisory text for the two x402 GHSAs is sparse; their root causes above are **inferred** from fix commits (60af9356, 7cd93d8b) and should be labelled "inferred" if shown.
- OWASP item mapping is judgement (see legend); both lists are young and don't cover protocol-level payment bugs.
- Evidence comes from reading code and issues, not from running exploits against third-party software; our own DVAP versions will be the only things demonstrated live.
