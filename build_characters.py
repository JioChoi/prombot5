"""Build data/characters.csv — what a character canonically looks like.

For every character with enough posts, this records the series they belong to
and the handful of feature and attire tags that are *theirs*, so a prompt naming
the character can be filled in with the rest of the look.

The trap is that a character's tag list is mostly noise: Hatsune Miku is drawn
in a swimsuit often enough for `bikini` to out-count most things, and one
alternate-hairstyle set will happily contribute `short hair` to a character with
famously long hair. So a tag is only kept when it is *usual*:

    p(tag | character) >= --min-share       default 0.4

Two pictures in five is a low bar for a canonical trait and a high one for a
costume of the week: it keeps Sakuya's `maid_headdress` and Marisa's
`witch_hat`, and drops the swimsuit sets. Ranked by that share, capped at --top per group, and only
tags already in data/feature.csv / data/attire.csv are eligible — a statistical
filter over the whole tag space would rediscover `solo` and `looking at viewer`.

The series is the plain mode: the copyright tag appearing on most of the posts.

    python build_characters.py               # the whole dump, ~15 minutes
    python build_characters.py --parts 8     # a sample, for a quick look
"""

import argparse
import csv
import gzip
import os
import time

import duckdb

REPO = "hf://datasets/nick007x/Danbooru-2026-parquet-metadata/*.parquet"
GROUPS = {"feature": "data/feature.csv", "attire": "data/attire.csv"}
OUT = "data/characters.csv"
GZ = "frontend/public/characters.csv.gz"


def load_group(path):
    with open(path, encoding="utf-8") as fh:
        return [r["tag"] for r in csv.DictReader(fh)]


def build(con, args):
    """One pass over the dump; everything else is grouping."""
    src = args.source
    if args.parts:
        # the glob is ordered, so a prefix of it is a usable sample
        files = con.sql(f"SELECT file FROM glob('{src}') LIMIT {args.parts}") \
                   .fetchall()
        src = ", ".join(f"'{f[0]}'" for f in files)
        con.execute(f"CREATE VIEW posts AS SELECT * FROM read_parquet([{src}])")
    else:
        con.execute(f"CREATE VIEW posts AS SELECT * FROM read_parquet('{src}')")

    # Staged to disk so the three groupings below don't each re-read the dump
    # (and, over hf://, re-download it).
    os.makedirs(args.work, exist_ok=True)
    staged = f"{args.work}/chars.parquet"
    con.execute(f"""
        COPY (
            SELECT name, series, tags FROM (
                SELECT unnest(str_split(p.tag_string_character, ' ')) AS name,
                       p.tag_string_copyright AS series,
                       p.tag_string_general AS tags
                FROM posts p
                WHERE p.tag_string_character <> ''
            ) WHERE name <> ''
        ) TO '{staged}' (FORMAT parquet, COMPRESSION zstd)
    """)
    con.execute(f"CREATE VIEW chars AS SELECT * FROM read_parquet('{staged}')")

    con.execute(f"""
        CREATE TEMP TABLE totals AS
        SELECT name, count(*) AS posts FROM chars
        GROUP BY name HAVING count(*) >= {args.min_posts}
    """)
    n = con.sql("SELECT count(*) FROM totals").fetchone()[0]
    print(f"{n:,} characters with >= {args.min_posts} posts", flush=True)

    # The series is whichever copyright rides along most often.
    con.execute("""
        CREATE TEMP TABLE series AS
        SELECT name, series FROM (
            SELECT c.name, s.series, count(*) AS n,
                   row_number() OVER (PARTITION BY c.name ORDER BY count(*) DESC,
                                                                  s.series) AS rank
            FROM chars c
            JOIN totals t USING (name),
                 unnest(str_split(c.series, ' ')) AS s(series)
            WHERE s.series <> ''
            GROUP BY c.name, s.series
        ) WHERE rank = 1
    """)

    # Only tags that already belong to a group are eligible, and only tags the
    # character wears in most of their pictures.
    con.execute("CREATE TEMP TABLE groups (tag VARCHAR, grp VARCHAR)")
    con.executemany("INSERT INTO groups VALUES (?, ?)",
                    [(tag, grp) for grp, path in GROUPS.items()
                     for tag in load_group(path)])

    # (character, tag) once per appearance. Exploding and counting in one
    # statement holds the whole cross product in memory; streaming it to disk
    # first turns the count into an ordinary group-by that can spill.
    pairs = f"{args.work}/pairs.parquet"
    con.execute(f"""
        COPY (
            SELECT c.name, g.grp, g.tag
            FROM chars c
            JOIN totals t USING (name),
                 unnest(str_split(c.tags, ' ')) AS u(tag)
            JOIN groups g ON g.tag = u.tag
        ) TO '{pairs}' (FORMAT parquet, COMPRESSION zstd)
    """)
    con.execute(f"""
        CREATE TEMP TABLE counted AS
        SELECT name, grp, tag, count(*) AS n
        FROM read_parquet('{pairs}') GROUP BY name, grp, tag
    """)
    con.execute(f"""
        CREATE TEMP TABLE traits AS
        SELECT name, grp, tag, share FROM (
            SELECT c.name, c.grp, c.tag, c.n / t.posts::DOUBLE AS share,
                   row_number() OVER (PARTITION BY c.name, c.grp
                                      ORDER BY c.n DESC, c.tag) AS rank
            FROM counted c JOIN totals t USING (name)
            WHERE c.n / t.posts::DOUBLE >= {args.min_share}
        ) WHERE rank <= {args.top}
    """)


