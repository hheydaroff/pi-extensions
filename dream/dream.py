#!/usr/bin/env python3
"""dream — nightly consolidation of pi-memory ("deep sleep").

  dream.py plan  [--force]   score memories, ask the model, write plan.json + report.md (changes NOTHING)
  dream.py apply [plan.json] validate every op, apply, lint, one git commit (default: latest plan)
  dream.py status

The model never touches files (pi -p --no-tools); it only returns text that this script
validates. Forgetting = move to pi-memory/archive/ (not indexed, still readable via
vault_memory read). Design + evidence: pi-memory/memory-dream-consolidation-design.md
"""
import datetime, glob, hashlib, json, math, os, re, subprocess, sys, tempfile, time
from collections import Counter, defaultdict

HOME = os.path.expanduser("~")
TODAY = datetime.date.today()
STATE = os.environ.get("DREAM_STATE", f"{HOME}/.pi/agent/dream")
SESSIONS = f"{HOME}/.pi/agent/sessions"
MAX_ARCHIVE = int(os.environ.get("DREAM_MAX_ARCHIVE", 25))
MAX_DESC = int(os.environ.get("DREAM_MAX_DESC", 60))
MAX_MERGES = int(os.environ.get("DREAM_MAX_MERGES", 4))
PRUNE_DAYS, THRESHOLD, READ_BASELINE = 45, 0.3, 10   # baseline 10 not AWS's 50: one-user corpus
MIN_AGE_DAYS, HOT_DAYS = 21, 2          # never archive <21d old, never touch files edited <2d ago
DESC_MAX = 120
KEEP_IDS = 0.85                         # merged note must retain this share of source identifiers
# evergreen by nature: decay must not nominate these (dry-run flagged playbooks/checklists)
EVERGREEN = re.compile(r"thesis|decision|kill|playbook|ledger|contract|policy|exam|checklist|method|gotcha|design|rules?|preferences|roadmap")


def mem_dir():
    if os.environ.get("DREAM_MEM"):
        return os.environ["DREAM_MEM"]
    s = json.load(open(f"{HOME}/.pi/agent/settings.json"))
    return s["vaultMemory"]["memoryPath"].replace("~", HOME, 1)


MEM = mem_dir()


def cfg_model():
    """env DREAM_MODEL > $STATE/config.json {"model": "..."} > Haiku 4.5. Any `pi --list-models` id works."""
    try:
        m = json.load(open(f"{STATE}/config.json")).get("model")
    except Exception:
        m = None
    return os.environ.get("DREAM_MODEL") or m or "amazon-bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0"


MODEL = cfg_model()
ARCH = f"{MEM}/archive"


# ───────────────────────── reading the store ─────────────────────────
def split_fm(t):
    m = re.match(r"---\n(.*?)\n---\n?", t, re.S)
    return (m.group(1), t[m.end():]) if m else ("", t)


def fm_get(fm, key):
    m = re.search(rf"^{key}:\s*(.+)$", fm, re.M)
    return m.group(1).strip().strip("\"'") if m else None


def fm_set(fm, key, val):
    line = f"{key}: {val}"
    if re.search(rf"^{key}:.*$", fm, re.M):
        return re.sub(rf"^{key}:.*$", lambda _: line, fm, count=1, flags=re.M)
    return fm + ("\n" if fm else "") + line


def fm_del(fm, key):
    return re.sub(rf"^{key}:.*\n?", "", fm, flags=re.M).strip("\n")


def date(s, default=TODAY):
    try:
        return datetime.date.fromisoformat(s[:10])
    except Exception:
        return default


