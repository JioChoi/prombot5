"""Turn prompt-tags.csv.gz into the one dictionary file the client loads.

    tag-dict.csv.gz   tag,count,off,len,cat,id — one row per tag, gzipped.

This used to go out as four files blocked for range requests: a name-sorted
dictionary with a block index, and names in id order with an offset table. That
made *looking a tag up* cheap, but decoding a drawn post is thirty scattered
name blocks, which is thirty round trips before a prompt can be shown.

Cutting tags used fewer than MIN_COUNT times is what makes the whole thing fit
in memory instead: 928k tags is 36 MB, the 109k tags used 50+ times are 4.5 MB
(2 MB gzipped) and still cover 98.6% of every tag occurrence in the corpus. So
the client downloads it once and every lookup after that is a Map hit.

Ids are the row's position in the id-ordered input and are NOT renumbered when
rows are cut, because prompts.bin and postings.bin store those ids and are not
rebuilt. A cut tag simply has no row here: its postings are unreachable, and a
post record mentioning it resolves to nothing and drops the tag.

Runs off the built csv — no dump, no duckdb:

    python build_dict.py [--min-count 50]
"""

import argparse
import csv
import gzip

MIN_COUNT = 50


def read_rows(path):
    """(tag, count, off, len, cat) per tag, in tag-id order (= file order)."""
    with gzip.open(path, "rt", encoding="utf-8", newline="") as fh:
        return [(r["tag"], int(r["count"]), int(r["off"]), int(r["len"]),
                 int(r["cat"])) for r in csv.DictReader(fh)]


def write_dict(rows, path, min_count=MIN_COUNT):
    """One gzipped row per surviving tag, carrying the id it had in `rows`.

    Sorted by name: it is what the file reads as, and neighbouring tag names
    share prefixes, which is worth a few percent to gzip."""
    kept = sorted((r[0], r[1], r[2], r[3], r[4], i)
                  for i, r in enumerate(rows) if r[1] >= min_count)
    body = "".join(f"{t},{c},{o},{l},{k},{n}\n" for t, c, o, l, k, n in kept)
    with gzip.open(path, "wb", compresslevel=9) as fh:
        fh.write(body.encode("utf-8"))
    return kept, len(body)


def build(out="frontend/public", src="data/prompt-tags.csv.gz",
          min_count=MIN_COUNT):
    rows = read_rows(src)
    kept, raw = write_dict(rows, f"{out}/tag-dict.csv.gz", min_count)
    import os
    gz = os.path.getsize(f"{out}/tag-dict.csv.gz")
    occ = sum(r[1] for r in rows)
    held = sum(r[1] for r in kept)
    print(f"{len(kept)} of {len(rows)} tags (count >= {min_count}) -> "
          f"{raw / 1e6:.1f} MB raw, {gz / 1e6:.2f} MB gzipped; "
          f"{held / occ * 100:.2f}% of tag occurrences kept")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="frontend/public")
    ap.add_argument("--src", default="data/prompt-tags.csv.gz")
    ap.add_argument("--min-count", type=int, default=MIN_COUNT)
    args = ap.parse_args()
    build(args.out, args.src, args.min_count)


def demo():
    rows = [("b_tag", 5, 0, 10, 0), ("a_tag", 9, 10, 20, 1),
            ("c,comma", 60, 30, 5, 0), ("d_tag", 50, 35, 7, 3)]
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        kept, _ = write_dict(rows, f"{d}/t.csv.gz", min_count=50)
        body = gzip.open(f"{d}/t.csv.gz", "rt", encoding="utf-8").read()
        lines = body.splitlines()

        # Under the cut, so they are gone entirely.
        assert not any(l.startswith("a_tag,") for l in lines), lines
        assert not any(l.startswith("b_tag,") for l in lines), lines
        # Exactly at the cut counts as kept — the check is >=, not >.
        assert any(l.startswith("d_tag,") for l in lines), lines

        # Ids are positions in the *input*, so cutting rows must not renumber
        # the survivors: prompts.bin still refers to them by the old id.
        assert lines[0] == "c,comma,60,30,5,0,2", lines
        assert lines[1] == "d_tag,50,35,7,3,3", lines
        # A comma in a tag name still parses, because the last five fields win.
        assert ",".join(lines[0].split(",")[:-5]) == "c,comma"
    print("ok")


if __name__ == "__main__":
    main()
