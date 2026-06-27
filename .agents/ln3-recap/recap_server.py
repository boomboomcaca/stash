#!/usr/bin/env python3
"""Recap-script service (runs ON the box where Claude Code is logged in, e.g. .113).

Thin HTTP wrapper around `claude -p` (Claude Code headless), mirroring the dub
(:5093) and asr (:5092) services. stash POSTs a numbered transcript; this turns
it into a condensed third-person narration script (解说词) keyed to source cues,
by driving an LLM in a single-shot, no-tools pass.

Why a service (not stash exec'ing claude directly): the Claude login lives only
on this box, and keeping the LLM behind an HTTP endpoint means stash (wherever it
runs) calls it exactly like dub/asr, and the subscription rate limit is throttled
in one place.

POST /v1/recap   (application/x-www-form-urlencoded)
  transcript   : one "N [mm:ss] text" line per source cue (N is 1-based)
  target_lang  : narration language (e.g. "zh")
  max_minutes  : recap length cap
  max_chars    : narration character budget (~spoken capacity of the cap)
->  {"beats":[{"cues":[12,13,15],"text":"…narration…"}, …]}

Auth: `claude` uses the interactive login on this box automatically. For a
daemon/other-user context, set CLAUDE_CODE_OAUTH_TOKEN in the environment
(generate once with `claude setup-token`); it is inherited by the subprocess.
NEVER hardcode the token here.

Usage: CLAUDE_CODE_OAUTH_TOKEN=... python3 recap_server.py [--port 5094]
"""
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CLAUDE_MODEL = os.environ.get("RECAP_MODEL", "opus")
CONCURRENCY = int(os.environ.get("RECAP_CONCURRENCY", "3"))
CLAUDE_TIMEOUT = int(os.environ.get("RECAP_CLAUDE_TIMEOUT", "540"))  # seconds
# One-shot override: when RECAP_CANNED points at a beats-JSON file, the next
# /v1/recap returns it verbatim instead of invoking the LLM (used to rebuild a
# video from an already-validated script without paying for a fresh ~9min pass).
CANNED_PATH = os.environ.get("RECAP_CANNED", "")

# Chunked beats generation: a single claude pass over a long transcript stalls —
# its reasoning blows up super-linearly (~20 cues OK in ~80s, >=40 cues times out),
# so split the transcript into small windows, narrate each independently and in
# parallel, then merge by cue order. RECAP_CHUNK_CUES=0 restores the old single shot.
CHUNK_CUES = int(os.environ.get("RECAP_CHUNK_CUES", "15"))
CHUNK_TIMEOUT = int(os.environ.get("RECAP_CHUNK_TIMEOUT", "200"))  # per-chunk seconds
# all tools off: this task needs none; shaves time and avoids any tool-call stall.
NO_TOOLS = "Edit,Bash,Write,Read,Glob,Grep,WebSearch,WebFetch,Task,NotebookEdit,TodoWrite"
# Unified-names glossary: one web-enabled pass identifies the work and its standard
# target-language proper nouns, fed into EVERY chunk so names stay correct and
# consistent (instead of each chunk re-inventing/transliterating ASR mishearings).
GLOSSARY_ON = os.environ.get("RECAP_GLOSSARY", "1") != "0"
GLOSSARY_TIMEOUT = int(os.environ.get("RECAP_GLOSSARY_TIMEOUT", "300"))

_sem = threading.Semaphore(CONCURRENCY)