def read_counts():
    """name -> sorted read dates, rebuilt from session logs (no instrumentation needed)."""
    reads = defaultdict(list)
    pat = re.compile(r"pi-memory/(?:archive/)?([a-z0-9][a-z0-9\-]*)\.md")
    for d, _, fs in os.walk(SESSIONS):
        for f in fs:
            if not f.endswith(".jsonl"):
                continue
            for line in open(os.path.join(d, f), errors="ignore"):
                if "pi-memory" not in line and "vault_memory" not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                c = (o.get("message") or {}).get("content")
                if not isinstance(c, list):
                    continue
                ts = (o.get("timestamp") or "")[:10]
                for b in c:
                    if b.get("type") != "toolCall":
                        continue
                    a = b.get("arguments") or {}
                    if b.get("name") == "vault_memory" and a.get("action") == "read" and a.get("name"):
                        reads[re.sub(r"[^a-z0-9]+", "-", a["name"].lower()).strip("-")].append(ts)
                    elif b.get("name") in ("read", "bash"):
                        s = json.dumps(a)
                        if b["name"] == "read" or re.search(r"\b(cat|head|tail|sed|rg|grep)\b", s):
                            for n in pat.findall(s):
                                reads[n].append(ts)
    return reads


def scan(reads):
    rows = {}
    for p in sorted(glob.glob(f"{MEM}/*.md")):
        n = os.path.basename(p)[:-3]
        t = open(p, errors="ignore").read()
        fm, body = split_fm(t)
        created, updated = date(fm_get(fm, "created") or ""), date(fm_get(fm, "updated") or "")
        r = sorted(reads.get(n, []))
        since = (TODAY - max([updated] + ([date(r[-1])] if r else []))).days
        age = (TODAY - created).days
        rate = -math.log(THRESHOLD) / PRUNE_DAYS
        score = 0.4 * math.exp(-rate * age) + 0.35 * math.exp(-rate * since) + 0.25 * min(len(r) / READ_BASELINE, 1)
        desc = fm_get(fm, "description") or ""
        rows[n] = dict(name=n, desc=desc, size=len(t), age=age, since=since, reads=len(r), score=round(score, 3),
                       pinned=(fm_get(fm, "pinned") or "").lower() == "true", evergreen=bool(EVERGREEN.search(n)),
                       mtime=os.path.getmtime(p), body=body.strip(), idx=len(n) + len(desc) + 8)
    return rows


def idx_tokens(rows):
    return sum(r["idx"] for r in rows.values()) // 4


# ───────────────────────── model calls ─────────────────────────
def llm(prompt, data):
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(data)
    try:
        for attempt in (1, 2):
            r = subprocess.run(["pi", "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
                                "--no-context-files", "--no-prompt-templates", "--model", MODEL, f"@{f.name}", prompt],
                               capture_output=True, text=True, timeout=900)
            if r.returncode == 0 and r.stdout.strip():  # haiku wraps replies in ``` fences
                return re.sub(r"\A```[a-z]*\n|\n```\Z", "", r.stdout.strip())
        raise RuntimeError(f"pi -p failed: {r.stderr[:300]}")
    finally:
        os.unlink(f.name)


def llm_json(prompt, data):
    out = llm(prompt + "\nReply with ONE JSON object and nothing else.", data)
    out = re.sub(r"^```(?:json)?|```$", "", out.strip(), flags=re.M).strip()
    return json.loads(out[out.index("{"): out.rindex("}") + 1])


ARCHIVE_PROMPT = """You are the nightly memory-consolidation step for a personal agent memory store (sleep-time pruning).
The attached file lists memory notes that a decay score nominated for ARCHIVE (moved out of the always-loaded index; still readable on demand).
Archive a note when it is a finished-project log, a superseded state snapshot, a one-off investigation whose outcome lives elsewhere, or a test artifact.
KEEP a note when it holds a decision/thesis/constraint still in force, a reusable procedure or gotcha, a user preference, or facts that would be costly to re-derive. When unsure, KEEP.
JSON schema: {"archive":[{"name":"...","reason":"<=15 words"}],"keep":["name",...]}"""

DESC_PROMPT = f"""Rewrite each memory note's index description to at most {DESC_MAX} characters.
Format: "<what it is> — <the hook that tells a future agent when to read it>". Keep the single most retrieval-relevant specifics (names, ids, dates). No quotes inside. Plain text.
JSON schema: {{"desc":{{"<name>":"<new description>"}}}}"""

