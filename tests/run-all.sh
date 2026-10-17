#!/usr/bin/env bash
# Run every test suite that has a run.sh. Usage: bash tests/run-all.sh
cd "$(dirname "$0")"
fail=0
for r in */run.sh; do
  echo "=== $r"
  out=$(bash "$r" 2>&1) && rc=0 || rc=$?
  echo "$out" | tail -3
  [[ $rc -eq 0 ]] || { echo "FAILED ($rc): $r"; fail=1; }
done
exit $fail
