#!/usr/bin/env python3
"""Merge the workflow's full visual timeline (250 beats) + the dialogue .en.srt.orig
into a rich augmented .en.srt the recap planner can narrate from."""
import json, re, sys

WF = sys.argv[1]        # workflow output json
SRT = sys.argv[2]       # target .en.srt (reads SRT.orig for dialogue)
SKIP_BEFORE, SKIP_AFTER = 110, 3855   # drop HBO logo / title embroidery / end credits

out = json.load(open(WF, encoding="utf-8"))
segs = out.get("result", out).get("segments", [])
vbeats = []
for s in segs:
    for b in s.get("beats", []):
        t = float(b["t"])
        if t < SKIP_BEFORE or t > SKIP_AFTER:
            continue
        vbeats.append((t, t + 7.0, "【画面：" + str(b["desc"]).strip() + "】"))

raw = open(SRT + ".orig", encoding="utf-8", errors="replace").read()
cues = []
for blk in re.split(r"\n\s*\n", raw):
    lines = blk.strip().split("\n")
    ti = next((k for k, l in enumerate(lines) if "-->" in l), None)
    if ti is None:
        continue
    m = re.match(r"(\d+):(\d+):(\d+),(\d+)", lines[ti])
    em = re.search(r"-->\s*(\d+):(\d+):(\d+),(\d+)", lines[ti])
    if not (m and em):
        continue
    g = list(map(int, m.groups())); st = g[0]*3600+g[1]*60+g[2]+g[3]/1000
    eg = list(map(int, em.groups())); en = eg[0]*3600+eg[1]*60+eg[2]+eg[3]/1000
    text = " ".join(l.strip() for l in lines[ti+1:] if l.strip())
    if text:
        cues.append((st, en, text))

cues += vbeats
cues.sort(key=lambda c: c[0])


def fmt(t):
    ms = int(round((t-int(t))*1000)); t = int(t)
    return f"{t//3600:02d}:{t%3600//60:02d}:{t%60:02d},{ms:03d}"


with open(SRT, "w", encoding="utf-8") as f:
    f.write("\n".join(f"{i}\n{fmt(st)} --> {fmt(en)}\n{tx}\n"
                      for i, (st, en, tx) in enumerate(cues, 1)) + "\n")
print(f"wrote {len(cues)} cues ({len(vbeats)} visual beats + {len(cues)-len(vbeats)} dialogue)")
