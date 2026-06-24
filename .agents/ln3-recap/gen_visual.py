#!/usr/bin/env python3
"""Auto-generate the visual-beat timeline ({t,desc} JSON) that augment_full.py
consumes — using the LOCAL token-based Claude Code (`claude -p`) for BOTH the
vision pass and the web plot fact-check. No extra API/cost beyond your Claude
subscription (CLAUDE_CODE_OAUTH_TOKEN is inherited by the subprocess).

Why this exists: stash's recap planner only sees the ASR dialogue, so it misses
every wordless action/dragon/battle shot. This script "watches" the film for it.

Pipeline:
  1. ffmpeg: sample one frame every <interval>s, burn its real timestamp (seconds)
     into the top-left, and TILE frames into contact sheets (cols x rows per sheet).
     Tiling is token-efficient: one image carries ~24 frames.
  2. claude -p (--allowedTools Read): read each sheet, emit {t,desc} for meaningful
     shots (esp. no-dialogue: battles, dragons, deaths, 名场面, key close-ups);
     skip black / title embroidery / end credits / empty transition frames.
  3. claude -p (--allowedTools WebSearch,WebFetch): identify the episode and
     fact-check character names / who-dies / dragon owners from the descriptions
     -> a Chinese review note (so you can fix plot before rendering).
  4. Write {"segments":[{"beats":[{t,desc}...]}], "plot_notes":"..."} for augment_full.py.

Usage:
  gen_visual.py <video> <out.json> [--interval 12] [--skip-head 110] [--skip-tail 0]
                [--cols 6] [--rows 4] [--model opus] [--sheets-per-call 2]
Then:  python augment_full.py <out.json> <video_basename>.en.srt   (your existing step)
"""
import sys, os, re, json, subprocess, tempfile, shutil, argparse, time

def _resolve_claude():
    """Find a directly-executable `claude` (Windows .cmd/.ps1 shims can't be exec'd
    by subprocess, but they wrap a real claude.exe — resolve to that)."""
    b = os.environ.get("CLAUDE_BIN")
    if b and os.path.exists(b):
        return b
    w = shutil.which("claude.exe") or shutil.which("claude")
    if w:
        if w.lower().endswith(".exe"):
            return w
        cand = os.path.join(os.path.dirname(w), "node_modules", "@anthropic-ai",
                            "claude-code", "bin", "claude.exe")
        if os.path.exists(cand):
            return cand
        return w
    return "claude"


CLAUDE_BIN = _resolve_claude()


def probe(p):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", p]).decode().strip()
    return float(out)


def run(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def extract_sheets(video, work, interval, skip_head, skip_tail, cols, rows, dur):
    """One frame / <interval>s with the REAL time (seconds) burned top-left, tiled."""
    span = max(1.0, (dur - skip_tail) - skip_head)
    label = r"%{eif\:t+" + str(int(skip_head)) + r"\:d}"   # t is time-since -ss; +skip_head = real seconds
    vf = (f"fps=1/{interval},scale=360:-1,"
          f"drawtext=text='{label}':x=4:y=4:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7,"
          f"tile={cols}x{rows}")
    run("ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", str(skip_head), "-i", video,
        "-t", str(span), "-vf", vf, os.path.join(work, "sheet_%03d.jpg"))
    return [os.path.join(work, s) for s in sorted(os.listdir(work)) if s.startswith("sheet_")]


def extract_json(text):
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    a, b = text.find("["), text.rfind("]")
    if a != -1 and b > a:
        try:
            return json.loads(text[a:b + 1])
        except json.JSONDecodeError:
            pass
    a, b = text.find("{"), text.rfind("}")
    if a != -1 and b > a:
        return json.loads(text[a:b + 1])
    raise ValueError("no JSON object/array found in claude output")


def claude(prompt, allowed, max_turns, timeout, model):
    cmd = [CLAUDE_BIN, "-p", prompt, "--allowedTools", allowed,
           "--max-turns", str(max_turns), "--output-format", "json", "--model", model]
    last = None
    for att in range(1, 4):
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=timeout)
            if proc.returncode != 0:
                raise RuntimeError((proc.stderr or "").strip()[:300])
            try:
                env = json.loads(proc.stdout)
                return env.get("result", proc.stdout)
            except json.JSONDecodeError:
                return proc.stdout
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"    claude attempt {att} failed: {str(e)[:140]}", flush=True)
            time.sleep(att * 5)
    raise RuntimeError(f"claude -p failed: {last}")


VISION_PROMPT = (
    "用 Read 工具查看这 {n} 张接触图(按给定顺序):{paths}\n\n"
    "每张图由若干小图拼成;每个小图左上角的黄色数字 = 该画面在视频中的时间(秒)。\n"
    "请逐个小图判断:只要是有意义的剧情或动作镜头——尤其是**无对白**的(战斗、巨龙、登场、"
    "死亡、名场面、关键人物特写)——就输出一条 "
    "{{\"t\": <该小图左上角的整数秒数>, \"desc\": \"<一句简洁客观的中文画面描述>\"}};\n"
    "跳过纯黑、片头刺绣字幕、演职员表、以及虚化无信息的过场帧。\n"
    "只输出一个 JSON 数组,例如 [{{\"t\":195,\"desc\":\"巨龙掠过燃烧的舰队\"}}, ...] —— "
    "不要任何解释、前后缀或代码块标记。"
)

