"""Second pass for the characters pick_picture.py left in noimage.txt.

They failed the first pass because staging also demanded `tag_count_character
= 1`, and that is the rule that actually excluded them: only 292 of the 5127
have a solo post with exactly one character tag, but 3801 have a solo post.
A picture of one character routinely carries a second character tag — a
costume or version alias (`x_(swimsuit)`, `x_(cosplay)`) names the same person
twice — and the count rule threw all of those away.

So `solo` still holds here; the character count does not. The pick is then
simply the most favourited of those posts: no official-art bonus, no full-body
scoring, the question is whether a picture exists rather than whether it is
the best possible reference.

Written to character_dict/images_missing and originals_missing, kept apart from
the first pass's directories so picks.csv and noimage.txt stay the record of
what the strict ranking found.

    python pick_missing.py                  # every name in noimage.txt
    python pick_missing.py --limit 50       # a quick look
"""

import argparse
import concurrent.futures as futures
import csv
import os
import time

import duckdb

from pick_picture import REPO, fetch, path_for

NOIMAGE = "character_dict/noimage.txt"
OUT = "character_dict/images_missing"
FULL = "character_dict/originals_missing"
MANIFEST = "character_dict/picks_missing.csv"
STILL = "character_dict/noimage_still.txt"
STAGE = os.path.expanduser("~/.cache/prombot-build/missing.parquet")


def stage(con, names, path, stage_path):
    """One pass over the dump, keeping the best rating:general post per name.

    Aggregated inside the query rather than staged and ranked afterwards: one
    row per character is a few thousand rows, and the post pool behind them is
    most of the dump.
    """
    con.execute("CREATE OR REPLACE TEMP TABLE want (character VARCHAR)")
    con.executemany("INSERT INTO want VALUES (?)", [(n,) for n in names])
    os.makedirs(os.path.dirname(stage_path), exist_ok=True)
    started = time.time()
    print(f"scanning the dump for {len(names)} characters "
          f"(a minute or two)", flush=True)
    con.execute(f"""
        COPY (
            SELECT character,
                   arg_max(id, fav_count) AS id,
                   arg_max(url, fav_count) AS file_url,
                   max(fav_count) AS favs,
                   count(*) AS posts
            FROM (
                SELECT unnest(str_split(tag_string_character, ' ')) AS character,
                       id, fav_count,
                       coalesce(large_file_url, file_url) AS url
                FROM read_parquet('{REPO}')
                WHERE rating = 'g'
                  AND NOT is_deleted AND NOT is_banned AND file_url IS NOT NULL
                  AND file_ext IN ('jpg', 'jpeg', 'png', 'gif', 'webp')
                  -- the tag, not a substring of one: `contains` would take
                  -- solo_focus too, which is a crowd with a subject
                  AND list_contains(str_split(tag_string_general, ' '), 'solo')
            ) WHERE character IN (SELECT character FROM want)
            GROUP BY character
        ) TO '{stage_path}' (FORMAT parquet, COMPRESSION zstd)
    """)
    print(f"scanned in {time.time() - started:.0f}s")
    return con.sql(f"SELECT character, id, file_url, favs, posts "
                   f"FROM read_parquet('{stage_path}') "
                   f"ORDER BY posts DESC").fetchall()


def read_manifest(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return {r["character"]: r["id"] for r in csv.DictReader(fh)}


def prune(picks, outdir, fulldir):
    """Drop files for characters this run no longer places.

    Tightening the query is subtractive, and a webp left behind from a looser
    one is a picture nothing vouches for any more."""
    keep = {path_for(outdir, c) for c, _, _ in picks}
    keep |= {path_for(fulldir, c) for c, _, _ in picks}
    gone = [os.path.join(d, f) for d in (outdir, fulldir)
            if os.path.isdir(d) for f in os.listdir(d)
            if os.path.join(d, f) not in keep]
    for path in gone:
        os.remove(path)
    if gone:
        print(f"removed {len(gone)} file(s) no longer picked")


def download(picks, outdir, fulldir, workers, manifest):
    """Same fetch as the first pass, refetching only what the pick changed.

    Existence alone is not enough: tightening the query moves a character onto
    a different post, and the file already sitting there is the old pick. The
    manifest says which post each file came from, so only those get refetched.
    """
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(fulldir, exist_ok=True)
    was = read_manifest(manifest)
    todo = [(c, url, path_for(outdir, c), path_for(fulldir, c))
            for c, pid, url in picks
            if was.get(c) != str(pid)
            or not os.path.exists(path_for(outdir, c))
            or not os.path.exists(path_for(fulldir, c))]
    print(f"{len(todo)} to fetch, {len(picks) - len(todo)} already on disk",
          flush=True)

    done, failed = 0, []
    with futures.ThreadPoolExecutor(workers) as pool:
        jobs = {pool.submit(fetch, url, out, full): char
                for char, url, out, full in todo}
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
    ap.add_argument("--noimage", default=NOIMAGE)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--full", default=FULL)
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--still", default=STILL,
                    help="names this pass could not place either")
    ap.add_argument("--limit", type=int, help="only the first N names")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--stage", default=STAGE)
    ap.add_argument("--restage", action="store_true")
    ap.add_argument("--memory", default="6GB")
    ap.add_argument("--tmp", default=os.path.expanduser("~/.cache/prombot-duckdb"))
    args = ap.parse_args()

    with open(args.noimage, encoding="utf-8") as fh:
        names = fh.read().split()
    if args.limit:
        names = names[:args.limit]

    con = duckdb.connect()
    con.execute(f"SET memory_limit='{args.memory}'")
    os.makedirs(args.tmp, exist_ok=True)
    con.execute(f"SET temp_directory='{args.tmp}'")
    con.execute("SET preserve_insertion_order=false")

    if args.restage or not os.path.exists(args.stage):
        rows = stage(con, names, args.noimage, args.stage)
    else:
        rows = con.sql(f"SELECT character, id, file_url, favs, posts "
                       f"FROM read_parquet('{args.stage}') "
                       f"ORDER BY posts DESC").fetchall()
    print(f"{len(rows)} of {len(names)} have a rating:general post")

    picks = [(r[0], r[1], r[2]) for r in rows]
    prune(picks, args.out, args.full)
    done, failed = download(picks, args.out, args.full, args.workers,
                            args.manifest)

    with open(args.manifest, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["character", "id", "favs", "posts"])
        w.writerows((c, i, f, p) for c, i, _, f, p in rows
                    if os.path.exists(path_for(args.out, c)))

    placed = {r[0] for r in rows if os.path.exists(path_for(args.out, r[0]))}
    with open(args.still, "w", encoding="utf-8") as fh:
        fh.writelines(f"{n}\n" for n in names if n not in placed)
    print(f"{done} saved, {len(names) - len(placed)} still without a picture "
          f"-> {args.out}, {args.still}")


if __name__ == "__main__":
    main()
