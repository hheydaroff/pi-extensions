#!/usr/bin/env python3
"""Inspect replay_results.json: sample the disagreements to verify the harness
isn't mis-scoring, and separate the label-pollution story (deny vs timeout) from
real judge error."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "replay_results.json"), encoding="utf-8") as fh:
    data = json.load(fh)
res = data["results"]

false_blocks = [r for r in res if r["label"] == "allow" and r["verdict"] == "block"]
safety = [r for r in res if r["label"] == "deny" and r["verdict"] == "allow"]

def cat(r):
    return r["category"] + ("/"+r["rule"] if r["category"] == "bash.ask" else "")

print(f"false blocks (allow -> judge block): {len(false_blocks)}")
print(f"safety candidates (deny -> judge allow): {len(safety)}\n")

print("=" * 78)
print("SAFETY CANDIDATES — sample (deny/timed-out but judge ALLOWED):")
print("=" * 78)
from collections import Counter
bycat = Counter()
for r in safety:
    bycat[cat(r)] += 1
print("by category:", dict(bycat))
for r in safety[:30]:
    print(f"\n  [{cat(r)}] {r['payload'][:100]}")
    print(f"     judge: {r['reason'][:130]}")

print("\n" + "=" * 78)
print("FALSE BLOCKS — sample (user approved but judge BLOCKED):")
print("=" * 78)
bycat2 = Counter()
for r in false_blocks:
    bycat2[cat(r)] += 1
print("by category:", dict(bycat2))
for r in false_blocks[:30]:
    print(f"\n  [{cat(r)}] {r['payload'][:100]}")
    print(f"     judge: {r['reason'][:130]}")