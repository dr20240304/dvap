# Hints (spoiler levels)

DVAP is one system with its bugs placed along the 8 steps of a payment flow. Each file gives **three hint levels** per step: read only as far as you need.
Try first: `make scan URL=http://127.0.0.1:4100/mcp TOKEN=<portal token>` and `python3 tooling/status.py`.
Bug IDs and fixes (`DVAP_HARDEN=<id>`) are in `docs/BUG_CATALOG.md`: that file is a spoiler.

| Step | File |
|---|---|
| 1 Ingest, 2 Plan | `01-prompt.md` |
| 3 Identity, 4 Policy, 5 Approve | `02-approve.md` |
| 6 Pay | `03-pay.md` |
| 7 Settle, 8 Audit/Report | `04-pwn.md` |
