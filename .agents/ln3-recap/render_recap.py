#!/usr/bin/env python3
"""Upgraded recap renderer — the render half of the recap pipeline, with all the
quality switches stash's built-in Go muxing lacks:

  * ORIGINAL-AUDIO bed: clips keep the film's audio (dialogue/SFX/score), ducked
    under the Chinese narration via sidechain (set --bedvol 0 for muted clips).
  * ONE-LINE subtitles: each beat's caption is split into short clauses timed to
    the speech, instead of one long block held for the whole clip.
  * COLD-OPEN: a beat with "coldopen":true plays first (with its original audio)
    then the monotonic source walk resets so the body starts at its real anchor.
  * LOUDNESS normalize to -14 LUFS; per-clip A/V locked to exact length.
  * TRUNCATION-safe dub: the dub service stops on some long single-cue texts —
    detect (implausible chars/sec) and re-dub per-clause (then per-comma).
  * MONOTONIC source walk: clips never jump backward / repeat footage.

Drop-in for stash's recap task: feed it the recap-service beats + the (augmented)
transcript; it replaces planRecapClips + clip-extract + dub + mux.

Beats JSON: {"beats":[{"cues":[..] | "start":<sec>, "text":"...", "coldopen"?:true}]}
Dub service URL: --dub-url, else $RECAP_DUB_URL, else http://127.0.0.1:5093/v1/dub
Usage: render_recap.py <beats.json> <transcript.srt> <video> <out.mp4>
       [--voice nix] [--tail 0.25] [--bedvol 0.6] [--dub-url URL] [--workdir DIR]
"""
import sys, os, re, json, subprocess, tempfile, urllib.request, uuid, time, shutil, argparse

DUB_URL = os.environ.get("RECAP_DUB_URL", "http://127.0.0.1:5093/v1/dub")
DUB_VOICE = os.environ.get("RECAP_DUB_VOICE", "nix")
SIL = ("silenceremove=start_periods=1:start_threshold=-40dB:detection=peak,areverse,"
       "silenceremove=start_periods=1:start_threshold=-40dB:detection=peak,areverse")
TRUNC_CPS = 7.5
MAXLEN = 20


