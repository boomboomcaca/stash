#!/usr/bin/env python3
"""Chunked dubbing driver (runs ON the stash box).

Why chunked: the dub service is a single-GPU worker. One whole-video request
(long synthesis + ~300MB bg upload) is what wedged/reset it. Short, SEQUENTIAL,
bounded requests with per-chunk bg extraction (small uploads) are reliable and
each chunk is retryable. The service returns a wav of EXACTLY the requested
duration, so fixed-length chunks concatenate in perfect A/V sync.

Usage: dub_chunks.py <video> <zh_dub_srt> <zh_clean_srt> <out_mp4> [--chunk N] [--no-bg]
"""
import sys, os, re, subprocess, tempfile, urllib.request, uuid, shutil, time

DUB_URL = "http://192.168.1.113:5093/v1/dub"
VOICE = "nix"
REQ_TIMEOUT = 700          # per-chunk hard timeout (s) — bounded, never pins forever
RETRIES = 3

def ts(t):
    # Integer milliseconds so rounding carries through s/m/h (no "00:02:60,000").
    tms=max(0,int(round(t*1000)))
    h,r=divmod(tms,3600000); m,r=divmod(r,60000); s,ms=divmod(r,1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def parse_srt(path):
    cues=[]
    for blk in re.split(r'\n\s*\n', open(path,encoding='utf-8').read().strip()):
        L=blk.split('\n')
        if len(L)<3: continue
        m=re.match(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)',L[1])
        if not m: continue
        g=list(map(int,m.groups()))
        st=g[0]*3600+g[1]*60+g[2]+g[3]/1000; en=g[4]*3600+g[5]*60+g[6]+g[7]/1000
        cues.append({'st':st,'en':en,'text':'\n'.join(L[2:])})
    return cues

def run(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def probe_dur(path):
    out=subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration',
        '-of','default=noprint_wrappers=1:nokey=1',path]).decode().strip()
    return float(out)

def post_dub(text, duration, bg_wav, out_wav):
    boundary='----lndub'+uuid.uuid4().hex
    parts=[]
    def field(name,val):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n'.encode())
    field('text',text); field('duration',f'{duration:.3f}'); field('voice',VOICE); field('recut','0')
    if bg_wav:
        with open(bg_wav,'rb') as f: data=f.read()
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="bg_audio"; filename="bg.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
        parts.append(data); parts.append(b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    body=b''.join(parts)
    req=urllib.request.Request(DUB_URL,data=body,headers={'Content-Type':f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req,timeout=REQ_TIMEOUT) as r:
        ct=r.headers.get('Content-Type',''); payload=r.read()
    if ct.startswith('multipart/'):
        b=ct.split('boundary=')[1].strip('"')
        for part in payload.split(('--'+b).encode()):
            head=part.split(b'\r\n\r\n')[0].lower()
            if b'audio' in head:
                payload=part.split(b'\r\n\r\n',1)[1].rsplit(b'\r\n',1)[0]; break
    open(out_wav,'wb').write(payload)

def main():
    video, zdub, zclean, out = sys.argv[1:5]
    bg = '--no-bg' not in sys.argv
    CHUNK = 180.0
    if '--chunk' in sys.argv: CHUNK=float(sys.argv[sys.argv.index('--chunk')+1])
    cues=parse_srt(zdub)
    total=probe_dur(video)                      # span the FULL video so trailing video isn't cut by -shortest
    work=tempfile.mkdtemp(prefix='lndub_')
    shutil.copy(zclean, os.path.join(work,'disp.srt'))   # snapshot display subs (guard vs external deletion)
    disp=os.path.join(work,'disp.srt')
    nchunks=int((total+CHUNK-1)//CHUNK)
    print(f"video={total:.1f}s cues={len(cues)} chunk={CHUNK}s -> {nchunks} chunks bg={bg} work={work}",flush=True)
    wavs=[]; t0=0.0; k=0
    while t0 < total - 0.05:
        t1=min(t0+CHUNK, total); dur=t1-t0
        # own each cue by the chunk its START falls in, so a cue straddling the
        # chunk boundary is dubbed once (in its start chunk), not duplicated at
        # the seam. Its tail past t1 is truncated by the clip on the next line.
        sub=[c for c in cues if t0-0.01 <= c['st'] < t1-0.01]
        cs=os.path.join(work,f'c{k}.srt')
        with open(cs,'w',encoding='utf-8') as f:
            for i,c in enumerate(sub,1):
                a=min(max(0,c['st']-t0),dur); b=min(max(a+0.2,c['en']-t0),dur)
                f.write(f"{i}\n{ts(a)} --> {ts(b)}\n{c['text']}\n\n")
        bgw=None
        if bg:
            bgw=os.path.join(work,f'bg{k}.wav')
            run('ffmpeg','-nostdin','-v','error','-y','-ss',f'{t0:.3f}','-t',f'{dur:.3f}','-i',video,
                '-vn','-ac','2','-ar','44100','-c:a','pcm_s16le',bgw)
        raw=os.path.join(work,f'r{k}.wav')
        t_start=time.time(); ok=False
        for attempt in range(1,RETRIES+1):
            try:
                if sub:
                    post_dub(open(cs,encoding='utf-8').read(), dur, bgw, raw)
                else:
                    # silent gap: just make `dur` seconds of silence
                    run('ffmpeg','-nostdin','-v','error','-y','-f','lavfi','-t',f'{dur:.3f}',
                        '-i','anullsrc=r=44100:cl=stereo','-c:a','pcm_s16le',raw)
                ok=True; break
            except Exception as e:
                print(f"  chunk {k} attempt {attempt} FAILED: {e}",flush=True); time.sleep(5)
        if not ok:
            print(f"ABORT at chunk {k}",flush=True); sys.exit(2)
        # force EXACT chunk length so concatenation stays in sync
        fix=os.path.join(work,f'f{k}.wav')
        run('ffmpeg','-nostdin','-v','error','-y','-i',raw,'-af',f'apad,atrim=0:{dur:.3f}',
            '-ar','44100','-ac','2','-c:a','pcm_s16le',fix)
        wavs.append(fix)
        print(f"  chunk {k+1}/{nchunks} [{t0:.0f}-{t1:.0f}] {len(sub)} cues  {time.time()-t_start:.0f}s",flush=True)
        t0=t1; k+=1
    lst=os.path.join(work,'list.txt'); open(lst,'w').write('\n'.join(f"file '{w}'" for w in wavs))
    dubfull=os.path.join(work,'dub_full.wav')
    run('ffmpeg','-nostdin','-v','error','-y','-f','concat','-safe','0','-i',lst,'-c','copy',dubfull)
    print(f"concatenated {len(wavs)} chunks; muxing -> {out}",flush=True)
    # no -shortest: the soft-sub ends at the last caption (before the video tail),
    # and -shortest would truncate the whole output there; dub audio already spans
    # the full video, so the output keeps the original length.
    run('ffmpeg','-nostdin','-v','error','-y','-i',video,'-i',dubfull,'-i',disp,
        '-map','0:v:0','-map','1:a:0','-map','2:0','-c:v','copy','-c:a','aac','-b:a','192k',
        '-c:s','mov_text','-metadata:s:s:0','language=zh',out)
    print(f"DONE -> {out}",flush=True)
    shutil.rmtree(work,ignore_errors=True)

if __name__=='__main__':
    main()
