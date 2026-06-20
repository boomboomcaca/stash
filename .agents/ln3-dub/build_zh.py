#!/usr/bin/env python3
"""Assemble zh.srt (clean) and zh.srt.dub (tagged) from cues.json + zh_items.json."""
import json, sys

with open('cues.json', encoding='utf-8') as f:
    cues = {c['n']: c for c in json.load(f)}
with open('zh_items.json', encoding='utf-8') as f:
    items = json.load(f)
zh = {it['n']: it['zh'].strip() for it in items}

missing = [n for n in cues if n not in zh or not zh[n]]
if missing:
    print(f"WARNING missing/empty zh for cues: {missing}", file=sys.stderr)

clean_lines, dub_lines = [], []
overlong = []
for n in sorted(cues):
    c = cues[n]
    text = zh.get(n, '').strip()
    if not text:
        text = c['en']  # fallback so dub never gets an empty line
    spk = c.get('speaker', 1)
    clean_lines.append(f"{n}\n{c['tc']}\n{text}\n")
    dub_lines.append(f"{n}\n{c['tc']}\n[Speaker {spk}]: {text}\n")
    # flag lines well over the time budget (~6 cn chars/sec)
    budget = max(4, c['dur'] * 6)
    cn = sum(1 for ch in text if '一' <= ch <= '鿿')
    if cn > budget * 1.6 and c['dur'] > 1.0:
        overlong.append((n, round(c['dur'],1), cn, text))

with open('LN3.zh.srt', 'w', encoding='utf-8') as f:
    f.write("\n".join(clean_lines))
with open('LN3.zh.srt.dub', 'w', encoding='utf-8') as f:
    f.write("\n".join(dub_lines))

print(f"wrote LN3.zh.srt and LN3.zh.srt.dub ({len(cues)} cues)")
print(f"overlong cues (cn chars >> budget): {len(overlong)}")
for n,d,cn,t in overlong[:20]:
    print(f"  cue {n} dur={d}s chars={cn}: {t}")