def parse_srt_index(path):
    cues = {}
    for blk in re.split(r"\n\s*\n", open(path, encoding="utf-8", errors="replace").read().strip()):
        L = blk.splitlines()
        if len(L) < 2:
            continue
        try:
            n = int(L[0].strip())
        except ValueError:
            continue
        m = re.search(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->", blk)
        if not m:
            continue
        g = list(map(int, m.groups()))
        cues[n] = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
    return cues


def ts(t):
    if t < 0:
        t = 0
    h = int(t // 3600); m = int(t % 3600 // 60); s = int(t % 60); ms = int(round((t - int(t)) * 1000))
    if ms == 1000:
        s += 1; ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def run(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def probe(p):
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", p]).decode().strip())


def nchars(s):
    return len([c for c in s if not c.isspace()])


def post_dub(text, dur, voice, out):
    boundary = "----rr" + uuid.uuid4().hex
    parts = []

    def field(n, v):
        parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n{v}\r\n").encode())

    field("text", f"1\n{ts(0)} --> {ts(dur)}\n{text}\n")
    field("duration", f"{dur:.3f}")
    field("voice", voice)
    field("recut", "0")
    parts.append((f"--{boundary}--\r\n").encode())
    req = urllib.request.Request(DUB_URL, data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        ct = r.headers.get("Content-Type", "")
        payload = r.read()
    if ct.startswith("multipart/"):
        b = ct.split("boundary=")[1].strip('"')
        for part in payload.split(("--" + b).encode()):
            if b"audio" in part.split(b"\r\n\r\n")[0].lower():
                payload = part.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0]
                break
    open(out, "wb").write(payload)


def dub_trim(text, work, tag, voice):
    raw = os.path.join(work, f"raw_{tag}.wav")
    last = None
    for att in range(1, 7):
        try:
            post_dub(text, nchars(text) / 3.0 + 3.0, voice, raw)
            last = None
            break
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"    dub {tag} attempt {att}: {str(e)[:60]}", flush=True)
            time.sleep(att * 3)
    if last:
        return None, 0.0
    sp = os.path.join(work, f"sp_{tag}.wav")
    run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", raw, "-af", SIL,
        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", sp)
    return sp, probe(sp)


def concat_wavs(parts, work, tag, gap=0.08):
    if not parts:
        return None
    seq = parts
    if gap > 0 and len(parts) > 1:
        sil = os.path.join(work, f"g_{tag}.wav")
        run("ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-t", f"{gap:.3f}",
            "-i", "anullsrc=r=44100:cl=stereo", "-c:a", "pcm_s16le", sil)
        seq = []
        for i, p in enumerate(parts):
            seq.append(p)
            if i < len(parts) - 1:
                seq.append(sil)
    lst = os.path.join(work, f"cl_{tag}.txt")
    open(lst, "w", encoding="utf-8").write("\n".join(f"file '{p}'" for p in seq))
    out = os.path.join(work, f"cat_{tag}.wav")
    run("ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out)
    return out


def synth_speech(text, work, idx, voice):
    sp, L = dub_trim(text, work, f"{idx}w", voice)
    n = nchars(text)
    if sp is not None and L > 0 and n / L <= TRUNC_CPS:
        return sp, L
    print(f"  [beat {idx + 1}] truncated/retry -> per-clause", flush=True)
    cls = [c.strip() for c in re.split(r"(?<=[。!?！？;；…])", text) if c.strip()]
    parts = []
    for j, c in enumerate(cls):
        spc, _ = dub_trim(c, work, f"{idx}c{j}", voice)
        if spc is not None:
            parts.append(spc)
            continue
        for k, s in enumerate(x.strip() for x in re.split(r"(?<=[,，、])", c) if x.strip()):
            sps, _ = dub_trim(s, work, f"{idx}c{j}s{k}", voice)
            if sps is not None:
                parts.append(sps)
    if parts:
        out = concat_wavs(parts, work, f"{idx}all", gap=0.08)
        return out, probe(out)
    if sp is not None:
        return sp, L
    raise RuntimeError(f"beat {idx + 1} dub fully failed")


def lines_of(text):
    parts = [p.strip() for p in re.split(r"(?<=[。!?！？;；,，、…:：])", text) if p.strip()]
    out = []
    for p in parts:
        while len(p) > MAXLEN:
            out.append(p[:MAXLEN]); p = p[MAXLEN:]
        if p:
            out.append(p)
    merged = []
    for ln in out:
        if merged and len(ln) <= 2:
            merged[-1] = merged[-1] + ln
        else:
            merged.append(ln)
    return merged or [text]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("beats"); ap.add_argument("transcript"); ap.add_argument("video"); ap.add_argument("out")
    ap.add_argument("--voice", default=DUB_VOICE)
    ap.add_argument("--tail", type=float, default=0.25)
    ap.add_argument("--bedvol", type=float, default=0.6, help="original-audio bed level (0 = muted clips)")
    ap.add_argument("--dub-url", default=None)
    ap.add_argument("--workdir", default=None)
    a = ap.parse_args()
    global DUB_URL
    if a.dub_url:
        DUB_URL = a.dub_url
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    minclip = 1.2
    cues = parse_srt_index(a.transcript)
    raw = json.load(open(a.beats, encoding="utf-8"))
    beats = raw.get("beats") if isinstance(raw, dict) else raw
    vdur = probe(a.video)
    if a.workdir:
        work = a.workdir; os.makedirs(work, exist_ok=True); keep = True
    else:
        work = tempfile.mkdtemp(prefix="render-recap-"); keep = False
    print(f"video={vdur:.0f}s beats={len(beats)} voice={a.voice} bedvol={a.bedvol} dub={DUB_URL}", flush=True)

    clips, narrs, beds, disp = [], [], [], []
    offset = 0.0; prev_end = 0.0; idx = 0
    for b in beats:
        text = (b.get("text") or "").strip()
        if not text:
            continue
        if b.get("start") is not None:
            anchor = float(b["start"])
        else:
            cl = [int(c) for c in (b.get("cues") or []) if int(c) in cues]
            if not cl:
                continue
            anchor = min(cues[c] for c in cl)
        cv = os.path.join(work, f"c{idx}.mp4"); nv = os.path.join(work, f"n{idx}.wav"); ov = os.path.join(work, f"o{idx}.wav")
        if keep and os.path.exists(cv) and os.path.exists(nv) and os.path.exists(ov):
            try:
                rd = probe(cv)
            except Exception:
                rd = 0.0
            if rd > 0:
                start = max(anchor, prev_end); prev_end = 0.0 if b.get("coldopen") else start + rd
                clips.append(cv); narrs.append(nv); beds.append(ov)
                disp.append((offset, offset + rd, text)); offset += rd; idx += 1
                print(f"  [cached] beat {idx}/{len(beats)} {rd:.1f}s", flush=True)
                continue
        speechw, L = synth_speech(text, work, idx, a.voice)
        if L < minclip:
            L = minclip
        clipdur = L + a.tail
        start = max(anchor, prev_end)
        if start + clipdur > vdur:
            start = max(0.0, vdur - clipdur)
        prev_end = 0.0 if b.get("coldopen") else start + clipdur

        run("ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", a.video, "-t", f"{clipdur:.3f}",
            "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-r", "25", "-vsync", "cfr", cv)
        realdur = probe(cv)
        run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", speechw, "-af", f"apad,atrim=0:{realdur:.3f}",
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", nv)
        run("ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", a.video, "-t", f"{realdur:.3f}",
            "-vn", "-af", f"apad,atrim=0:{realdur:.3f}", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", ov)
        clips.append(cv); narrs.append(nv); beds.append(ov)
        disp.append((offset, offset + realdur, text)); offset += realdur; idx += 1
        tag = "[COLD-OPEN] " if b.get("coldopen") else ""
        print(f"  {tag}beat {idx}/{len(beats)} src[{start:.0f}s] {realdur:.1f}s :: {text[:16]}", flush=True)

    def concat_mp4(parts, out):
        lst = out + ".txt"; open(lst, "w", encoding="utf-8").write("\n".join(f"file '{p}'" for p in parts))
        run("ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out)
        os.remove(lst)
    rv = os.path.join(work, "rv.mp4"); concat_mp4(clips, rv)
    narr_all = concat_wavs(narrs, work, "narr", gap=0.0)

    if a.bedvol > 0:
        bed_all = concat_wavs(beds, work, "bed", gap=0.0)
        filt = (f"[1:a]volume={a.bedvol},aformat=sample_rates=44100:channel_layouts=stereo[bv];"
                f"[bv][0:a]sidechaincompress=threshold=0.02:ratio=12:attack=5:release=300[bd];"
                f"[0:a][bd]amix=inputs=2:duration=first:normalize=0[m];"
                f"[m]loudnorm=I=-14:TP=-1.5:LRA=11[a]")
        mix = os.path.join(work, "mix.wav")
        run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", narr_all, "-i", bed_all,
            "-filter_complex", filt, "-map", "[a]", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", mix)
    else:
        mix = os.path.join(work, "mix.wav")
        run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", narr_all,
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", mix)

    rows = []
    for (s, e, t) in disp:
        lns = lines_of(t); tot = sum(len(x) for x in lns) or 1; tt = s
        for i, ln in enumerate(lns):
            d = e if i == len(lns) - 1 else tt + (e - s) * (len(ln) / tot)
            if d - tt < 0.6:
                d = min(e, tt + 0.6)
            rows.append((tt, d, ln)); tt = d
    srtp = os.path.join(work, "disp.srt")
    with open(srtp, "w", encoding="utf-8") as f:
        for i, (s, e, ln) in enumerate(rows, 1):
            f.write(f"{i}\n{ts(s)} --> {ts(e)}\n{ln}\n\n")
    side = os.path.splitext(a.out)[0] + ".zh.srt"
    try:
        shutil.copy(srtp, side)
    except Exception:
        pass

    run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", rv, "-i", mix, "-i", srtp,
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-c:s", "mov_text", "-metadata:s:s:0", "language=zh", a.out)
    vv = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                  "stream=duration", "-of", "default=nw=1:nk=1", a.out]).decode().strip()
    va = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                                  "stream=duration", "-of", "default=nw=1:nk=1", a.out]).decode().strip()
    print(f"DONE total={offset:.0f}s ({offset / 60:.1f}min) clips={idx} sub_lines={len(rows)} "
          f"video={vv} audio={va} -> {a.out}", flush=True)
    if not keep:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