PLOT_PROMPT = (
    "用 Read 工具查看这几张覆盖全片的关键帧接触图:{sheets}\n"
    "并参考下面按时间排列的画面描述。\n\n"
    "第一步——先客观列出【硬性判别特征】,先别急着下结论:\n"
    "① 主战场是海战(舰队/海面/船甲板)还是陆战(城堡/陆地/骑兵)?\n"
    "② 全片大约出现几条龙?有没有『人徒手走近并驯服一头野龙』的画面?\n"
    "③ 有没有这些独有元素:女海盗/女提督、骑手坠海溺亡、海上钩索或巨弩把龙拽入水、某个关键人物之死?\n\n"
    "第二步——带着这些判别特征用 WebSearch/WebFetch 联网核实,确认这是哪部剧的哪一季哪一集。"
    "务必注意:一场大型战役并不等于另一场更有名的战役——别只凭『焦土战场/某位将领』就认错"
    "(例如把海战误判成某场陆战)。要让决定性特征(如『海战』)来锁定集数。\n\n"
    "第三步——输出中文【剧情校对笔记】:第一行写『剧名 + 第几季第几集 + 置信度(高/中/低)』;"
    "随后逐条列出解说时**容易写错、务必注意**的点:正确中文人名、谁死了谁活着、谁杀了谁、龙的归属与数量。"
    "只输出这段笔记,不要其它内容。\n\n"
    "画面描述时间线:\n{sample}"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--interval", type=int, default=12)
    ap.add_argument("--skip-head", type=int, default=110)
    ap.add_argument("--skip-tail", type=int, default=0)
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--rows", type=int, default=4)
    ap.add_argument("--model", default="opus")
    ap.add_argument("--sheets-per-call", type=int, default=2)
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    dur = probe(a.video)
    work = tempfile.mkdtemp(prefix="genvis-")
    print(f"video={dur:.0f}s interval={a.interval}s; sampling + tiling frames...", flush=True)
    sheets = extract_sheets(a.video, work, a.interval, a.skip_head, a.skip_tail, a.cols, a.rows, dur)
    print(f"{len(sheets)} contact sheets ({a.cols}x{a.rows} frames each)", flush=True)

    beats = []
    for i in range(0, len(sheets), a.sheets_per_call):
        batch = sheets[i:i + a.sheets_per_call]
        prompt = VISION_PROMPT.format(n=len(batch), paths="; ".join(batch))
        try:
            arr = extract_json(claude(prompt, "Read", max_turns=12, timeout=480, model=a.model))
            n0 = len(beats)
            for b in arr if isinstance(arr, list) else []:
                try:
                    d = str(b["desc"]).strip()
                    if d:
                        beats.append({"t": float(b["t"]), "desc": d})
                except (KeyError, ValueError, TypeError):
                    pass
            print(f"  sheets {i + 1}-{i + len(batch)}/{len(sheets)}: +{len(beats) - n0} beats (total {len(beats)})", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"  sheets {i + 1}-{i + len(batch)} FAILED: {str(e)[:160]}", flush=True)

    beats.sort(key=lambda b: b["t"])
    deduped = []
    for b in beats:
        if deduped and abs(b["t"] - deduped[-1]["t"]) < 2.0:
            continue
        deduped.append(b)
    beats = deduped

    notes = ""
    if beats:
        sample = "\n".join(f'{int(b["t"])}s: {b["desc"]}' for b in beats[:80])
        # let the fact-check actually SEE a spread of frames (image-grounded ID is
        # far more reliable than text-only — text alone misreads a naval battle as a
        # more-famous land battle). Pick sheets across the whole film.
        n = len(sheets)
        seen = [sheets[i] for i in sorted({0, n // 4, n // 2, 3 * n // 4, n - 1}) if 0 <= i < n]
        try:
            notes = claude(PLOT_PROMPT.format(sheets="; ".join(seen), sample=sample),
                           "Read,WebSearch,WebFetch", max_turns=30, timeout=720, model=a.model).strip()
            print("plot fact-check done", flush=True)
        except Exception as e:  # noqa: BLE001
            notes = f"(联网校对失败: {str(e)[:160]})"
            print(notes, flush=True)

    out = {"segments": [{"beats": beats}], "plot_notes": notes}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    note_path = os.path.splitext(a.out)[0] + ".plotnotes.txt"
    with open(note_path, "w", encoding="utf-8") as f:
        f.write(notes + "\n")
    print(f"DONE: {len(beats)} visual beats -> {a.out}", flush=True)
    print(f"      plot notes -> {note_path}", flush=True)
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