GROUP_PROMPT = """Below are memory notes sharing a name prefix. Propose merge groups: 3-8 notes that document the same subsystem/feature-thread and would read better as ONE note (as-built details of one component, successive fixes to the same thing).
Do not group notes about unrelated topics just because the prefix matches. Leave singletons out. Prefer fewer, coherent groups.
JSON schema: {"groups":[{"topic":"short-kebab-topic","members":["name",...]}]}"""

MERGE_PROMPT = f"""Merge the attached memory notes into ONE note. This is lossless consolidation, not summarisation:
- Keep every commit hash, file path, function/flag name, number with its unit, error string, root cause, decision and gotcha. Drop only repetition, narrative filler and superseded intermediate states (keep the final state and *why* it changed).
- Convert relative dates to absolute. If notes contradict, keep the newest and say what changed.
- Structure with headings per sub-topic. No preamble.
Output format exactly:
NAME: <kebab-case new name>
DESC: <=  {DESC_MAX} chars, "<what> — <when to read>">
-----
<markdown body>"""


def ids_of(text):
    s = set(re.findall(r"`([^`\n]{3,80})`", text))
    s |= set(re.findall(r"\b[0-9a-f]{7,40}\b", text))
    s |= set(re.findall(r"[\w./-]+\.(?:ts|tsx|py|md|json|sh|yml|yaml|sql)\b", text))
    s |= set(re.findall(r"\b\d+(?:\.\d+)?\s?(?:%|ms|pt|KB|MB|k|s)\b", text))
    return s


def retention(sources, merged):
    want = set().union(*(ids_of(t) for t in sources))
    return (sum(1 for i in want if i in merged) / len(want)) if want else 1.0, want


# ───────────────────────── plan ─────────────────────────
def gate(force):
    st = json.load(open(f"{STATE}/state.json")) if os.path.exists(f"{STATE}/state.json") else {}
    last = st.get("lastPlan", 0)
    if force or not last:
        return True
    hours = (time.time() - last) / 3600
    new = sum(1 for p in glob.glob(f"{SESSIONS}/*/*.jsonl") if os.path.getmtime(p) > last)
    print(f"gate: {hours:.0f}h since last plan, {new} new sessions")
    return hours >= 24 and new >= 5


def plan(force=False):
    os.makedirs(f"{STATE}/plans", exist_ok=True)
    if not gate(force):
        print("gate closed (need >=24h and >=5 new sessions); --force to override")
        return None
    lock = f"{STATE}/lock"
    try:
        if os.path.exists(lock) and time.time() - os.path.getmtime(lock) > 7200:
            os.unlink(lock)
        os.close(os.open(lock, os.O_CREAT | os.O_EXCL))
    except FileExistsError:
        print("another dream is running")
        return None
    try:
        return _plan()
    finally:
        os.path.exists(lock) and os.unlink(lock)


