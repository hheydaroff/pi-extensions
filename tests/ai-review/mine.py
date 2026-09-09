#!/usr/bin/env python3
"""Mine ~/.pi/agent/sessions for labelled security-log judgement pairs.

Produces the labelled corpus for the phase-2 replay: every unique
(category, rule, payload) that has a human verdict, tagged allow / deny / both,
plus a junk heuristic so the replay can separate extractor noise from genuine
judgement calls.

Writes results to JSON (not heredoc / not stdout-embedded) so the replay script
can read it without re-mining, and so nothing here trips the live bash rules.
"""
import collections
import glob
import json
import os
import re
import sys

ROOT = os.path.expanduser("~/.pi/agent/sessions")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "labelled_corpus.json")

HUMAN = {"approved_by_user", "blocked_by_user"}
# Verdicts that are *not* a usable human label (still counted for the report):
OTHER = {"expired", "approved_by_ai", "escalated_to_user", "blocked"}

# Junk heuristic for boundary payloads. A boundary payload is junk when it is
# NOT a real filesystem path: degenerate strings, sed/awk range delimiters, or
# single/multi-segment paths whose leading segment is not a real macOS top-level
# directory. Real top-levels (and ~/ and ./ .. relative paths) are genuine.
REAL_TOP = {"applications", "system", "library", "users", "bin", "sbin", "etc",
            "var", "tmp", "usr", "opt", "private", "dev", "volumes", "cores",
            "net", "home", "srv", "root", "mnt"}
DEGENERATE = {"/", "//", "/*", "/*/", "/**", "/-", "/\\", "/^", "/$"}

def is_junk(category, payload):
    if category != "boundary":
        return False  # bash.ask payloads are full commands, not path fragments
    p = (payload or "").strip()
    if not p:
        return True
    if p in DEGENERATE or p.startswith("/dev/null"):
        return True
    # sed/awk/ex range delimiters or code fragments: commas between slash ranges,
    # awk action blocks, html/script tags, trailing fragment punctuation
    if re.search(r"\{f=|;next|,/|,\+|,\$", p) or "<" in p or ">" in p or "(" in p:
        return True
    if p[-1:] in (")", ",", ":", ";"):
        return True
    if p.startswith("~") or p.startswith("."):
        return False  # home-relative or relative — genuine
    if not p.startswith("/"):
        return False
    seg = p.lstrip("/").split("/")[0].lower()
    if not seg:
        return True  # //// degenerate
    return seg not in REAL_TOP


def walk_commands(node, out, depth=0):
    if depth > 8:
        return
    if isinstance(node, dict):
        # pi stores an assistant bash invocation as {"type":"toolCall","name":"bash","arguments":{"command":...}}
        if node.get("type") == "toolCall" and node.get("name") == "bash":
            args = node.get("arguments")
            if isinstance(args, dict) and isinstance(args.get("command"), str):
                out.append(args["command"])
        elif node.get("type") == "tool_use" or node.get("name") == "bash":
            inp = node.get("input")
            if isinstance(inp, dict) and "command" in inp:
                out.append(inp["command"])
            elif isinstance(inp, str) and inp.strip():
                out.append(inp)
        for v in node.values():
            walk_commands(v, out, depth + 1)
    elif isinstance(node, list):
        for v in node:
            walk_commands(v, out, depth + 1)


