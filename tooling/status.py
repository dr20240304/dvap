#!/usr/bin/env python3
"""Demo helper: print balances, pending payments and recent audit entries of a running `make dev` stack.

  status.py [--tokens]     (--tokens also prints the supplier-portal token the Chapter 2 attacker holds)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dvap_env import keys, ledger_get as get  # noqa: E402


def usd(m):
    return f"${int(m) / 1e6:,.2f}"


print("BALANCES")
for a in ("acct_acme_operating", "acct_agent_wallet", "acct_vettingco", "acct_initech", "acct_hooli", "acct_globex", "acct_globex_drop", "acct_facilitator_gas", "acct_network_fees"):
    print(f"  {a:<22} {usd(get(f'/accounts/{a}')['balance']):>12}")
pend = get("/payments?status=pending_approval")["payments"]
print(f"\nPENDING APPROVAL ({len(pend)})")
for p in pend:
    print(f"  {p['id']}  {usd(p['amount'])} -> {p['payeeName']} ({p['invoiceId']})  note={p['note']!r}")
print("\nRECENT AUDIT")
for e in reversed(get("/audit?limit=8")["entries"]):
    print(f"  {e['ts'][11:19]}  {e['actor']:<12} {e['action']}")
if "--tokens" in sys.argv:
    print(f"\nportal token (supplier-held): {keys()['portalToken']}")