def _plan():
    reads = read_counts()
    rows = scan(reads)
    now = time.time()
    hot = {n for n, r in rows.items() if now - r["mtime"] < HOT_DAYS * 86400}
    ops = []

    # 0. restore: archived note read again after it was archived
    for p in glob.glob(f"{ARCH}/*.md"):
        n = os.path.basename(p)[:-3]
        fm, _ = split_fm(open(p, errors="ignore").read())
        since = date(fm_get(fm, "archived") or "", datetime.date.min)
        if n not in rows and any(date(d) > since for d in reads.get(n, [])):
            ops.append(dict(op="restore", name=n, reason="read again after archiving"))

    # 1. archive
    cand = sorted((r for r in rows.values() if r["score"] < THRESHOLD and not r["pinned"] and not r["evergreen"]
                   and r["age"] >= MIN_AGE_DAYS and r["name"] not in hot), key=lambda r: r["score"])[:MAX_ARCHIVE * 2]
    merged_away = set()
    if cand:
        data = "\n\n".join(f"### {r['name']}\nreads={r['reads']} age={r['age']}d size={r['size']//1024}KB score={r['score']}\n"
                           f"desc: {r['desc']}\n{r['body'][:500]}" for r in cand)
        res = llm_json(ARCHIVE_PROMPT, data)
        ok = {r["name"] for r in cand}
        ops += [dict(op="archive", name=a["name"], reason=a.get("reason", ""), mtime=rows[a["name"]]["mtime"])
                for a in res.get("archive", []) if a.get("name") in ok][:MAX_ARCHIVE]
    archived = {o["name"] for o in ops if o["op"] == "archive"}

    # 2. merge clusters
    clusters = defaultdict(list)
    for r in rows.values():
        k = "-".join(r["name"].split("-")[:2])
        if not r["pinned"] and r["name"] not in archived and r["name"] not in hot and len(r["name"].split("-")) > 2:
            clusters[k].append(r["name"])
    merges = 0
    for k, names in sorted(clusters.items(), key=lambda kv: -len(kv[1])):
        if len(names) < 6 or merges >= MAX_MERGES:
            continue
        listing = "\n".join(f"- {n}: {rows[n]['desc'][:200]}" for n in names)
        try:
            groups = llm_json(GROUP_PROMPT, listing).get("groups", [])
        except Exception as e:
            print("group pass failed", k, e)
            continue
        groups = sorted((g for g in groups if 3 <= len(g.get("members", [])) <= 8 and set(g["members"]) <= set(names)),
                        key=lambda g: -sum(rows[m]["size"] for m in g["members"]))
        for g in groups:
            if merges >= MAX_MERGES or set(g["members"]) & merged_away:
                continue
            src = [rows[m]["body"] for m in g["members"]]
            data = "\n\n=====\n\n".join(f"# SOURCE NOTE: {m} (updated {TODAY - datetime.timedelta(days=rows[m]['since'])})\n{rows[m]['body']}"
                                        for m in g["members"])
            try:
                out = llm(MERGE_PROMPT, data)
                head, body = out.split("\n-----\n", 1)
                nm = re.sub(r"[^a-z0-9]+", "-", re.search(r"NAME:\s*(.+)", head).group(1).lower()).strip("-")
                desc = re.search(r"DESC:\s*(.+)", head).group(1).strip().strip("\"")[:DESC_MAX]
            except Exception as e:
                print("merge failed", g["topic"], e)
                continue
            keep, want = retention(src, body)
            ratio = len(body) / max(1, sum(len(s) for s in src))
            op = dict(op="merge", name=nm, desc=desc, body=body.strip(), sources=g["members"], retention=round(keep, 2),
                      ratio=round(ratio, 2), ids=len(want), mtimes={m: rows[m]["mtime"] for m in g["members"]})
            op["ok"] = keep >= KEEP_IDS and ratio <= 0.85 and nm not in rows and not os.path.exists(f"{ARCH}/{nm}.md")
            ops.append(op)
            if op["ok"]:
                merged_away |= set(g["members"])
                merges += 1

    # 3. shorten descriptions (skip files that are being archived/merged away)
    gone = archived | merged_away
    long = [r for r in rows.values() if len(r["desc"]) > 150 and not r["pinned"] and r["name"] not in gone and r["name"] not in hot][:MAX_DESC]
    for i in range(0, len(long), 30):
        chunk = long[i:i + 30]
        data = "\n\n".join(f"### {r['name']}\ncurrent: {r['desc']}\n{r['body'][:350]}" for r in chunk)
        try:
            res = llm_json(DESC_PROMPT, data).get("desc", {})
        except Exception as e:
            print("desc pass failed", e)
            continue
        for r in chunk:
            d = (res.get(r["name"]) or "").strip()
            if d and len(d) <= 150 and '"' not in d:
                ops.append(dict(op="desc", name=r["name"], old=r["desc"], new=d, mtime=r["mtime"]))

    # projected index size
    proj = dict(rows)
    for o in ops:
        if o["op"] == "archive":
            proj.pop(o["name"], None)
        elif o["op"] == "merge" and o["ok"]:
            for s in o["sources"]:
                proj.pop(s, None)
            proj[o["name"]] = dict(idx=len(o["name"]) + len(o["desc"]) + 8)
        elif o["op"] == "desc" and o["name"] in proj:
            proj[o["name"]] = dict(proj[o["name"]], idx=len(o["name"]) + len(o["new"]) + 8)
    plan = dict(created=time.time(), date=str(TODAY), index_tokens_before=idx_tokens(rows), index_tokens_after=idx_tokens(proj),
                files_before=len(rows), files_after=len(proj), ops=ops)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M")
    pj = f"{STATE}/plans/{stamp}.json"
    json.dump(plan, open(pj, "w"), indent=1)
    rp = f"{STATE}/plans/{stamp}.md"
    open(rp, "w").write(report(plan, rows))
    st = {}
    sp = f"{STATE}/state.json"
    if os.path.exists(sp):
        st = json.load(open(sp))
    st.update(lastPlan=time.time(), latest=pj)
    json.dump(st, open(sp, "w"))
    print(f"plan: {pj}\nreport: {rp}\nindex {plan['index_tokens_before']} -> {plan['index_tokens_after']} tokens, "
          f"files {plan['files_before']} -> {plan['files_after']}")
    return pj


