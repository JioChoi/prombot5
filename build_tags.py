"""Build data/tags.csv from the Danbooru 2026 metadata dump.

Counts every tag on every post and writes them sorted by usage, descending.
Category is a single digit matching Danbooru's own tag category ids, which
keeps the file ~15% smaller than spelling the names out.
"""

import argparse
import csv
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import pyarrow.compute as pc
import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem

REPO = "datasets/nick007x/Danbooru-2026-parquet-metadata"

# danbooru category ids: 0 general, 1 artist, 3 copyright, 4 character, 5 meta
CATEGORIES = {
    "tag_string_general": 0,
    "tag_string_artist": 1,
    "tag_string_copyright": 3,
    "tag_string_character": 4,
    "tag_string_meta": 5,
}
RATING_CAT = 9
RATINGS = {"g": "rating:general", "s": "rating:sensitive",
           "q": "rating:questionable", "e": "rating:explicit"}


def count_file(path):
    """Count tags in one parquet part. Splitting and counting happen in
    arrow's C++ kernels; python only sees the per-part aggregates."""
    counts = defaultdict(lambda: defaultdict(int))
    with HfFileSystem().open(path, "rb") as fh:
        reader = pq.ParquetFile(fh)
        cols = list(CATEGORIES) + ["rating"]
        for batch in reader.iter_batches(batch_size=200_000, columns=cols):
            for col, cat in CATEGORIES.items():
                tags = pc.split_pattern(batch.column(col), " ").flatten()
                vc = pc.value_counts(tags)
                bucket = counts[cat]
                for tag, n in zip(vc.field("values").to_pylist(),
                                  vc.field("counts").to_pylist()):
                    if tag:
                        bucket[tag] += n
            vc = pc.value_counts(batch.column("rating"))
            bucket = counts[RATING_CAT]
            for r, n in zip(vc.field("values").to_pylist(),
                            vc.field("counts").to_pylist()):
                if r in RATINGS:
                    bucket[RATINGS[r]] += n
    print(f"  {path.rsplit('/', 1)[-1]} done", flush=True)
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-count", type=int, default=20,
                    help="drop tags used fewer than this many times")
    ap.add_argument("--out", default="data/tags.csv")
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()

    started = time.time()
    files = sorted(f for f in HfFileSystem().ls(REPO, detail=False)
                   if f.endswith(".parquet"))
    print(f"{len(files)} parts, {args.workers} workers", flush=True)

    merged = defaultdict(lambda: defaultdict(int))
    with ThreadPoolExecutor(args.workers) as pool:
        for part in pool.map(count_file, files):
            for cat, bucket in part.items():
                target = merged[cat]
                for tag, n in bucket.items():
                    target[tag] += n

    rows = [(tag, n, cat)
            for cat, bucket in merged.items()
            for tag, n in bucket.items()
            if n >= args.min_count]
    rows.sort(key=lambda r: -r[1])

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "count", "cat"])
        w.writerows(rows)

    total = sum(len(b) for b in merged.values())
    print(f"{len(rows)} tags kept of {total} (min_count={args.min_count}) "
          f"-> {args.out} in {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