def build_prompt(target_lang, max_minutes, max_chars):
    return (
        "你是一名顶尖的影视解说编剧，擅长把一部影片浓缩成一段抓人、好看的剧情解说。"
        "下面（随后通过输入提供）是这部影片的逐句转写，每行格式为 `N [mm:ss] 台词`，"
        "N 是从 1 开始的句子编号。\n\n"
        "重要：这份转写由语音识别自动生成，可能有听错的词、张冠李戴的人名，以及在"
        "配乐/打斗段落里凭空冒出的胡乱短句；同时大量台词可能因背景音乐而漏识。请依据"
        "上下文还原真实剧情，忽略明显错乱/无意义的片段，绝不照抄乱码文本。若你认得这部"
        "作品，请使用其在目标语言中的通用译名（人名、地名、势力名），并据此修正转写里"
        "明显听错的专有名词。\n\n"
        "转写中以【画面：…】开头的行不是台词，而是对重要『无对白画面』（动作、战斗、"
        "龙、登场、死亡、名场面等）的客观描述。这类片子对白稀疏、剧情大量靠画面推进，"
        "所以务必把这些【画面】行当作和台词同等重要的锚点：选它们的编号来呈现这些名"
        "场面，并在解说里把对应的视觉桥段讲出来。\n\n"
        "任务：基于这份转写，创作一段第三人称剧情解说（解说词），把整部影片的剧情"
        "讲清楚、讲精彩。要求：\n"
        f"1) 解说语言：{target_lang}；口语化、生动、有节奏，是“意译”而非逐句直译。"
        "开头用一句话抓人的钩子迅速带入，结尾收束有力。\n"
        f"2) 总时长不超过 {max_minutes} 分钟，总字数不超过 {max_chars} 字；解说要『密』，"
        "尽量连贯讲述、少留空白，不要做成只有零星旁白的剪辑。\n"
        "3) 按时间顺序把解说拆成较多的小段(beat)。每段只选 1–3 个『时间紧挨、相邻』的"
        "编号（使对应片段约 5–12 秒）；切勿把相隔很远的编号塞进同一段（否则片段会很长、"
        "几段就吃光时长预算，导致后面剧情被截断）。\n"
        "4) 每段解说词长度与所选片段时长相称（按约每秒 5 字估算，例如 8 秒片段配约 40 字），"
        "既不要在短片段上堆太多字（配音会被压快），也不要让长片段几乎没旁白。\n"
        "5) 关键：beats 必须『均匀铺满整条时间轴、一路讲到结局』——尤其要覆盖最后的"
        "高潮与收尾（如片尾的大战/海战及其余波），绝不能讲到一半就停。优先挑最能推动"
        "剧情的台词与【画面】，跳过寒暄/重复/口水话。\n\n"
        "只输出 JSON，不要任何解释或代码块标记，格式严格为：\n"
        '{"beats":[{"cues":[12,13,15],"text":"……解说词……"}, …]}\n'
        "cues 必须是上面转写里真实存在的句子编号（整数），按出现顺序排列。"
    )


def run_claude(prompt, transcript, timeout=CLAUDE_TIMEOUT, allowed=None, max_turns=1):
    cmd = [
        CLAUDE_BIN, "-p", prompt,
        "--model", CLAUDE_MODEL,
        # NOTE: no --bare — minimal mode skips loading the ~/.claude OAuth creds,
        # so claude reports "Not logged in" when relying on the interactive login.
        "--max-turns", str(max_turns),
        "--output-format", "json",
    ] + (["--allowedTools", allowed] if allowed else ["--disallowedTools", NO_TOOLS])
    proc = subprocess.run(
        cmd, input=transcript, capture_output=True, text=True, timeout=timeout
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"claude exited {proc.returncode}: {proc.stderr.strip()[:400]}"
        )
    # --output-format json wraps the model text in an envelope under "result".
    try:
        env = json.loads(proc.stdout)
        result = env.get("result", proc.stdout)
    except json.JSONDecodeError:
        result = proc.stdout
    return result