def report(p, rows):
    c = Counter(o["op"] for o in p["ops"])
    L = [f"# Dream plan {p['date']}", "",
         f"Index: **{p['index_tokens_before']} → {p['index_tokens_after']} tokens** · files {p['files_before']} → {p['files_after']} · "
         f"ops: {dict(c)}", "", "Nothing has been changed. Apply with `python3 dream/dream.py apply`.", ""]
    for o in p["ops"]:
        if o["op"] == "restore":
            L.append(f"- RESTORE `{o['name']}` — {o['reason']}")
    L += ["", "## Archive"]
    for o in p["ops"]:
        if o["op"] == "archive":
            r = rows[o["name"]]
            L.append(f"- `{o['name']}` (score {r['score']}, reads {r['reads']}, {r['age']}d, {r['size']//1024}KB) — {o['reason']}")
    L += ["", "## Merge"]
    for o in p["ops"]:
        if o["op"] == "merge":
            L.append(f"- {'✅' if o['ok'] else '❌ REJECTED'} `{o['name']}` ← {len(o['sources'])} notes: {', '.join(o['sources'])}\n"
                     f"  retention {o['retention']:.0%} of {o['ids']} identifiers · size ratio {o['ratio']} · _{o['desc']}_")
    L += ["", "## Descriptions"]
    for o in p["ops"]:
        if o["op"] == "desc":
            L.append(f"- `{o['name']}`: {len(o['old'])}→{len(o['new'])} chars — {o['new']}")
    return "\n".join(L) + "\n"


