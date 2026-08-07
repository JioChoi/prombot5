"""Pick the picture that best shows what each character looks like.

The canonical look already lives in data/characters.csv (series, features,
attire). This scans the Danbooru dump for that character's solo pictures and
keeps the one wearing the most of it:

    matched feature/attire tags + 1 if the series tag is on the post

Only `rating:general`, only `solo`, and the rest of the score is what makes a
picture a good reference: `official_art` (a promo image is drawn to show the
character, which is exactly the question being asked), the whole body, a plain
background, facing the viewer. Sketches, alternate outfits, back views and
chibi deformations lose points — chibi heavily, unless the character is
normally drawn that way, in which case it is what they look like.

The eligible posts are staged locally once (a minute, ~100 MB); after that a
pick is a local scan, so the whole cast ranks in one query. Pictures are saved
static, most-drawn character first: a thumbnail for the client in
character_dict/images and the full-size copy in character_dict/originals.
Anyone left without a picture is named in character_dict/noimage.txt.

    python pick_picture.py nukumizu_kaju            # rank, print, download
    python pick_picture.py --all                    # every character
    python pick_picture.py --all --limit 500        # the 500 biggest
"""

import argparse
import concurrent.futures as futures
import csv
import io
import os
import threading
import time

import duckdb
import requests
from PIL import Image

REPO = "hf://datasets/nick007x/Danbooru-2026-parquet-metadata/*.parquet"
CHARS = "data/characters.csv"
OUT = "character_dict/images"
FULL = "character_dict/originals"
NOIMAGE = "character_dict/noimage.txt"
MANIFEST = "character_dict/picks.csv"
STAGE = os.path.expanduser("~/.cache/prombot-build/candidates.parquet")


def stage(con, path):
    """The eligible posts, once, so a pick is a local scan and not a download.

    Everything the ranking can never choose is dropped here — other ratings,
    anything but a lone character, deleted posts — which is most of the dump.
    Sorted by character so a lookup only touches the row groups holding that
    name.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    started = time.time()
    print(f"staging {path} (once, a minute or two)", flush=True)
    con.execute(f"""
        COPY (
            SELECT tag_string_character AS character, id, fav_count,
                   -- the sample: a couple hundred KB instead of a few MB,
                   -- plenty for a reference picture
                   coalesce(large_file_url, file_url) AS file_url,
                   str_split(tag_string_general, ' ') AS tags,
                   str_split(tag_string_copyright, ' ') AS series
            FROM read_parquet('{REPO}')
            WHERE rating = 'g' AND tag_count_character = 1
              AND NOT is_deleted AND NOT is_banned AND file_url IS NOT NULL
              AND contains(tag_string_general, 'solo')
              -- danbooru carries video and flash too; those are not pictures
              AND file_ext IN ('jpg', 'jpeg', 'png', 'gif', 'webp')
            ORDER BY tag_string_character
        ) TO '{path}' (FORMAT parquet, COMPRESSION zstd)
    """)
    print(f"staged in {time.time() - started:.0f}s "
          f"({os.path.getsize(path) / 1e6:.0f} MB)")


def rank(con, stage_path, chars_path, only, limit, top):
    """The top `top` posts per character, best first.

    One query for the whole cast: ranking each character separately would
    re-read the staged file once per name.
    """
    where = f"WHERE character = '{only}'" if only else ""
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE want AS
        SELECT character, series, posts,
               list_filter(str_split(features || ' ' || attire, ' '),
                           t -> t <> '') AS tags
        FROM read_csv('{chars_path}')
        {where}
        ORDER BY posts DESC
        {f'LIMIT {limit}' if limit else ''}
    """)
    return con.execute(f"""
        WITH posts AS (
            SELECT * FROM read_parquet('{stage_path}')
            WHERE character IN (SELECT character FROM want)
        ), chibi AS (
            -- a chibi drawing is a caricature, not what the character looks
            -- like — unless chibi is what the character *is*, which is what
            -- drawing them that way most of the time means
            SELECT character, avg(list_contains(tags, 'chibi')::INT) AS share
            FROM posts GROUP BY character
        ), scored AS (
            SELECT w.character, w.posts, p.id, p.file_url, p.fav_count,
                   len(list_intersect(p.tags, w.tags)) AS matched,
                   len(w.tags) AS wanted,
                   list_contains(p.tags, 'official_art') AS official,
                   list_contains(p.series, w.series) AS in_series,
                   -- what a good reference picture looks like: the whole
                   -- character, facing you, nothing else going on
                   matched + in_series::INT
                   + 4 * official::INT
                   -- last resort only: a character drawn chibi nine times out
                   -- of ten has no other picture to offer
                   - 100 * (list_contains(p.tags, 'chibi')
                            AND c.share < 0.5)::INT
                   + 2 * list_has_any(p.tags, ['character_sheet',
                         'reference_sheet', 'turnaround'])::INT
                   + 2 * list_contains(p.tags, 'full_body')::INT
                   + list_has_any(p.tags, ['simple_background',
                         'white_background', 'transparent_background'])::INT
                   + list_contains(p.tags, 'standing')::INT
                   + list_contains(p.tags, 'looking_at_viewer')::INT
                   - 2 * list_has_any(p.tags, ['from_behind', 'from_side',
                         'close-up', 'portrait', 'cropped_torso',
                         'out_of_frame'])::INT
                   - 3 * list_has_any(p.tags, ['monochrome', 'greyscale',
                         'sketch', 'lineart', 'silhouette'])::INT
                   - 3 * list_has_any(p.tags, ['alternate_costume',
                         'alternate_hairstyle'])::INT
                   - 3 * len(list_filter(p.tags,
                         t -> suffix(t, '_(cosplay)')))::INT AS score
            FROM want w
            JOIN posts p USING (character)
            JOIN chibi c USING (character)
        )
        SELECT * FROM (
            SELECT *, row_number() OVER (
                PARTITION BY character
                ORDER BY score DESC, fav_count DESC) AS place
            FROM scored
        ) WHERE place <= {top}
        ORDER BY posts DESC, place
    """).fetchall()


