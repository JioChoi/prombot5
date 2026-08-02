"""Build the browser-side prompt index from the Danbooru 2026 metadata dump.

The browser must answer "give me a random post with these tags, without these
tags, over this many favourites" while downloading a few hundred KB, not 6 GB.
That works because everything is laid out for HTTP range requests:

  posts are ranked by fav_count, descending, and numbered 0..N-1 in that order.

So a fav_count floor is a *prefix* of every posting list — no per-post fav
lookup, no scan. Intersecting the include tags' posting lists gives the
candidate set; a random pick out of it needs exactly one record read.

Output (all in frontend/public/):

  prompt-tags.csv.gz  tag,count,cat,off,len — one row per tag, count-descending.
                Row order *is* the tag id. off/len address postings.bin. This is
                the index's own dictionary; the autocomplete's tags.csv is a
                separate file and is not touched.
  postings.bin  per tag: post numbers, ascending, delta + LEB128 varint.
  prompts.bin   per post: varint fav, varint danbooru id, varint tag count,
                then its tag ids, ascending, delta + varint. Categories are
                not stored per post — a tag id already carries its category
                via prompt-tags.csv.gz, so the client regroups for free.
  prompts.idx   uint32 LE, N+1 entries: byte offset of each record.
  prompts.json  row count and the fav_count -> prefix-length table.

Ratings ride along as pseudo-tags (rating:general, ...) in category 9, so a
rating filter is just another tag filter.
"""

import argparse
import gzip
import json
import os
import time

import duckdb
import numpy as np

import build_dict

REPO = "hf://datasets/nick007x/Danbooru-2026-parquet-metadata/*.parquet"
SOURCE = REPO

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

BATCH = 4_000_000  # (tag, post) pairs held in memory at once


def varint(vals):
    """LEB128-encode a whole array at once. Returns (bytes, width per value)."""
    v = np.asarray(vals, dtype=np.uint64)
    width = np.ones(len(v), dtype=np.int64)
    for shift in (7, 14, 21, 28):
        width += v >= (np.uint64(1) << np.uint64(shift))
    ends = np.cumsum(width)
    out = np.zeros(int(ends[-1]) if len(v) else 0, dtype=np.uint8)
    starts = ends - width
    for k in range(5):
        m = width > k
        if not m.any():
            break
        byte = ((v[m] >> np.uint64(7 * k)) & np.uint64(0x7F)).astype(np.uint8)
        out[starts[m] + k] = byte | ((width[m] > k + 1).astype(np.uint8) << 7)
    return out.tobytes(), width


def group_starts(keys):
    """First row of each run in an already-sorted key array."""
    if not len(keys):
        return np.empty(0, dtype=np.int64)
    return np.concatenate(([0], np.flatnonzero(keys[1:] != keys[:-1]) + 1))


def deltas(values, starts):
    """Gap-encode ascending runs: each run keeps its first value verbatim."""
    d = np.empty(len(values), dtype=np.int64)
    d[1:] = values[1:] - values[:-1]
    if len(d):
        d[0] = values[0]
    d[starts] = values[starts]
    return d


def batches(con, sql, key_col, size=BATCH):
    """Stream a sorted query, never splitting a run across two yields.

    The tail run of every batch is carried into the next one, so each yielded
    chunk holds only complete groups — the encoders can then work per batch
    without any cross-batch bookkeeping.
    """
    reader = con.execute(sql).to_arrow_reader(size)
    carry = None
    for rb in reader:
        cols = {n: rb.column(n).to_numpy(zero_copy_only=False) for n in rb.schema.names}
        if carry is not None:
            cols = {n: np.concatenate([carry[n], cols[n]]) for n in cols}
        keys = cols[key_col]
        cut = group_starts(keys)[-1]
        carry = {n: c[cut:] for n, c in cols.items()}
        if cut:
            yield {n: c[:cut] for n, c in cols.items()}
    if carry is not None and len(carry[key_col]):
        yield carry


def stage(con, name, sql, work, ordered=False):
    """Run one pipeline step straight to a parquet file and hand back a view.

    The whole dump is 10.6M posts and ~300M tag/post pairs, far past what fits
    in memory, so nothing is ever held as a table: each step streams into its
    own file and the next step reads it back. Only the steps that genuinely
    need it (the sorts, the group-by) spill, and duckdb does that itself.

    `ordered` keeps row order through the copy, which is what makes
    row_number() over an already-sorted file mean what it says.
    """
    path = f"{work}/{name}.parquet"
    con.execute(f"SET preserve_insertion_order={'true' if ordered else 'false'}")
    con.execute(f"COPY ({sql}) TO '{path}' (FORMAT parquet, COMPRESSION zstd)")
    con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM '{path}'")
    return con.sql(f"SELECT count(*) FROM {name}").fetchone()[0]


