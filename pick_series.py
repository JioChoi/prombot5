"""Pick one picture to stand for each series in data/characters.csv.

A series is best represented by its cast, so a group shot wins over a portrait
— but a twenty-character crowd sketch with four favourites is not a better
advertisement for a series than the official key art. So neither term is
allowed to win outright:

    score = --cover * min(characters / cast size, 1)
            + ln(1 + fav_count)
            - --crossover * (copyright tags - 1)

Coverage is a *fraction* of the cast rather than a count, because cast sizes
are nowhere near comparable: eight characters is the whole of most series and
a rounding error of pokemon's 1297. Where full coverage is impossible the term
flattens out and favourites decide, which is the right answer for those.

The log on favourites is what keeps the two terms in the same range — favours
are power-law distributed, so the raw count would swamp everything else.

The crossover penalty is there because a post tagged with four copyrights is
somebody's mashup, not a picture of any one of them.

Only `rating:general`, and only posts with at least one character tag.

    python pick_series.py                 # every series
    python pick_series.py --limit 50      # the 50 biggest, for a look
"""

import argparse
import concurrent.futures as futures
import csv
import os
import time

import duckdb

from pick_picture import REPO, fetch, path_for

CHARS = "data/characters.csv"
OUT = "character_dict/series_images"
FULL = "character_dict/series_originals"
MANIFEST = "character_dict/series_picks.csv"
NOIMAGE = "character_dict/series_noimage.txt"
STAGE = os.path.expanduser("~/.cache/prombot-build/series.parquet")


def cast_sizes(path):
    """(series, how many characters it has) from the built character table."""
    sizes = {}
    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["series"]:
                sizes[row["series"]] = sizes.get(row["series"], 0) + 1
    return sorted(sizes.items(), key=lambda kv: -kv[1])


def stage(con, sizes, stage_path, cover, crossover):
    """One pass over the dump, keeping the best-scoring post per series."""
    con.execute("CREATE OR REPLACE TEMP TABLE want (series VARCHAR, size INT)")
    con.executemany("INSERT INTO want VALUES (?, ?)", sizes)
    os.makedirs(os.path.dirname(stage_path), exist_ok=True)
    started = time.time()
    print(f"scanning the dump for {len(sizes)} series (a minute or two)",
          flush=True)
    con.execute(f"""
        COPY (
            SELECT series,
                   arg_max(id, score) AS id,
                   arg_max(url, score) AS file_url,
                   arg_max(favs, score) AS favs,
                   arg_max(chars, score) AS chars,
                   any_value(size) AS cast_size,
                   max(score) AS score,
                   count(*) AS posts
            FROM (
                SELECT s.series, w.size, p.id, p.fav_count AS favs,
                       p.tag_count_character AS chars,
                       coalesce(p.large_file_url, p.file_url) AS url,
                       {cover} * least(p.tag_count_character / w.size::DOUBLE,
                                       1.0)
                       + ln(1 + p.fav_count)
                       - {crossover} * (p.tag_count_copyright - 1) AS score
                FROM read_parquet('{REPO}') p,
                     unnest(str_split(p.tag_string_copyright, ' ')) AS s(series)
                JOIN want w ON w.series = s.series
                WHERE p.rating = 'g'
                  AND NOT p.is_deleted AND NOT p.is_banned
                  AND p.file_url IS NOT NULL
                  AND p.file_ext IN ('jpg', 'jpeg', 'png', 'gif', 'webp')
                  AND p.tag_count_character >= 1
            )
            GROUP BY series
        ) TO '{stage_path}' (FORMAT parquet, COMPRESSION zstd)
    """)
    print(f"scanned in {time.time() - started:.0f}s")


def read_picks(stage_path, con):
    return con.sql(f"""
        SELECT series, id, file_url, favs, chars, cast_size, posts
        FROM read_parquet('{stage_path}') ORDER BY posts DESC
    """).fetchall()


def read_manifest(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return {r["series"]: r["id"] for r in csv.DictReader(fh)}


def download(picks, outdir, fulldir, workers, manifest):
    """One webp per series, refetching only what the scoring moved."""
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(fulldir, exist_ok=True)
    was = read_manifest(manifest)
    todo = [(s, url, path_for(outdir, s), path_for(fulldir, s))
            for s, pid, url in picks
            if was.get(s) != str(pid)
            or not os.path.exists(path_for(outdir, s))
            or not os.path.exists(path_for(fulldir, s))]
    print(f"{len(todo)} to fetch, {len(picks) - len(todo)} already right",
          flush=True)

    done, failed = 0, []
    with futures.ThreadPoolExecutor(workers) as pool:
        jobs = {pool.submit(fetch, url, out, full): s
                for s, url, out, full in todo}
        for job in futures.as_completed(jobs):
            try:
                job.result()
                done += 1
            except Exception as e:  # a dead link shouldn't stop the run
                failed.append(jobs[job])
                print(f"  {jobs[job]}: {e}")
            if (done + len(failed)) % 100 == 0:
                print(f"  {done + len(failed)}/{len(todo)}", flush=True)
    return done, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chars", default=CHARS)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--full", default=FULL)
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--log", default=NOIMAGE)
    ap.add_argument("--cover", type=float, default=10.0,
                    help="weight on covering the whole cast")
    ap.add_argument("--crossover", type=float, default=0.5,
                    help="penalty per extra copyright tag")
    ap.add_argument("--limit", type=int, help="only the N biggest series")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--stage", default=STAGE)
    ap.add_argument("--restage", action="store_true")
    ap.add_argument("--memory", default="6GB")
    ap.add_argument("--tmp", default=os.path.expanduser("~/.cache/prombot-duckdb"))
    args = ap.parse_args()

    sizes = cast_sizes(args.chars)
    if args.limit:
        sizes = sizes[:args.limit]

    con = duckdb.connect()
    con.execute(f"SET memory_limit='{args.memory}'")
    os.makedirs(args.tmp, exist_ok=True)
    con.execute(f"SET temp_directory='{args.tmp}'")
    con.execute("SET preserve_insertion_order=false")

    if args.restage or not os.path.exists(args.stage):
        stage(con, sizes, args.stage, args.cover, args.crossover)
    rows = read_picks(args.stage, con)
    print(f"{len(rows)} of {len(sizes)} series have a rating:general post")

    done, failed = download([(r[0], r[1], r[2]) for r in rows],
                            args.out, args.full, args.workers, args.manifest)

    with open(args.manifest, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["series", "id", "favs", "chars", "cast", "posts"])
        w.writerows((s, i, f, c, cs, p) for s, i, _, f, c, cs, p in rows
                    if os.path.exists(path_for(args.out, s)))

    placed = {r[0] for r in rows if os.path.exists(path_for(args.out, r[0]))}
    with open(args.log, "w", encoding="utf-8") as fh:
        fh.writelines(f"{s}\n" for s, _ in sizes if s not in placed)
    print(f"{done} saved, {len(sizes) - len(placed)} without a picture "
          f"-> {args.out}, {args.log}")


if __name__ == "__main__":
    main()
