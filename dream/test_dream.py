"""Smallest check that fails if apply breaks: archive / restore / desc / merge / pin / stale / retention gate.
Run: uv run python dream/test_dream.py   (temp dir + temp git repo; never touches the real vault)
"""
import json, os, subprocess, sys, tempfile, time

tmp = tempfile.mkdtemp()
mem = f"{tmp}/pi-memory"
os.makedirs(mem)
os.environ.update(DREAM_MEM=mem, DREAM_STATE=f"{tmp}/state")
sys.path.insert(0, os.path.dirname(__file__))
import dream  # noqa: E402


def note(n, body, extra="", desc="d"):
    open(f"{mem}/{n}.md", "w").write(f'---\ndescription: "{desc}"\ncreated: 2026-01-01\nupdated: 2026-01-01\n{extra}tags:\n  - pi-memory\n---\n\n{body}\n')


def sh(*a):
    subprocess.run(a, cwd=tmp, check=True, capture_output=True)


for n in ("old", "pin", "dsc", "a-b-one", "a-b-two", "a-b-three", "chg"):
    note(n, f"body of {n} `x.ts` deadbeef1 12 KB", "pinned: true\n" if n == "pin" else "", desc="long " * 40 if n == "dsc" else "d")
sh("git", "init", "-q"); sh("git", "add", "-A"); sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
m = lambda n: os.path.getmtime(f"{mem}/{n}.md")
srcs = ["a-b-one", "a-b-two", "a-b-three"]
good = "merged `x.ts` deadbeef1 12 KB"
ops = [
    dict(op="archive", name="old", reason="test", mtime=m("old")),
    dict(op="archive", name="pin", reason="must be refused", mtime=m("pin")),
    dict(op="archive", name="chg", reason="changed since plan", mtime=m("chg") - 5),
    dict(op="desc", name="dsc", old="", new="short desc", mtime=m("dsc")),
    dict(op="merge", name="a-b-merged", desc="m", body=good, sources=srcs, ok=True, mtimes={s: m(s) for s in srcs}),
    dict(op="merge", name="lossy", desc="m", body="nothing kept", sources=["chg"], ok=True, mtimes={"chg": m("chg")}),
]
pj = f"{tmp}/plan.json"
json.dump(dict(ops=ops), open(pj, "w"))
dream.apply(pj)
ex = lambda p: os.path.exists(f"{mem}/{p}.md")
assert not ex("old") and ex("archive/old"), "archive"
assert ex("pin") and not ex("archive/pin"), "pinned file must never move"
assert ex("chg"), "stale op must be skipped"
assert ex("a-b-merged") and all(ex(f"archive/{s}") and not ex(s) for s in srcs), "merge"
assert "merged_from" in open(f"{mem}/a-b-merged.md").read()
assert not ex("lossy"), "retention gate"
# restore
json.dump(dict(ops=[dict(op="restore", name="old", reason="t")]), open(pj, "w"))
dream.apply(pj)
assert ex("old") and not ex("archive/old") and "archived" not in open(f"{mem}/old.md").read(), "restore"
assert subprocess.run(["git", "log", "--oneline"], cwd=tmp, capture_output=True, text=True).stdout.count("dream") == 2, "one commit per apply"
print("ok")