def build_posts(con, work):
    """Every post in the dump, ranked by favourites. Row number = post number.

    Nothing is dropped: a fav_count floor is a client-side prefix cut, so
    baking one in would only throw away rows the browser can already skip.
    """
    cols = ", ".join(f"{c} AS t{cat}" for c, cat in CATEGORIES.items())
    rating = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in RATINGS.items())
    stage(con, "ranked", f"""
        SELECT id, fav_count, {cols}, CASE rating {rating} ELSE NULL END AS trating
        FROM read_parquet('{SOURCE}')
        ORDER BY fav_count DESC, id
    """, work)
    return stage(con, "posts", """
        SELECT CAST(row_number() OVER () - 1 AS INTEGER) AS idx, *
        FROM ranked
    """, work, ordered=True)


def build_pairs(con, work):
    """(post, tag id) for every tag on every post, plus the tag table.

    Every tag is kept, however rare — a tag missing from the table would be
    missing from the records that use it, and the records are the product.
    """
    unions = [
        f"SELECT idx, unnest(str_split(t{cat}, ' ')) AS tag, {cat} AS cat FROM posts"
        for cat in CATEGORIES.values()
    ]
    unions.append(f"SELECT idx, trating AS tag, {RATING_CAT} AS cat FROM posts")
    stage(con, "flat", f"""
        SELECT idx, tag, cat FROM ({" UNION ALL ".join(unions)})
        WHERE tag IS NOT NULL AND tag <> ''
    """, work)
    n_tags = stage(con, "tags", """
        SELECT CAST(row_number() OVER (ORDER BY count(*) DESC, tag) - 1 AS INTEGER)
                   AS tag_id,
               tag, count(*) AS count, any_value(cat) AS cat
        FROM flat GROUP BY tag
    """, work)
    # Sorted by post here so the record writer can stream it as-is; the
    # posting writer re-sorts by tag, which is the one big sort left.
    stage(con, "pairs", """
        SELECT f.idx, t.tag_id FROM flat f JOIN tags t USING (tag)
        ORDER BY f.idx, t.tag_id
    """, work)
    return n_tags


def write_postings(con, path, n_tags):
    """One delta-varint posting list per tag, concatenated."""
    off = np.zeros(n_tags, dtype=np.int64)
    length = np.zeros(n_tags, dtype=np.int64)
    pos = 0
    with open(path, "wb") as fh:
        sql = "SELECT tag_id, idx FROM pairs ORDER BY tag_id, idx"
        for chunk in batches(con, sql, "tag_id"):
            tag_id, idx = chunk["tag_id"], chunk["idx"].astype(np.int64)
            starts = group_starts(tag_id)
            blob, width = varint(deltas(idx, starts))
            sizes = np.add.reduceat(width, starts)
            ids = tag_id[starts]
            off[ids] = pos + np.concatenate(([0], np.cumsum(sizes)[:-1]))
            length[ids] = sizes
            fh.write(blob)
            pos += len(blob)
    return off, length, pos


