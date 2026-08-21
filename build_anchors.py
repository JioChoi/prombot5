"""Build frontend/public/prompts.anc.gz — the offset table the client holds.

Reading one record used to cost two round trips: prompts.idx says where the
record is, and only then can prompts.bin be asked for it. That chain is the
whole latency of a draw on a phone, and it cannot be parallelised — the second
request needs the first one's answer.

prompts.idx is 42 MB, which is why it stayed on the server. Every 64th entry is
260 KB, which does not: the client holds it and a record read becomes one
request. Post p lives in block p >> 6, and the block's two anchors bracket it
in prompts.bin exactly; the client decodes forward from the block's first
record, which is ~3.5 KB of walking.

This derives from prompts.idx rather than from the dump — the offsets are
already built, and re-running build_index.py to obtain a subset of a file it
already wrote would be an hour of duckdb for nothing.

    python build_anchors.py
"""

import argparse
import gzip

import numpy as np

# Posts per block. 64 is where the table is small enough to download (260 KB)
# and the block small enough to read (3.5 KB); 32 halves the read but doubles
# the table, and the table is paid by everyone, once, before anything works.
STRIDE = 64


def varint(vals):
    """LEB128, one value after another. Gaps are ~3.5 KB, so two bytes each."""
    out = bytearray()
    for v in vals:
        v = int(v)
        while True:
            b = v & 0x7F
            v >>= 7
            out.append(b | 0x80 if v else b)
            if not v:
                break
    return bytes(out)


def build(out="frontend/public", stride=STRIDE):
    idx = np.fromfile(f"{out}/prompts.idx", dtype="<u4").astype(np.int64)
    # Every stride-th record start, and the end of the last record — the final
    # anchor is what closes the last block, which is short whenever the post
    # count is not a multiple of the stride.
    anc = idx[::stride]
    if anc[-1] != idx[-1]:
        anc = np.concatenate([anc, idx[-1:]])
    # Ascending and evenly spaced, so the gaps are what compresses: 648 KB of
    # uint32 becomes 255 KB as gzipped varint gaps.
    blob = gzip.compress(varint(np.diff(np.concatenate([[0], anc]))), 9)
    with open(f"{out}/prompts.anc.gz", "wb") as fh:
        fh.write(blob)
    return len(anc), len(blob)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="frontend/public")
    args = ap.parse_args()
    n, size = build(args.out)
    print(f"prompts.anc.gz {n:,} anchors, {size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
