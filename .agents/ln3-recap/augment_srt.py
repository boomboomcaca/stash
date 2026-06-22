#!/usr/bin/env python3
"""Merge authored [画面] visual-beat cues into the dialogue .en.srt so the recap
planner can see and narrate the wordless action sequences (battles, dragons,
the naval climax) that pure ASR misses. Sorts by time, re-indexes, writes back.
"""
import re, sys

SRT = sys.argv[1]

# (start_sec, end_sec, text) — authored from viewing the film's keyframes
VBEATS = [
    (195, 203,  "【画面：泛黄的羊皮地图与盘旋的巨龙——黑党雷妮拉与绿党伊耿、伊蒙德为铁王座反目，龙战即将燃遍七国】"),
    (835, 843,  "【画面：浓雾笼罩、尸横遍野的战场，零星余火，一名银发铠甲战士独立其间——一场惨烈陆战刚刚落幕】"),
    (965, 973,  "【画面：战后焦土，伤兵与尸首散落，硝烟弥漫】"),
    (1265, 1273,"【画面：巨龙振翅掠过荒野，龙焰倾泻、焚烧大地】"),
    (1820, 1828,"【画面：嶙峋礁石之间一头未被驯服的巨龙盘踞，银发的坦格利安独自走近、伸手试图驾驭它——两党都在疯狂寻找新的龙骑士】"),
    (2680, 2688,"【画面：港口战船云集，士兵列队登船，大战在即】"),
    (2860, 2868,"【画面：甲板上甲胄森严的军队整装待发，旌旗猎猎】"),
    (3010, 3018,"【画面：庞大的舰队在海上集结，火光映海】"),
    (3210, 3218,"【画面：战船相接、火墙腾起，浴血的战士嘶吼着冲杀】"),
    (3300, 3308,"【画面：海战爆发，一名浴血的女战士在甲板上厉声嘶吼，刀剑相搏、一片混乱】"),
    (3400, 3408,"【画面：铠甲武士在燃烧的战船间死战，烈焰与浓烟吞没甲板】"),
    (3490, 3498,"【画面：巨龙俯冲掠过火海，龙焰所至，整片舰队燃成一支支火炬】"),
    (3590, 3598,"【画面：数头巨龙盘旋海面喷吐烈焰，战船成片爆燃、断裂、沉没】"),
    (3690, 3698,"【画面：巨龙贴着海面掠过，身后是燃烧倾覆的残骸，海天尽是火光】"),
    (3790, 3798,"【画面：幸存者跌入冰冷海水，在烈焰与残骸间挣扎，远处战船在浓雾中驶过——血战之后，海面只剩焦木与浮尸】"),
]


def to_sec(h, m, s, ms):
    return int(h)*3600+int(m)*60+int(s)+int(ms)/1000


def fmt(t):
    ms = int(round((t-int(t))*1000))
    t = int(t)
    return f"{t//3600:02d}:{t%3600//60:02d}:{t%60:02d},{ms:03d}"


def main():
    raw = open(SRT, encoding="utf-8", errors="replace").read()
    cues = []
    for blk in re.split(r"\n\s*\n", raw):
        m = re.search(r"(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)", blk)
        if not m:
            continue
        g = list(map(int, m.groups()))
        st, en = to_sec(*g[:4]), to_sec(*g[4:])
        text = blk[m.end():].strip()
        cues.append((st, en, text))
    cues += VBEATS
    cues.sort(key=lambda c: c[0])
    out = []
    for i, (st, en, text) in enumerate(cues, 1):
        out.append(f"{i}\n{fmt(st)} --> {fmt(en)}\n{text}\n")
    open(SRT, "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"wrote {len(cues)} cues ({len(VBEATS)} visual beats merged)")


if __name__ == "__main__":
    main()