def main():
    files = sorted(glob.glob(os.path.join(ROOT, "*", "*.jsonl")))
    cat_action = collections.Counter()
    pairs = {}  # (category, rule, payload) -> dict(label counts, tool, examples)

    for fp in files:
        try:
            with open(fp, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError:
            continue

        # Recover the session working directory (ctx.cwd at the time). pi records one
        # session-level cwd — not the shell's cd state — so it is exactly what the live
        # guard sees. The replay uses it instead of a fixed cwd, so a `../app` resolves
        # where it really did rather than against a stand-in repo.
        session_cwd = ""
        for line in lines:
            try:
                o = json.loads(line)
                if isinstance(o, dict) and o.get("type") == "session" and isinstance(o.get("cwd"), str):
                    session_cwd = o["cwd"]
                    break
            except Exception:
                continue

        # First collect bash commands from this session (for command reconstruction).
        session_cmds = []
        for line in lines:
            if '"tool_use"' not in line and '"command"' not in line:
                continue
            try:
                walk_commands(json.loads(line), session_cmds)
            except Exception:
                continue

        for idx, line in enumerate(lines):
            if '"security-log"' not in line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "custom" or obj.get("customType") != "security-log":
                continue
            d = obj.get("data") or {}
            action = d.get("action")
            if not action:
                continue
            cat_action[(d.get("category"), action)] += 1

            if action not in HUMAN:
                continue
            category = d.get("category") or ""
            rule = d.get("rule") or ""
            payload = d.get("input") or ""
            tool = d.get("tool") or ""
            key = (category, rule, payload, session_cwd)
            rec = pairs.setdefault(key, {
                "category": category, "rule": rule, "payload": payload,
                "tool": tool, "cwd": session_cwd, "allow": 0, "deny": 0,
                "command": "", "junk": is_junk(category, payload),
            })
            if tool and not rec["tool"]:
                rec["tool"] = tool
            if action == "approved_by_user":
                rec["allow"] += 1
            else:
                rec["deny"] += 1
            # best-effort command reconstruction for boundary (path-only) entries:
            if not rec["command"]:
                import shlex
                for c in session_cmds:
                    if isinstance(c, str) and payload and payload in c:
                        rec["command"] = c
                        break

    # summarise
    rows = list(pairs.values())
    both = [r for r in rows if r["allow"] > 0 and r["deny"] > 0]
    allow_only = [r for r in rows if r["allow"] > 0 and r["deny"] == 0]
    deny_only = [r for r in rows if r["deny"] > 0 and r["allow"] == 0]
    junk = [r for r in rows if r["junk"]]
    junk_non_trivial = [r for r in rows if r["junk"] and (r["allow"] or r["deny"])]

    print(f"session files scanned:  {len(files)}")
    print(f"security-log entries:  {sum(cat_action.values())}")
    print(f"\ncategory x action (all):")
    cats = sorted({c for c, _ in cat_action})
    for c in cats:
        parts = "  ".join(f"{a}={cat_action[(c, a)]}" for a in
                          ("approved_by_user", "blocked_by_user", "expired",
                           "approved_by_ai", "escalated_to_user", "blocked")
                          if cat_action[(c, a)])
        print(f"  {c:20} {parts}")
    print(f"\nunique labelled pairs:  {len(rows)}")
    print(f"  allow-only:           {len(allow_only)}")
    print(f"  deny-only:            {len(deny_only)}")
    print(f"  both-ways:            {len(both)}")
    print(f"  junk-flagged:         {len(junk)}")
    print(f"  junk with verdict:    {len(junk_non_trivial)}")

    with_command = sum(1 for r in rows if r["command"])
    print(f"  boundary w/ command:  {with_command}")

    # category breakdown of labelled pairs
    print(f"\nlabelled pairs by category:")
    for c in sorted({r['category'] for r in rows}):
        rr = [r for r in rows if r['category'] == c]
        print(f"  {c:20} {len(rr):5}")

    # dump boundary payloads (distinct) sorted by frequency, to eyeball junk vs genuine
    print(f"\nboundary payloads by frequency (top 120):")
    bdist = collections.Counter()
    for r in rows:
        if r["category"] == "boundary":
            bdist[r["payload"]] += r["allow"] + r["deny"]
    for p, n in bdist.most_common(120):
        lbl = [r for r in rows if r["category"] == "boundary" and r["payload"] == p][0]
        tag = "junk" if lbl["junk"] else "     "
        print(f"  {tag}  {n:4}  a={lbl['allow']:3} d={lbl['deny']:3}  {p[:70]}")

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump({"pairs": rows,
                   "counts": {f"{c}\u0000{a}": n for (c, a), n in cat_action.items()}},
                  fh, ensure_ascii=False, indent=1)
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())