def missing(con, ranked):
    """Characters with no eligible post at all — nothing solo, nothing rated
    general — so nothing to download."""
    names = set(r[0] for r in ranked)
    return [c for (c,) in con.sql("SELECT character FROM want "
                                  "ORDER BY posts DESC").fetchall()
            if c not in names]


local = threading.local()


THUMB = (448, 672)  # a two-column phone grid at 2x, and no bigger


def save_webp(body, thumb_out, full_out):
    """The picture, twice: what the client shows and what it came from.

    Danbooru serves gif and png too; the client only wants one format, and an
    animation's first frame is the picture it advertises. The full-size copy is
    kept because a thumbnail can't be un-shrunk — redoing the client's sizing
    later should not mean re-downloading 14,000 pictures.

    `method=6` is the slow encoder — a few ms per picture buys ~15% off the
    file, which is free on a run that spends its time waiting on the network.
    """
    with Image.open(io.BytesIO(body)) as im:
        im.seek(0)  # frame 0 of an animation, a no-op for a still
        im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        im.save(full_out, "WEBP", quality=80)
        im.thumbnail(THUMB, Image.LANCZOS)
        im.save(thumb_out, "WEBP", quality=75, method=6)


def fetch(url, out, full_out):
    """Download `url` and write it to `out` (and `full_out`) as webp.

    One keep-alive session per worker: the CDN resets connections once they
    arrive too fast, and a fresh TLS handshake per picture is what tips it over
    — reusing the connection is worth ~15x here. It still resets occasionally,
    hence the backoff.
    """
    for attempt in range(4):
        session = getattr(local, "session", None)
        if session is None:
            session = local.session = requests.Session()
            session.headers["User-Agent"] = "prombot"
        try:
            r = session.get(url, timeout=60)
            r.raise_for_status()
            save_webp(r.content, out, full_out)
            return os.path.getsize(out)
        except Exception:
            if attempt == 3:
                raise
            local.session = None  # a reset connection stays poisoned
            time.sleep(3 * (attempt + 1))


def path_for(outdir, character):
    # a handful of names carry a slash, e.g. lancelot_(fate/zero)
    return os.path.join(outdir, character.replace("/", "_") + ".webp")


