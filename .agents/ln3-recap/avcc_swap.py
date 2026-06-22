#!/usr/bin/env python3
"""Replace the avcC (H.264 decoder config / SPS+PPS) box in a repaired MP4 with
the *correct* avcC taken from the original file.

untrunc rebuilds a correct sample index + timing but stamps the *reference*
file's avcC; when the reference resolution/SPS differs from the real frames the
decoder errors out. The real frames carry no in-band SPS (AVCC), so the original
file's avcC must be grafted back in.

moov sits at the end (after mdat), so editing it never shifts the mdat sample
offsets in stco/co64 — we only bump the size fields of avcC's container chain.

usage:
  avcc_swap.py inspect <file>
  avcc_swap.py swap <orig_with_good_avcC> <repaired_in> <out>
"""
import sys, struct

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"avc1",
              b"avc3", b"encv"}


def iter_boxes(buf, start, end):
    pos = start
    while pos + 8 <= end:
        size = struct.unpack(">I", buf[pos:pos+4])[0]
        typ = bytes(buf[pos+4:pos+8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", buf[pos+8:pos+16])[0]
            hdr = 16
        elif size == 0:
            size = end - pos
        yield pos, size, typ, hdr
        if size <= 0:
            break
        pos += size


def child_start(typ, pos, hdr):
    cs = pos + hdr
    if typ == b"stsd":
        cs += 8                      # FullBox version/flags + entry_count
    elif typ in (b"avc1", b"avc3", b"encv"):
        cs += 78                     # VisualSampleEntry fixed fields
    return cs


def find_avcc(buf, start, end, ancestors):
    """Return (avcc_pos, avcc_size, ancestor_sizefield_positions[]) or None."""
    for pos, size, typ, hdr in iter_boxes(buf, start, end):
        if typ == b"avcC":
            return pos, size, list(ancestors)
        if typ in CONTAINERS:
            r = find_avcc(buf, child_start(typ, pos, hdr), pos + size,
                          ancestors + [pos])   # pos == size-field offset (32-bit boxes)
        else:
            r = None
        if r:
            return r
    return None


def top_moov(buf_head, filesize, f):
    """Locate the top-level moov box: (moov_start, moov_size)."""
    pos = 0
    while pos + 8 <= filesize:
        f.seek(pos)
        hdr = f.read(16)
        size = struct.unpack(">I", hdr[0:4])[0]
        typ = hdr[4:8]
        if size == 1:
            size = struct.unpack(">Q", hdr[8:16])[0]
        elif size == 0:
            size = filesize - pos
        if typ == b"moov":
            return pos, size
        pos += size
    raise SystemExit("no moov found")


def read_avcc_box(path):
    import os
    fs = os.path.getsize(path)
    with open(path, "rb") as f:
        ms, msz = top_moov(None, fs, f)
        f.seek(ms)
        moov = f.read(msz)
    r = find_avcc(moov, 8, len(moov), [])
    if not r:
        raise SystemExit(f"no avcC in {path}")
    pos, size, _ = r
    return moov[pos:pos+size]


def patch_chunk_offsets(buf, start, end, delta):
    """Add `delta` to every entry of every stco/co64 box in [start,end)."""
    n = 0
    for pos, size, typ, hdr in iter_boxes(buf, start, end):
        if typ == b"stco":
            cnt = struct.unpack(">I", buf[pos+12:pos+16])[0]
            off = pos + 16
            for k in range(cnt):
                v = struct.unpack(">I", buf[off:off+4])[0]
                struct.pack_into(">I", buf, off, v + delta)
                off += 4
            n += cnt
        elif typ == b"co64":
            cnt = struct.unpack(">I", buf[pos+12:pos+16])[0]
            off = pos + 16
            for k in range(cnt):
                v = struct.unpack(">Q", buf[off:off+8])[0]
                struct.pack_into(">Q", buf, off, v + delta)
                off += 8
            n += cnt
        elif typ in CONTAINERS:
            n += patch_chunk_offsets(buf, child_start(typ, pos, hdr), pos + size, delta)
    return n


def sps_dims(avcc_box):
    """Crude width/height from the SPS inside an avcC box payload (best effort)."""
    # avcC box = [4 size][4 'avcC'][payload]; payload: 1 ver,1 prof,1 compat,1 level,
    # 1 (6bits reserved + lengthSizeMinusOne), 1 (3bits reserved + numSPS), 2 spsLen, SPS...
    p = avcc_box[8:]
    if len(p) < 7:
        return None
    num_sps = p[5] & 0x1F
    if num_sps < 1:
        return None
    sps_len = struct.unpack(">H", p[6:8])[0]
    return f"avcC payload={len(p)}B numSPS={num_sps} spsLen={sps_len}"


def main():
    mode = sys.argv[1]
    if mode == "inspect":
        box = read_avcc_box(sys.argv[2])
        print(f"avcC total size = {len(box)} bytes; {sps_dims(box)}")
        return
    if mode == "swap":
        orig, rep, out = sys.argv[2], sys.argv[3], sys.argv[4]
        good = read_avcc_box(orig)
        import os
        fs = os.path.getsize(rep)
        with open(rep, "rb") as f:
            ms, msz = top_moov(None, fs, f)
            f.seek(ms)
            moov = bytearray(f.read(msz))
        r = find_avcc(moov, 8, len(moov), [])
        if not r:
            raise SystemExit("no avcC in repaired file")
        apos, asize, anc = r
        old = bytes(moov[apos:apos+asize])
        delta = len(good) - asize
        print(f"repaired avcC: {asize}B ({sps_dims(old)})")
        print(f"good avcC    : {len(good)}B ({sps_dims(good)})  delta={delta}")
        # bump ancestor size fields (each is a 32-bit big-endian at its box start)
        for sf in anc:
            old_sz = struct.unpack(">I", moov[sf:sf+4])[0]
            struct.pack_into(">I", moov, sf, old_sz + delta)
        # splice the new (larger) avcC in place of the old
        new_moov = bytearray(moov[:apos]) + good + bytes(moov[apos+asize:])
        # if moov precedes mdat, growing it shifts every chunk: fix stco/co64
        moov_at_front = (ms + msz) < fs
        if moov_at_front and delta != 0:
            patched = patch_chunk_offsets(new_moov, 8, len(new_moov), delta)
            print(f"moov-at-front: bumped {patched} chunk offsets by {delta}")
        # write prefix (before moov) + patched moov + suffix (after old moov)
        with open(rep, "rb") as f, open(out, "wb") as o:
            remaining = ms
            while remaining > 0:                 # prefix verbatim
                chunk = f.read(min(8 * 1024 * 1024, remaining))
                if not chunk:
                    break
                o.write(chunk)
                remaining -= len(chunk)
            o.write(new_moov)                    # patched moov
            f.seek(ms + msz)                     # suffix (mdat etc.) verbatim
            while True:
                chunk = f.read(8 * 1024 * 1024)
                if not chunk:
                    break
                o.write(chunk)
        print(f"wrote {out}: prefix={ms}B + moov={len(new_moov)}B(was {msz}) + suffix(after {ms+msz})")
        return
    raise SystemExit("usage: inspect <f> | swap <orig> <repaired> <out>")


if __name__ == "__main__":
    main()