def extract_json(text):
    """Pull the JSON object out of the model's result text (tolerate fences/prose)."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # fall back to the outermost { ... }
    a, b = text.find("{"), text.rfind("}")
    if a != -1 and b > a:
        return json.loads(text[a:b + 1])
    raise ValueError("no JSON object found in model output")


def normalize_beats(parsed):
    beats = parsed.get("beats") if isinstance(parsed, dict) else parsed
    if not isinstance(beats, list):
        raise ValueError("expected a 'beats' list")
    out = []
    for b in beats:
        if not isinstance(b, dict):
            continue
        cues = [int(c) for c in (b.get("cues") or []) if isinstance(c, (int, float, str)) and str(c).strip().lstrip("-").isdigit()]
        text = str(b.get("text", "")).strip()
        if cues and text:
            out.append({"cues": cues, "text": text})
    return out


def build_chunk_prompt(target_lang, max_chars, part_idx, num_parts, glossary=""):
    gl = ("【统一译名表，人名/地名/势力名一律严格照此使用，不要自创或音译】：\n"
          + glossary + "\n\n") if glossary else ""
    return (
        gl
        + "你是影视解说编剧。下面（通过输入提供）是一部影片其中一个片段的逐句转写"
        f"（全片第 {part_idx}/{num_parts} 段），每行格式 `N [mm:ss] 内容`，N 是全局句子编号。"
        "以【画面：…】开头的行是无对白画面描述（动作/战斗/龙/登场/死亡/名场面），"
        "与台词同等重要，可选其编号来呈现名场面。\n"
        "转写由语音识别生成，可能有错词/错名/乱码短句；请依上下文还原真实剧情、忽略乱码，"
        "若认得作品请用其在目标语言中的通用译名。\n"
        f"任务：只为『这一段』写连贯、口语化、生动的 {target_lang} 第三人称剧情解说，"
        "按时间顺序拆成几个 beat。每个 beat 选 1–3 个『相邻』的真实编号（对应约 5–12 秒），"
        "解说词长度与片段时长相称（约每秒 5 字）。覆盖本段关键剧情与画面，跳过寒暄/重复/口水话。"
        f"本段解说总字数控制在约 {max_chars} 字以内。\n"
        "只输出 JSON，不要解释或代码块：\n"
        '{"beats":[{"cues":[12,13],"text":"……解说词……"}, …]}\n'
        "cues 必须是上面这段里真实出现的编号（整数），按出现顺序。"
    )


def _chunk_lines(transcript, k):
    lines = [ln for ln in transcript.splitlines() if re.match(r"\s*\d+\s", ln)]
    return [lines[i:i + k] for i in range(0, len(lines), k)]


def build_glossary(transcript, target_lang, logf):
    """One web-enabled pass: identify the work and return its standard target-language
    proper nouns, so every chunk narrates with unified, correct names (not ASR errors)."""
    lines = [ln for ln in transcript.splitlines() if re.match(r"\s*\d+\s", ln)]
    pic = [ln for ln in lines if "【画面" in ln]
    sample = "\n".join(lines[:80] + pic[:40])
    prompt = (
        "下面是某影视作品转写的片段（语音识别，可能有错词、错名、乱码短句；"
        "以【画面：…】开头的行是无对白画面的客观描述）。请用 WebSearch / WebFetch 联网"
        "判断这是哪部影视作品（剧名 + 第几季第几集），并据此给出其在 "
        f"{target_lang} 中的【统一标准译名表】：主要人物、地点、势力的通用标准译名，"
        "以及转写里明显听错的专有名词 → 正确译名的对应。只输出简洁的译名表本身"
        "（每行一条，如『错听名/特征 → 标准译名』或『标准译名（一句说明）』），不要写解说词。"
        "若联网无法确定作品，就基于上下文给出自洽一致的译名表。"
    )
    try:
        g = run_claude(prompt, sample, GLOSSARY_TIMEOUT, allowed="WebSearch,WebFetch", max_turns=20).strip()
        try:
            open("/tmp/recap_glossary.txt", "w", encoding="utf-8").write(g)
        except Exception:  # noqa: BLE001
            pass
        logf("glossary built: %d chars", len(g))
        return g
    except Exception as e:  # noqa: BLE001
        logf("glossary failed (%s); chunks proceed without it", str(e)[:100])
        return ""


def run_chunked(transcript, target_lang, max_chars, logf):
    """Narrate the transcript window-by-window in parallel, then merge by cue order."""
    chunks = _chunk_lines(transcript, CHUNK_CUES)
    n = len(chunks)
    if n == 0:
        return []
    glossary = build_glossary(transcript, target_lang, logf) if GLOSSARY_ON else ""
    per_chars = max(120, max_chars // n)
    results = [None] * n

    def work(i):
        prompt = build_chunk_prompt(target_lang, per_chars, i + 1, n, glossary)
        text = "\n".join(chunks[i])
        last = None
        for _ in range(2):  # retry once: claude is non-deterministic, occasionally emits bad JSON
            try:
                return normalize_beats(extract_json(run_claude(prompt, text, CHUNK_TIMEOUT)))
            except Exception as e:  # noqa: BLE001
                last = e
        raise last

    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = {ex.submit(work, i): i for i in range(n)}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            i = futs[fut]
            try:
                results[i] = fut.result()
            except Exception as e:  # noqa: BLE001
                results[i] = []
                logf("chunk %d/%d FAILED: %s", i + 1, n, str(e)[:100])
            done += 1
            logf("chunk %d/%d done (%d/%d total)", i + 1, n, done, n)
    beats = [b for r in results if r for b in r]
    beats.sort(key=lambda b: min(b["cues"]) if b["cues"] else 0)
    return beats


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[recap] " + (fmt % args) + "\n")

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/recap":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8", "replace")
        form = parse_qs(raw, keep_blank_values=True)

        def field(name, default=""):
            v = form.get(name, [default])
            return v[0] if v else default

        transcript = field("transcript")
        if not transcript.strip():
            self._send(400, {"error": "missing transcript"})
            return
        target_lang = field("target_lang", "zh")
        try:
            max_minutes = int(field("max_minutes", "10") or "10")
        except ValueError:
            max_minutes = 10
        try:
            max_chars = int(field("max_chars", str(max_minutes * 300)) or str(max_minutes * 300))
        except ValueError:
            max_chars = max_minutes * 300

        if CANNED_PATH and os.path.exists(CANNED_PATH):
            try:
                with open(CANNED_PATH, encoding="utf-8") as fh:
                    beats = normalize_beats(json.load(fh))
                self.log_message("canned: %d beats from %s", len(beats), CANNED_PATH)
                self._send(200, {"beats": beats})
                return
            except Exception as e:  # noqa: BLE001
                self.log_message("canned load failed (%s); falling back to LLM", e)

        try:
            if CHUNK_CUES > 0:
                ncues = sum(1 for ln in transcript.splitlines() if re.match(r"\s*\d+\s", ln))
                self.log_message("chunked: %d cues @ %d/chunk, concurrency=%d", ncues, CHUNK_CUES, CONCURRENCY)
                beats = run_chunked(transcript, target_lang, max_chars, self.log_message)
            else:
                prompt = build_prompt(target_lang, max_minutes, max_chars)
                with _sem:
                    beats = normalize_beats(extract_json(run_claude(prompt, transcript)))
        except subprocess.TimeoutExpired:
            self._send(504, {"error": "claude timed out"})
            return
        except Exception as e:  # noqa: BLE001
            self.log_message("error: %s", e)
            self._send(502, {"error": str(e)[:400]})
            return
        self.log_message("ok: %d beats from %d transcript chars", len(beats), len(transcript))
        self._send(200, {"beats": beats})


def main():
    port = 5094
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        sys.stderr.write(
            "[recap] note: CLAUDE_CODE_OAUTH_TOKEN not set; relying on the "
            "interactive `claude` login on this box.\n"
        )
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(
        f"[recap] listening on :{port} (model={CLAUDE_MODEL}, concurrency={CONCURRENCY})\n"
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