# ───────────────────────── apply ─────────────────────────
def git(*a, check=True):
    top = subprocess.run(["git", "-C", MEM, "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    return subprocess.run(["git", "-C", top, *a], capture_output=True, text=True, check=check)


def stale(path, mtime):
    return abs(os.path.getmtime(path) - mtime) > 1e-3


def write(path, fm, body):
    tmp = f"{path}.dream.tmp"
    open(tmp, "w").write(f"---\n{fm}\n---\n\n{body.strip()}\n")
    os.replace(tmp, path)


def do_archive(name, reason, why_tag="archived_reason"):
    src, dst = f"{MEM}/{name}.md", f"{ARCH}/{name}.md"
    fm, body = split_fm(open(src).read())
    fm = fm_set(fm_set(fm, "archived", str(TODAY)), why_tag, json.dumps(reason))
    os.makedirs(ARCH, exist_ok=True)
    write(dst, fm, body)
    os.unlink(src)


def apply(pj=None):
    pj = pj or json.load(open(f"{STATE}/state.json"))["latest"]
    p = json.load(open(pj))
    rows = scan({})
    before = idx_tokens(rows)
    pinned = {n: hashlib.sha1(open(f"{MEM}/{n}.md", "rb").read()).hexdigest() for n, r in rows.items() if r["pinned"]}
    done, skipped, touched, restored = [], [], set(), 0

    def skip(o, why):
        skipped.append(f"{o['op']} {o['name']}: {why}")

    for o in p["ops"]:
        n, f = o["name"], f"{MEM}/{o['name']}.md"
        if o["op"] == "restore":
            a = f"{ARCH}/{n}.md"
            if not os.path.exists(a) or os.path.exists(f):
                skip(o, "missing or name taken"); continue
            fm, body = split_fm(open(a).read())
            write(f, fm_del(fm_del(fm, "archived"), "archived_reason"), body)
            os.unlink(a); touched |= {f, a}; done.append(o)
            restored += (len(n) + len(fm_get(fm, "description") or "") + 8) // 4 + 1
        elif o["op"] == "archive":
            if not os.path.exists(f) or n in pinned or stale(f, o["mtime"]):
                skip(o, "missing, pinned or changed since plan"); continue
            do_archive(n, o["reason"]); touched |= {f, f"{ARCH}/{n}.md"}; done.append(o)
        elif o["op"] == "desc":
            if not os.path.exists(f) or n in pinned or stale(f, o["mtime"]) or len(o["new"]) > 150:
                skip(o, "missing, pinned, changed since plan or too long"); continue
            fm, body = split_fm(open(f).read())
            fm = fm_set(fm, "description", json.dumps(o["new"]))
            write(f, fm, body); touched.add(f); done.append(o)
        elif o["op"] == "merge":
            if not o["ok"]:
                skip(o, "rejected at plan time"); continue
            srcs = [f"{MEM}/{s}.md" for s in o["sources"]]
            if any(not os.path.exists(s) or stale(s, o["mtimes"][os.path.basename(s)[:-3]]) for s in srcs) \
               or os.path.exists(f) or any(s in pinned for s in o["sources"]):
                skip(o, "source missing/changed/pinned or name taken"); continue
            texts = [open(s).read() for s in srcs]
            k, _ = retention([split_fm(t)[1] for t in texts], o["body"])
            if k < KEEP_IDS:
                skip(o, f"retention {k:.2f}"); continue
            cr = min(date(fm_get(split_fm(t)[0], "created") or "") for t in texts)
            fm = "\n".join([f"description: {json.dumps(o['desc'])}", f"created: {cr}", f"updated: {TODAY}",
                            "merged_from:"] + [f"  - {s}" for s in o["sources"]] + ["tags:", "  - pi-memory"])
            write(f, fm, o["body"]); touched.add(f)
            for s in o["sources"]:
                do_archive(s, f"merged into {n}", "archived_reason"); touched |= {f"{MEM}/{s}.md", f"{ARCH}/{s}.md"}
            done.append(o)

    # lint: pinned untouched, index did not grow
    after = idx_tokens(scan({}))
    bad = [n for n, h in pinned.items() if not os.path.exists(f"{MEM}/{n}.md")
           or hashlib.sha1(open(f"{MEM}/{n}.md", "rb").read()).hexdigest() != h]
    if bad or after > before + restored:
        print("LINT FAILED", bad, before, "->", after, "— reverting")
        rel = [os.path.relpath(t, MEM) for t in touched]
        git("checkout", "--", *[f"{MEM}/{r}" for r in rel], check=False)
        for t in touched:
            if git("ls-files", "--error-unmatch", t, check=False).returncode:
                os.path.exists(t) and os.unlink(t)
        sys.exit(1)
    msg = f"dream {TODAY}: {Counter(o['op'] for o in done)} · index {before}->{after} tok"
    if touched:
        paths = sorted(touched)
        git("add", "-A", "--", *paths)
        git("commit", "-q", "-m", msg, "--", *paths, check=False)
    print(msg)
    for s in skipped:
        print("skipped:", s)
    os.makedirs(STATE, exist_ok=True)
    st = f"{STATE}/state.json"
    d = json.load(open(st)) if os.path.exists(st) else {}
    d["lastApply"] = time.time()
    json.dump(d, open(st, "w"))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "status":
        r = scan({})
        print(f"model {MODEL}")
        print(f"{len(r)} files, index ~{idx_tokens(r)} tokens, archived {len(glob.glob(ARCH + '/*.md'))}, state {STATE}")
    elif a[0] == "plan":
        plan("--force" in a)
    elif a[0] == "apply":
        apply(a[1] if len(a) > 1 else None)
