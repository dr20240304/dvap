#!/usr/bin/env bash
# Run llm-eval for several Ollama models and both injection styles; writes one text file per (model, style) to $OUT.
# Usage: scripts/llm-sweep.sh "qwen3:4b qwen3:8b" [trials] [outdir]
set -uo pipefail
cd "$(dirname "$0")/.."
MODELS="${1:?models}"; TRIALS="${2:-5}"; OUT="${3:-llm-sweep}"
mkdir -p "$OUT"
for m in $MODELS; do
  for style in grammar natural; do
    sc="control,v3,v1,v28"; [ "$style" = natural ] && sc="v3,v1,v28"
    f="$OUT/$(echo "$m" | tr ':/' '__')--$style.txt"
    echo "== $m ($style)"
    DVAP_INJECTION=$style npm run -s llm-eval -- --model "$m" --trials "$TRIALS" --scenarios "$sc" --configs none > "$f" 2>&1 || true
  done
done
echo SWEEP_DONE
