# What the third-party scanners say about DVAP

Run with `tooling/third_party_scan.sh` against a vulnerable stack (Cisco `mcp-scanner` 's YARA analyzer, Snyk `agent-scan` 0.6.8 `inspect`).
Only offline analysis was used. Snyk's full `scan` uploads tool metadata to Snyk and needs a token, so it was **not** run.

| Target | Scanner verdict | Bug it relates to | Takeaway |
|---|---|---|---|
| invoice-tools `extract_invoice_fields`, poisoned | **UNSAFE / HIGH: prompt injection** (AITech-1.1) | V1 | Static description scanning catches the crude, in-description payload. |
| invoice-tools, after the rug pull flips to benign | SAFE | V2 | A scan at install time says nothing about later. Needs pinning (V2 fix) or continuous re-scan. |
| invoice-tools `enrich_vendor` | SAFE | V22 | The mismatch is between two halves of a *runtime* result. No description scanner can see it. |
| payments-mcp, all 8 tools | all SAFE | V4, V5, V10 | Over-powered tools, missing scopes and shell injection in a handler are not description problems. |
| Snyk `inspect` | lists the tools only | none | Enumeration only, without verification. |

Conclusion: scanners cover **tool-description poisoning**. Authorization, command injection, payment-protocol logic
and runtime/rug-pull behaviour need code review, tests and runtime policy. DVAP's own `scan_mcp.py` is a heuristic and over-flags free-text parameters.
