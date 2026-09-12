"""Rebuild frontend/public/tag-groups.csv.gz from the LLM-classified tag lists
in working/tags/, replacing the wiki-crawl subsets build_subset.py produced.

    python build_groups.py

The frontend only cuts on group names, so the categories are renamed to the
ones promptIndex.js already knows. nsfw has no LLM category and still comes
from data/nsfw.csv; requiring.txt (a tag that needs a garment already worn) is
the clothes_action group.
"""

import csv
import gzip
import json
import os

TAGS = "working/tags"
OUT = "frontend/public/tag-groups.csv.gz"
# what each requiring tag needs worn; read by frontend/src/lib/requiring.js
REQ_OUT = "frontend/public/tag-requires.csv.gz"

# working/tags/<file>.csv -> the group name the frontend uses. Files not
# listed (artist, character, series, other, tags) are danbooru categories the
# post record already carries, or unclassified.
GROUP_OF = {
    "attire": "attire",
    "feature": "feature",
    "expression": "expression",
    "action": "action",
    "object": "object",
    "setting": "scene",
    "meta": "meta",
    "style": "style",
    "meme": "style",
    "count": "composition",
}


def read_tags(path):
    with open(path, encoding="utf-8") as fh:
        return [r[0] for r in csv.reader(fh) if r and r[0] != "tag"]


def main():
    labels = {}

    def label(tag, group):
        gs = labels.setdefault(tag, [])
        if group not in gs:
            gs.append(group)

    for name, group in sorted(GROUP_OF.items()):
        path = f"{TAGS}/{name}.csv"
        if not os.path.exists(path):
            print(f"  !! missing {path}")
            continue
        tags = read_tags(path)
        for t in tags:
            label(t, group)
        print(f"{len(tags):>6} {name}.csv -> {group}")

    with open("data/nsfw.csv", encoding="utf-8") as fh:
        nsfw = [r["tag"] for r in csv.DictReader(fh)]
    for t in nsfw:
        label(t, "nsfw")
    print(f"{len(nsfw):>6} data/nsfw.csv -> nsfw")

    # these were pulled out of their category file, so they carry both labels
    with open(f"{TAGS}/requiring.txt", encoding="utf-8") as fh:
        req = [json.loads(l) for l in fh if l.strip()]
    for d in req:
        label(d["tag"], "clothes_action")
        if d["category"] in GROUP_OF:
            label(d["tag"], GROUP_OF[d["category"]])
    print(f"{len(req):>6} requiring.txt -> clothes_action")

    with gzip.open(REQ_OUT, "wt", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "requires"])
        w.writerows((d["tag"], " ".join(d["required_attires"])) for d in req)
    print(f"{len(req)} requirements -> {REQ_OUT}")

    with gzip.open(OUT, "wt", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "groups"])
        # space-separated: danbooru tags never contain a space
        w.writerows((t, " ".join(g)) for t, g in labels.items())
    print(f"{len(labels)} tags labelled -> {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
