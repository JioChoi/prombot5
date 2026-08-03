"""Turn prompt-tags.csv.gz into files the client can range-request.

The old dictionary was one 11 MB gzip holding all 928k tags, and every query
that named a tag paid for the whole thing — 30 MB of text to parse before the
first count appeared. Almost none of it is ever used: a query touches a handful
of tags, and a prompt names thirty.

So the same rows go out twice, blocked both ways a client reads them:

  tag-lookup.bin   tag,count,off,len,cat,id — tags sorted by name, 256 per block.
                   Looking a tag up is one range request for its block.
  tag-lookup.json.gz  [firstTagOfBlock, byteOffset] per block, plus the file
                   length. ~60 KB, the only part loaded up front.
  tag-names.bin    names in tag-id order, 64 per block, each line prefixed
                   with its one-digit danbooru category. Decoding a record
                   needs the names of its ids and nothing else.
  tag-names.idx    uint32 LE block offsets, one per block plus a terminator.

Ids are assigned count-descending, so a typical post's tags cluster in the
first few name blocks and the cache fills up fast. Name blocks are the smaller
of the two: a prompt names thirty scattered tags and pays a block for each, so
that block is sized for one tag, not for a scan.

Runs off the built csv — no dump, no duckdb:

    python build_dict.py
"""

import argparse
import csv
import gzip
import json
import os
import struct

BLOCK = 256       # tags per tag-lookup.bin block
NAME_BLOCK = 64   # tags per tag-names.bin block


def read_rows(path):
    """(tag, count, off, len, cat) per tag, in tag-id order (= file order)."""
    with gzip.open(path, "rt", encoding="utf-8", newline="") as fh:
        return [(r["tag"], int(r["count"]), int(r["off"]), int(r["len"]),
                 int(r["cat"])) for r in csv.DictReader(fh)]


def write_lookup(rows, bin_path, idx_path):
    """Name-sorted blocks + the first name of each, for a binary search.

    The tag id — the row's position in the id-ordered input — rides along, so a
    query can be turned into the ids a post record actually stores and matched
    against a record without resolving any names."""
    rows = sorted((r[0], r[1], r[2], r[3], r[4], i) for i, r in enumerate(rows))
    index = []
    with open(bin_path, "wb") as fh:
        for i in range(0, len(rows), BLOCK):
            block = rows[i:i + BLOCK]
            index.append([block[0][0], fh.tell()])
            body = "".join(f"{t},{c},{o},{l},{k},{n}\n" for t, c, o, l, k, n in block)
            fh.write(body.encode("utf-8"))
        end = fh.tell()
    with gzip.open(idx_path, "wt", encoding="utf-8", compresslevel=9) as fh:
        json.dump({"block": BLOCK, "end": end, "blocks": index}, fh)
    return end


def write_names(rows, bin_path, idx_path):
    """Names in id order, blocked, with a uint32 offset table.

    Each line is `<cat><name>`: the client needs a tag's category to label an
    artist, and one digit is cheaper than a second lookup."""
    offsets = []
    with open(bin_path, "wb") as fh:
        for i in range(0, len(rows), NAME_BLOCK):
            offsets.append(fh.tell())
            body = "".join(f"{r[4]}{r[0]}\n" for r in rows[i:i + NAME_BLOCK])
            fh.write(body.encode("utf-8"))
        offsets.append(fh.tell())
    with open(idx_path, "wb") as fh:
        fh.write(struct.pack(f"<{len(offsets)}I", *offsets))
    return offsets[-1]


def build(out="frontend/public", src="data/prompt-tags.csv.gz"):
    rows = read_rows(src)
    lookup = write_lookup(rows, f"{out}/tag-lookup.bin",
                          f"{out}/tag-lookup.json.gz")
    names = write_names(rows, f"{out}/tag-names.bin", f"{out}/tag-names.idx")
    idx = os.path.getsize(f"{out}/tag-lookup.json.gz")
    print(f"{len(rows)} tags -> lookup {lookup / 1e6:.1f} MB "
          f"(index {idx / 1e3:.0f} KB up front), names {names / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="frontend/public")
    ap.add_argument("--src", default="data/prompt-tags.csv.gz")
    args = ap.parse_args()
    build(args.out, args.src)


def demo():
    rows = [("b_tag", 5, 0, 10, 0), ("a_tag", 9, 10, 20, 1),
            ("c,comma", 1, 30, 5, 0)]
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        end = write_lookup(rows, f"{d}/l.bin", f"{d}/l.json.gz")
        with gzip.open(f"{d}/l.json.gz", "rt") as fh:
            idx = json.load(fh)
        assert idx["blocks"] == [["a_tag", 0]], idx
        assert idx["end"] == end == os.path.getsize(f"{d}/l.bin")
        body = open(f"{d}/l.bin", encoding="utf-8").read()
        # sorted by name, but each row keeps the id it had in the input
        assert body.splitlines()[0] == "a_tag,9,10,20,1,1"
        # a comma in a tag name still parses, because the last five fields win
        assert body.splitlines()[2] == "c,comma,1,30,5,0,2"

        total = write_names(rows, f"{d}/n.bin", f"{d}/n.idx")
        assert open(f"{d}/n.bin", encoding="utf-8").read() == \
            "0b_tag\n1a_tag\n0c,comma\n"  # id order with category prefix
        assert struct.unpack("<2I", open(f"{d}/n.idx", "rb").read()) == (0, total)
    print("ok")


if __name__ == "__main__":
    main()
