#!/usr/bin/env bash
# Timed dry run of every demo beat, in Docker. Vulnerable pass (the attack works), then a DVAP_HARDEN=all pass
# (the same commands are blocked). Resets the stack before each beat, as the demo pages say. Exits non-zero if any check fails.
# Usage: make rehearse        (needs Docker; ~5-8 min the first time because of image builds)
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROGRESS=quiet
FAIL=0
T0=$SECONDS

check() { # name pattern output
  if grep -Eq -- "$2" <<<"$3"; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s   (expected /%s/)\n' "$1" "$2"; FAIL=1; fi
}
beat() { # name command...  -> runs, prints elapsed, stores output in $OUT
  local name="$1"; shift
  local t=$SECONDS
  OUT="$("$@" 2>&1)" || true
  printf '[%3ss] %s\n' "$((SECONDS - t))" "$name"
}
status() { make -s d-status 2>&1; }

echo "== Pass 1: vulnerable (the attacks work) =="
make -s d-reset
beat "cold open: V15 //v1/premium returns paid data" make -s d-ch3
check "V15 bypass returns free data" "BYPASS WORKS" "$OUT"
check "V7 agent paid the rogue merchant" "Paid \\\$15\\.00" "$OUT"
ST="$(status)"; check "attacker account holds \$15" "acct_globex_drop +\\\$15\\.00" "$ST"

make -s d-reset
beat "Chapter 1: V3 memo injection" make -s d-ch1
check "agent obeyed the memo" "Obeying instruction found in the memo of INV-2002" "$OUT"
ST="$(status)"; check "Globex payment waiting for approval" "PENDING APPROVAL \\(1\\)" "$ST"

make -s d-reset
make -s d-send-invoice >/dev/null 2>&1
beat "Chapter 1 over PDF: V3 through the AP mailbox" make -s d-ch1-pdf
check "agent obeyed the hidden text" "Obeying instruction found in the memo of INV-2003" "$OUT"
check "agent reports success, no refusal" "Result: paid" "$OUT"
ST="$(status)"; check "Globex payment waiting for the CFO" "PENDING APPROVAL \\(1\\)" "$ST"
DS="$(curl -s http://127.0.0.1:4500/api/state)"; check "dashboard shows the pending Globex payment" "pending_approval" "$DS"

make -s d-reset
make -s d-send-invoice ARGS="--theft" >/dev/null 2>&1
beat "Chapter 1 over PDF, money-stolen variant (V26)" make -s d-ch1-pdf
check "payment settled with an override" "settled \\(override" "$OUT"
ST="$(status)"; check "Globex was paid \$9,900 with no CFO click" "acct_globex +\\\$9,900\\.00" "$ST"

make -s d-reset
beat "Chapter 2: V4/V5/V8 escalation (no AI)" make -s d-ch2
check "policy widened with a portal token" "allowed payees now .*p_globex" "$OUT"
ST="$(status)"; check "payment queued behind a cover note" "PENDING APPROVAL \\(1\\)" "$ST"

beat "Coda: V10 -> stolen CFO token" make -s d-coda
check "secrets leaked" "leaked secrets via export_report" "$OUT"
check "payment approved by the stolen token" "settled, approvedBy=cfo" "$OUT"
ST="$(status)"; check "Globex was paid \$9,500" "acct_globex +\\\$9,500\\.00" "$ST"

echo; echo "== Pass 2: DVAP_HARDEN=all (same commands, one flag) =="
make -s d-reset
make -s d-harden H=all >/dev/null 2>&1
beat "Chapter 3 hardened" make -s d-ch3
check "V15 bypass blocked" "no bypass: every variant is paywalled" "$OUT"
check "V7 agent refused the rogue challenge" "challenge_rejected: payee acct_globex_drop is not on the allowlist" "$OUT"
beat "Chapter 1 hardened" make -s d-ch1
check "memo treated as data" "Ignored an instruction embedded in the memo" "$OUT"
make -s d-send-invoice >/dev/null 2>&1
beat "Chapter 1 over PDF hardened" make -s d-ch1-pdf
check "PDF memo treated as data" "Ignored an instruction embedded in the memo of INV-2003" "$OUT"
beat "Chapter 2 hardened" make -s d-ch2
check "escalation stopped at the first step" "BLOCKED: forbidden: missing scope mandate:write" "$OUT"
beat "Coda hardened" make -s d-coda
check "export_report no longer runs a shell" "V10 blocked" "$OUT"
ST="$(status)"; check "no money reached the attacker" "acct_globex_drop +\\\$0\\.00" "$ST"

make -s d-down >/dev/null 2>&1; rm -f .env

echo; echo "== On-chain beat (Foundry on the host, optional) =="
if command -v forge >/dev/null && command -v anvil >/dev/null; then
  beat "onchain tests" make -s onchain-test
  check "all Foundry tests pass" "10 tests passed, 0 failed" "$OUT"
  beat "onchain demo (vulnerable, then fixed)" make -s onchain-demo
  check "O1 stranger drained both users" "mallory \\(USDC\\): 1400" "$OUT"
  check "O1 fixed: init() reverts" "BLOCKED: init\\(\\) reverted" "$OUT"
else
  echo "  SKIP  forge/anvil not installed (curl -L https://foundry.paradigm.xyz | bash && foundryup); skip this beat"
fi
echo; echo "Total: $((SECONDS - T0))s   $([ $FAIL -eq 0 ] && echo 'ALL CHECKS PASSED' || echo 'SOME CHECKS FAILED')"
exit $FAIL
