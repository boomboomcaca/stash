#!/usr/bin/env python3
"""Parse corrected en SRT + dub speaker tags into a JSON cue array."""
import json, re, sys

def parse_srt(path):
    with open(path, encoding='utf-8') as f:
        raw = f.read().strip()
    cues = {}
    for block in re.split(r'\n\s*\n', raw):
        lines = block.split('\n')
        if len(lines) < 3:
            continue
        idx = lines[0].strip()
        tc = lines[1].strip()
        text = ' '.join(l.strip() for l in lines[2:]).strip()
        m = re.match(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)', tc)
        if not m:
            continue
        h1,m1,s1,ms1,h2,m2,s2,ms2 = map(int, m.groups())
        start = h1*3600+m1*60+s1+ms1/1000
        end = h2*3600+m2*60+s2+ms2/1000
        cues[idx] = {'n': int(idx), 'tc': tc, 'start': round(start,3),
                     'end': round(end,3), 'dur': round(end-start,3), 'en': text}
    return cues

en = parse_srt('LN3.en.fixed.srt')

# speaker per index from the tagged dub script
spk = {}
with open('LN3.en.srt.dub', encoding='utf-8') as f:
    cur = None
    for line in f:
        line = line.rstrip('\n')
        if re.match(r'^\d+$', line.strip()):
            cur = line.strip()
        m = re.match(r'^\[Speaker (\d+)\]:', line)
        if m and cur is not None:
            spk[cur] = int(m.group(1))

cues = []
for idx in sorted(en, key=lambda x: int(x)):
    c = en[idx]
    c['speaker'] = spk.get(idx, 1)
    cues.append(c)

if not cues:
    sys.exit("no cues parsed from the corrected en SRT — check the input file")

with open('cues.json', 'w', encoding='utf-8') as f:
    json.dump(cues, f, ensure_ascii=False, indent=0)

print(f"cues: {len(cues)}")
print(f"total dur: {cues[-1]['end']:.1f}s")
# distribution of cue durations
short = sum(1 for c in cues if c['dur'] < 1.0)
print(f"cues <1s: {short}")
# show a few
for c in cues[:3] + cues[105:108]:
    print(json.dumps(c, ensure_ascii=False))
