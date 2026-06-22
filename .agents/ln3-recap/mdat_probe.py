#!/usr/bin/env python3
"""Probe whether an MP4's mdat holds intact AVCC (length-prefixed) H.264 NALs,
independent of the (suspected-corrupt) moov sample table.

Walks bytes as [4-byte BE length][NAL...]; on a break, resyncs forward to the
next plausible NAL header. Audio chunks interleaved in mdat just look like gaps
that resync recovers, so high coverage => the video bitstream is recoverable
(reindex/untrunc viable); low coverage => the payload itself is scrambled.
"""
import sys, struct

PATH = sys.argv[1]
MDAT_OFF = int(sys.argv[2]) if len(sys.argv) > 2 else 56
SCAN = int(sys.argv[3]) if len(sys.argv) > 3 else 200 * 1024 * 1024

VALID_NAL = set(range(1, 24))   # h264 nal_unit_type 1..23
KEY_NAL = {1, 5, 6, 7, 8, 9}    # slice/IDR/SEI/SPS/PPS/AUD — common ones


def nal_ok(b):
    # AVCC NAL header byte: forbidden_zero_bit must be 0; type in 1..23
    return (b & 0x80) == 0 and (b & 0x1F) in VALID_NAL


def main():
    with open(PATH, "rb") as f:
        f.seek(MDAT_OFF)
        data = f.read(SCAN)
    n = len(data)
    i = 0
    covered = 0          # bytes accounted for by valid NAL runs
    nals = 0
    runs = 0             # number of clean walk segments
    longest = 0
    sps = pps = idr = slc = sei = 0
    while i + 5 <= n:
        L = struct.unpack(">I", data[i:i+4])[0]
        hdr = data[i+4]
        if 0 < L <= 4_000_000 and i + 4 + L <= n and nal_ok(hdr):
            t = hdr & 0x1F
            if t == 7: sps += 1
            elif t == 8: pps += 1
            elif t == 5: idr += 1
            elif t == 1: slc += 1
            elif t == 6: sei += 1
            i += 4 + L
            covered += 4 + L
            nals += 1
            seg = 4 + L
            # extend run
            runlen = seg
            while i + 5 <= n:
                L2 = struct.unpack(">I", data[i:i+4])[0]
                h2 = data[i+4]
                if 0 < L2 <= 4_000_000 and i + 4 + L2 <= n and nal_ok(h2):
                    t2 = h2 & 0x1F
                    if t2 == 7: sps += 1
                    elif t2 == 8: pps += 1
                    elif t2 == 5: idr += 1
                    elif t2 == 1: slc += 1
                    elif t2 == 6: sei += 1
                    i += 4 + L2
                    covered += 4 + L2
                    nals += 1
                    runlen += 4 + L2
                else:
                    break
            runs += 1
            if runlen > longest:
                longest = runlen
        else:
            i += 1   # resync: slide one byte
    pct = 100.0 * covered / n if n else 0
    print(f"scanned={n} bytes from mdat offset {MDAT_OFF}")
    print(f"valid-NAL coverage = {pct:.1f}%  (nals={nals}, walk-runs={runs}, longest-run={longest} bytes)")
    print(f"nal types: SPS={sps} PPS={pps} IDR={idr} slice={slc} SEI={sei}")
    print("VERDICT:", "VIDEO DATA INTACT (recoverable by reindex)" if pct > 60 else
          ("PARTIAL/UNCERTAIN" if pct > 20 else "PAYLOAD SCRAMBLED (reindex won't help)"))


if __name__ == "__main__":
    main()