def read_picks(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return {r["character"]: r["id"] for r in csv.DictReader(fh)}


def download(picks, outdir, fulldir, workers, absent, log, manifest):
    """One webp per character, refetching only what the ranking changed.

    `manifest` records which post each picture came from, so a rerun after the
    scoring moves picks up the handful that now point somewhere else instead of
    either re-downloading everything or keeping a stale file forever.

    Characters that end up with no usable file — no eligible post, a dead link,
    something Pillow can't read — are named in `log` instead of stopping the
    run, so a rerun can go looking for them.
    """
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(fulldir, exist_ok=True)
    was = read_picks(manifest)
    todo = [(c, url, path_for(outdir, c), path_for(fulldir, c))
            for c, pid, url in picks
            if was.get(c) != str(pid)
            or not os.path.exists(path_for(outdir, c))
            or not os.path.exists(path_for(fulldir, c))]
    print(f"{len(todo)} to fetch, {len(picks) - len(todo)} already right",
          flush=True)

    done, failed = 0, []
    with futures.ThreadPoolExecutor(workers) as pool:
        # submitted in order, so the most drawn characters land first
        jobs = {pool.submit(fetch, url, out, full): char
                for char, url, out, full in todo}
        for job in futures.as_completed(jobs):
            try:
                job.result()
                done += 1
            except Exception as e:  # one dead post shouldn't stop the run
                failed.append(jobs[job])
                print(f"  {jobs[job]}: {e}")
            if (done + len(failed)) % 100 == 0:
                print(f"  {done + len(failed)}/{len(todo)}", flush=True)

    with open(manifest, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["character", "id"])
        w.writerows((c, pid) for c, pid, _ in picks
                    if os.path.exists(path_for(outdir, c)))
    failed += list(absent)

    # the log is the standing list, not this run's: names carry over, and one
    # that finally got a picture drops off
    if os.path.exists(log):
        with open(log, encoding="utf-8") as fh:
            failed = [c for c in fh.read().split() if c not in failed] + failed
    with open(log, "w", encoding="utf-8") as fh:
        fh.writelines(f"{c}\n" for c in failed
                      if not os.path.exists(path_for(outdir, c)))
    print(f"{done} saved, {len(failed)} without a picture -> {outdir}, {log}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("character", nargs="?")
    ap.add_argument("--all", action="store_true", help="every character")
    ap.add_argument("--limit", type=int, help="only the N most drawn")
    ap.add_argument("--top", type=int, default=1,
                    help="runners-up to print (only the winner is saved)")
    ap.add_argument("--chars", default=CHARS)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--full", default=FULL, help="full-size copies")
    ap.add_argument("--log", default=NOIMAGE, help="characters left without one")
    ap.add_argument("--manifest", default=MANIFEST, help="which post each came from")
    ap.add_argument("--no-save", action="store_true", help="rank only")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--stage", default=STAGE, help="cached eligible posts")
    ap.add_argument("--restage", action="store_true", help="rebuild the cache")
    args = ap.parse_args()
    if not args.character and not args.all:
        ap.error("name a character, or --all")

    con = duckdb.connect()
    con.execute("SET preserve_insertion_order=false")
    if args.restage or not os.path.exists(args.stage):
        stage(con, args.stage)

    started = time.time()
    rows = rank(con, args.stage, args.chars, args.character, args.limit,
                args.top)
    if not rows:
        raise SystemExit("no solo rating:general posts")
    print(f"ranked {len(set(r[0] for r in rows))} characters "
          f"in {time.time() - started:.1f}s")

    if args.character or args.top > 1:
        for char, _, pid, url, favs, matched, wanted, official, in_series, \
                score, place in rows:
            flags = " ".join(f for f, on in (("official_art", official),
                                             ("series", in_series)) if on)
            print(f"{'*' if place == 1 else ' '} {char:<28} {pid:>9}  "
                  f"score {score:>3}  {matched}/{wanted} tags  {favs:>5} favs"
                  f"  {flags}\n    {url}")

    if not args.no_save:
        download([(r[0], r[2], r[3]) for r in rows if r[-1] == 1], args.out,
                 args.full, args.workers, missing(con, rows), args.log,
                 args.manifest)


if __name__ == "__main__":
    main()
