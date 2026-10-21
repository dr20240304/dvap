#!/usr/bin/env bash
# Live on-chain beat: O1 (re-callable init -> router takeover -> drain) on a local anvil, vulnerable then fixed.
# Needs foundry (forge, anvil). ~10 s. Usage: onchain/demo.sh [fixes]   (default runs both passes)
set -euo pipefail
cd "$(dirname "$0")"
PORT=8545
anvil --port $PORT --silent & ANVIL=$!
trap 'kill $ANVIL 2>/dev/null' EXIT
until curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' http://127.0.0.1:$PORT >/dev/null; do sleep 0.3; done
run() { FIXES=$1 forge script script/Demo.s.sol --rpc-url http://127.0.0.1:$PORT --broadcast 2>&1 | grep -E '^  (router|admin|alice|mallory|BLOCKED)|Error|Insufficient' || true; }
if [ $# -gt 0 ]; then run "$1"; else
  echo "== vulnerable =="; run 0
  echo; echo "== fixed (O1) =="; run 1
fi