def write(con, out, gz):
    rows = con.sql("""
        SELECT t.name, t.posts,
               coalesce(any_value(s.series), '') AS series,
               string_agg(CASE WHEN r.grp = 'feature' THEN r.tag END, ' '
                          ORDER BY r.share DESC) AS features,
               string_agg(CASE WHEN r.grp = 'attire' THEN r.tag END, ' '
                          ORDER BY r.share DESC) AS attire
        FROM totals t
        LEFT JOIN series s USING (name)
        LEFT JOIN traits r USING (name)
        GROUP BY t.name, t.posts
        ORDER BY t.posts DESC
    """).fetchall()

    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["character", "posts", "series", "features", "attire"])
        w.writerows((n, p, s, f or "", a or "") for n, p, s, f, a in rows)

    # The count rides along last so the client can rank a character list by it;
    # last, because the reader splits from the right and a character name may
    # contain a comma.
    with gzip.open(gz, "wt", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["character", "series", "features", "attire", "posts"])
        w.writerows((n, s, f or "", a or "", p) for n, p, s, f, a in rows)

    print(f"{len(rows)} characters -> {out}, {gz} "
          f"({os.path.getsize(gz) / 1e3:.0f} KB)")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=REPO)
    ap.add_argument("--parts", type=int, default=0,
                    help="read only this many parquet parts (a sample)")
    ap.add_argument("--min-posts", type=int, default=100,
                    help="skip characters with fewer posts than this")
    ap.add_argument("--min-share", type=float, default=0.4,
                    help="a trait must appear on this fraction of their posts")
    ap.add_argument("--top", type=int, default=5,
                    help="most traits kept per group")
    ap.add_argument("--memory", default="6GB")
    ap.add_argument("--tmp", default=os.path.expanduser("~/.cache/prombot-duckdb"),
                    help="spill directory; /tmp is usually a small tmpfs")
    ap.add_argument("--work", default=os.path.expanduser("~/.cache/prombot-build"),
                    help="staged scan, safe to delete afterwards")
    args = ap.parse_args()

    started = time.time()
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{args.memory}'")
    os.makedirs(args.tmp, exist_ok=True)
    con.execute(f"SET temp_directory='{args.tmp}'")
    con.execute("SET max_temp_directory_size='200GiB'")
    con.execute("SET preserve_insertion_order=false")
    build(con, args)
    write(con, OUT, GZ)
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