def write_prompts(con, bin_path, idx_path, n_posts):
    """One record per post: header varints, then its tag ids delta-encoded."""
    offsets = np.zeros(n_posts + 1, dtype=np.uint32)
    # Post number -> danbooru id and fav_count. Two columns of 10M rows are
    # small enough to hold, which keeps the pair stream a plain ordered scan
    # instead of a join against the wide post table.
    head_cols = con.sql("SELECT id, fav_count FROM posts ORDER BY idx").arrow().read_all()
    post_id = head_cols.column("id").to_numpy(zero_copy_only=False)
    post_fav = head_cols.column("fav_count").to_numpy(zero_copy_only=False)
    pos = 0
    with open(bin_path, "wb") as fh:
        # pairs is written post-ordered, so this needs no sort of its own —
        # but only if the scan is forbidden from handing back parallel chunks
        # in whatever order they finish.
        con.execute("SET preserve_insertion_order=true")
        sql = "SELECT idx, tag_id FROM pairs"
        for chunk in batches(con, sql, "idx"):
            post = chunk["idx"]
            tag_id = chunk["tag_id"].astype(np.int64)
            starts = group_starts(post)
            n_groups = len(starts)
            counts = np.diff(np.append(starts, len(post)))

            # Splice each record's three header values in front of its tags:
            # tag j of group g lands at j + 3g + 3, the header at start + 3g.
            gid = np.repeat(np.arange(n_groups), counts)
            vals = np.zeros(len(post) + 3 * n_groups, dtype=np.int64)
            vals[np.arange(len(post)) + 3 * gid + 3] = deltas(tag_id, starts)
            head = starts + 3 * np.arange(n_groups)
            vals[head] = post_fav[post[starts]]
            vals[head + 1] = post_id[post[starts]]
            vals[head + 2] = counts

            blob, width = varint(vals)
            sizes = np.add.reduceat(width, head)
            offsets[post[starts]] = pos + np.concatenate(([0], np.cumsum(sizes)[:-1]))
            fh.write(blob)
            pos += len(blob)
    # A post whose tag strings are all empty produces no rows to group over,
    # so its slot was never written. Carrying the previous offset forward
    # leaves it a zero-length record instead of a hole in the table.
    offsets = np.maximum.accumulate(offsets)
    if pos > 0xFFFFFFFF:
        raise SystemExit("prompts.bin past 4 GB — prompts.idx needs 64-bit offsets")
    offsets[n_posts] = pos
    with open(idx_path, "wb") as fh:
        fh.write(offsets.tobytes())
    return pos


def write_tags(con, path, off, length):
    """prompt-tags.csv.gz — every tag with its posting-list address.

    Not served: build_dict.py splits it into the blocked files the client
    range-requests, so this stays out of frontend/public."""
    rows = con.sql("SELECT tag, count, cat FROM tags ORDER BY tag_id").fetchall()
    with gzip.open(path, "wt", encoding="utf-8", newline="\n", compresslevel=9) as fh:
        fh.write("tag,count,cat,off,len\n")
        for i, (tag, count, cat) in enumerate(rows):
            if '"' in tag:
                tag = '"' + tag.replace('"', '""') + '"'
            fh.write(f"{tag},{count},{cat},{off[i]},{length[i]}\n")


def fav_bounds(con):
    """fav_count -> how many posts have at least that many, i.e. the prefix
    length the client truncates every posting list to."""
    rows = con.sql("""
        SELECT fav_count, sum(count(*)) OVER (ORDER BY fav_count DESC)
        FROM posts GROUP BY fav_count ORDER BY fav_count DESC
    """).fetchall()
    return [[int(f), int(n)] for f, n in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="frontend/public")
    ap.add_argument("--dict-src", default="data/prompt-tags.csv.gz",
                    help="tag table build_dict.py blocks up for the client")
    ap.add_argument("--memory", default="6GB")
    ap.add_argument("--source", default=REPO, help="parquet glob to read")
    ap.add_argument("--tmp", default="/tmp/prombot-duckdb",
                    help="spill directory; needs room for a few times the dump")
    ap.add_argument("--work", default="/tmp/prombot-build",
                    help="intermediate parquet stages, safe to delete after")
    args = ap.parse_args()

    global SOURCE
    SOURCE = args.source
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.work, exist_ok=True)
    started = time.time()
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{args.memory}'")
    con.execute(f"SET temp_directory='{args.tmp}'")
    con.execute("SET preserve_insertion_order=false")

    def step(msg):
        print(f"[{time.time() - started:6.0f}s] {msg}", flush=True)

    step("scanning dump")
    n_posts = build_posts(con, args.work)
    step(f"{n_posts:,} posts")

    n_tags = build_pairs(con, args.work)
    n_pairs = con.sql("SELECT count(*) FROM pairs").fetchone()[0]
    step(f"{n_tags:,} tags, {n_pairs:,} tag/post pairs")

    off, length, postings_bytes = write_postings(
        con, f"{args.out}/postings.bin", n_tags)
    step(f"postings.bin {postings_bytes / 1e6:.0f} MB")

    prompt_bytes = write_prompts(
        con, f"{args.out}/prompts.bin", f"{args.out}/prompts.idx", n_posts)
    step(f"prompts.bin {prompt_bytes / 1e6:.0f} MB")

    write_tags(con, args.dict_src, off, length)
    build_dict.build(args.out, args.dict_src)
    meta = {
        "version": 1,
        "posts": n_posts,
        "tags": n_tags,
        "maxFav": con.sql("SELECT max(fav_count) FROM posts").fetchone()[0],
        # descending fav -> prefix length; the client binary-searches this
        "favBounds": fav_bounds(con),
    }
    with open(f"{args.out}/prompts.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    step("done")


if __name__ == "__main__":
    main()
