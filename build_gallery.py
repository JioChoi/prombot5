"""A bare page of whatever a pick script chose, to eyeball it.

Driven by the manifest rather than the image directory, so every tile can name
the post it came from — a wrong picture is only obvious next to the name it is
supposed to be and a link back to danbooru.

The manifest shape is a convention, not a schema: first column is the name,
`id` is the post, and every remaining column is printed in the caption. That
covers both pick scripts without either of them having to agree on anything
else.

    python build_gallery.py                    # the no-image characters
    python build_gallery.py --kind series      # the series picks
"""

import argparse
import csv
import html
import os

# (manifest, image dir relative to the html, output, what a row is)
KINDS = {
    "missing": ("character_dict/picks_missing.csv", "images_missing",
                "character_dict/check_missing.html",
                "characters that had no picture"),
    "series": ("character_dict/series_picks.csv", "series_images",
               "character_dict/check_series.html", "series"),
}

PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s</title>
<style>
body {font: 14px system-ui, sans-serif; margin: 12px; background: #111; color: #eee}
h1 {font-size: 1.2rem}
/* 140px is two columns on a 360px phone and keeps filling out on a desktop */
.grid {display: grid; gap: 10px;
       grid-template-columns: repeat(auto-fill, minmax(140px, 1fr))}
figure {margin: 0}
/* the tile is the thumbnail's own 2:3, so the row height follows the column */
img {width: 100%%; aspect-ratio: 2 / 3; object-fit: contain; background: #000;
     display: block}
figcaption {font-size: 12px; overflow-wrap: anywhere; padding-top: 4px}
.m {color: #aaa}
a {color: #8bf}
</style>
<h1>%(title)s</h1>
<p>%(note)s</p>
<div class=grid>
%(tiles)s
</div>
"""

TILE = """<figure>
  <img loading=lazy src="%(src)s" alt="%(name)s">
  <figcaption>%(name)s<br><a href="https://danbooru.donmai.us/posts/%(id)s"
    target=_blank>#%(id)s</a><span class=m> · %(rest)s</span></figcaption>
</figure>"""


def build(manifest, images, out, title, note, sort_by):
    with open(manifest, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
        cols = list(rows[0]) if rows else []
    name_col = cols[0]
    # biggest first: if anything is wrong, it is worth seeing at the top
    if sort_by in cols:
        rows.sort(key=lambda r: -int(r[sort_by]))

    rest = [c for c in cols[1:] if c != "id"]
    tiles = "\n".join(TILE % {
        "src": f"{images}/{html.escape(r[name_col].replace('/', '_'))}.webp",
        "name": html.escape(r[name_col]),
        "id": r["id"],
        "rest": " · ".join(f"{r[c]} {c}" for c in rest),
    } for r in rows)

    with open(out, "w", encoding="utf-8") as fh:
        fh.write(PAGE % {"title": title % len(rows), "note": note,
                         "tiles": tiles})
    print(f"{len(rows)} tiles -> {out} ({os.path.getsize(out) / 1e3:.0f} KB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=KINDS, default="missing")
    ap.add_argument("--manifest")
    ap.add_argument("--images")
    ap.add_argument("--out")
    ap.add_argument("--sort", default="posts",
                    help="manifest column to order by, descending")
    args = ap.parse_args()

    manifest, images, out, what = KINDS[args.kind]
    manifest = args.manifest or manifest
    images = args.images or images
    out = args.out or out

    note = {
        "missing": "rating:general and solo, the most favourited such post. "
                   "Not necessarily portrait or official art.",
        "series": "rating:general, scored on how much of the cast is in the "
                  "picture against how many favourites it has.",
    }[args.kind]
    build(manifest, images, out, f"%d {what}", note, args.sort)


if __name__ == "__main__":
    main()
