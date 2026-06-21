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

_sem = threading.Semaphore(CONCURRENCY)


def build_prompt(target_lang, max_minutes, max_chars):
    return (
        "你是一名资深影视解说编剧。下面（随后通过输入提供）是一部影片的逐句转写，"
        "每行格式为 `N [mm:ss] 台词`，N 是从 1 开始的句子编号。\n\n"
        "任务：基于这份转写，创作一段第三人称剧情解说（解说词），把整部影片的剧情"
        f"讲清楚。要求：\n"
        f"1) 解说语言：{target_lang}。\n"
        f"2) 总时长不超过 {max_minutes} 分钟，总字数不超过 {max_chars} 字。\n"
        "3) 按时间顺序把解说拆成若干小段(beat)。每段对应转写里要保留展示的句子编号"
        "（用于挑出对应画面），并为该段写一句到几句解说词。\n"
        "4) 每段的解说词长度要大致与所选句子的时间跨度相称，不要在很短的画面上堆砌"
        "过多文字（否则配音会被压得过快）。\n"
        "5) 只挑最能推动剧情的关键句，跳过寒暄/重复；覆盖完整剧情弧线。\n\n"
        "只输出 JSON，不要任何解释或代码块标记，格式严格为：\n"
        '{"beats":[{"cues":[12,13,15],"text":"……解说词……"}, …]}\n'
        "cues 必须是上面转写里真实存在的句子编号（整数），按出现顺序排列。"
    )


def run_claude(prompt, transcript):
    cmd = [
        CLAUDE_BIN, "-p", prompt,
        "--model", CLAUDE_MODEL,
        # NOTE: no --bare — minimal mode skips loading the ~/.claude OAuth creds,
        # so claude reports "Not logged in" when relying on the interactive login.
        "--max-turns", "1",
        "--disallowedTools", "Edit,Bash,Write",
        "--output-format", "json",
    ]
    proc = subprocess.run(
        cmd, input=transcript, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT
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

        prompt = build_prompt(target_lang, max_minutes, max_chars)
        with _sem:
            try:
                result = run_claude(prompt, transcript)
                beats = normalize_beats(extract_json(result))
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
