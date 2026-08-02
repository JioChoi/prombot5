"""Build a themed subset of data/tags.csv — data/attire.csv, data/feature.csv.

    python build_subset.py attire
    python build_subset.py feature

Reads the tags off a hand-picked set of Danbooru `tag_group:` wiki pages. The
wiki is the vocabulary; tags.csv is the validation — a wiki link no post ever
used is a dead link, an alias or a typo, and the join drops all three. Each
subset also gets data/<name>_include.txt / _exclude.txt for manual fixes and
data/not_<name>.csv listing what was left out.

Wiki text comes from a HuggingFace mirror of the wiki dump rather than
danbooru's API: same content, one file, no rate limit, and reachable from
networks that block donmai.us.
"""

import argparse
import csv
import gzip
import json
import os
import re

from huggingface_hub import hf_hub_download

REPO = "kierarkia/danbooru-wiki-2026"
DUMP = "danbooru_wiki_dataset_2026-04-28.jsonl"
GROUPS_OUT = "frontend/public/tag-groups.csv.gz"
# Seeds come from the sections of the [[tag_groups]] index. Following links
# instead of using a fixed list walks the whole tag_group graph (attire -> hair
# -> body parts -> ...), which drags `solo` and `blush` into everything.
# danbooru's clothing-state convention: `<garment>_lift`, `<garment>_pull`, ...
STATES = ("lift", "pull", "aside", "tug", "down", "up", "removed",
          "grab", "hold", "only", "set", "peek", "overhang", "tucked_in",
          "on_shoulders", "around_waist", "partially_removed")
SETS = {
    # "Attire and body accessories", minus makeup / fashion_style / nudity —
    # those describe a face or a lack of clothes. `jobs` rides along because a
    # job tag is a costume: `maid`, `nun`, `police`.
    "attire": {
        "seeds": ["attire", "accessories", "dress", "handwear", "headwear",
                  "legwear", "neck_and_neckwear", "sexual_attire", "bra",
                  "panties", "sleeves", "embellishment", "eyewear", "covering",
                  "jobs"],
        # `X_(cosplay)` is a costume tag whatever character X is
        "endswith": ("_(cosplay)",),
        "states": STATES,
    },
    # "Body", minus posture / gestures — a pose is not a feature. Makeup is out
    # too: it comes off. Hair and eyes carry most of the weight.
    "feature": {
        # no pussy/penis seeds: those pages are mostly sex acts. The organs
        # themselves come back via feature_include.txt.
        "seeds": ["body_parts", "hair", "hair_color", "hair_styles",
                  "eyes_tags", "ears_tags", "breasts_tags", "ass",
                  "legendary_creatures",
                  "hands", "feet", "shoulders", "tail", "wings", "skin_color",
                  "skin_folds"],
        # monster-girl species: `cat_girl`, `dragon_boy`, `slime_girl`
        "endswith": ("_girl", "_boy"),
        # the body-part pages link plenty of clothes; attire already has them
        "minus": ["attire", "expression"],
        # `mole` + a location is still a mole
        "states": ("under_eye", "under_mouth", "on_face", "on_cheek",
                   "across_eye", "on_breast", "on_thigh", "on_nose",
                   "on_arm", "on_leg", "on_stomach", "on_back"),
        # a body part doing something is a pose tag, not a trait
        "drop": ("looking_", "hand_on_", "hands_on_", "touching_", "blood_on_",
                 "outstretched_", "implied_", "covering_", "spread_"),
    },
    # An nsfw tag is usually also a feature or a garment — `crotchless_panties`
    # is attire too — so tag-groups.csv.gz carries every label a tag has, not
    # one. Switching a pill off drops a tag if *any* of its labels match.
    "nsfw": {
        "seeds": ["sex_acts", "simulated_sex_acts", "sexual_positions",
                  "sex_objects", "sexual_attire", "nudity", "pussy", "penis",
                  "bdsm_and_torture", "censorship"],
        # No sweep: `panties` appears on the nudity page, and one suffix pass
        # off it claims every colour of every garment. The sex-act pages list
        # their own compounds, so there is nothing to generalise from.
        "expand": False,
    },
    # everything on tag_group:face_tags is a face being pulled, not a face:
    # emotions, emotes, meme faces. `gestures` is the hand equivalent.
    "expression": {
        "seeds": ["face_tags", "gestures"],
        "minus": ["attire"],
    },
}
# [[tag]], [[tag|display]], [[tag#anchor]] — take the target only
LINK = re.compile(r"\[\[([^\]|#]+)")
# wiki namespaces that are prose, not tags
SKIP = ("category:", "howto:", "help:", "about:", "api:", "list_of")
# `holding_hat` is a pose tag that happens to name a garment, not a garment
ACTIONS = ("holding_", "removing_", "grabbing_", "adjusting_", "pulling_",
           "wearing_", "undressing_", "putting_on_", "taking_off_")
# `single_thighhigh` is one of a matched plural, `male_swimwear` a variant of it
MODIFIERS = ("single_", "multiple_", "male_", "female_")


def norm(link):
    return link.strip().lower().replace(" ", "_")


def load_wiki():
    """{title: body} for every tag_group page in the dump."""
    path = hf_hub_download(REPO, DUMP, repo_type="dataset")
    bodies = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            d = json.loads(line)
            title = norm(d["title"])
            if title.startswith("tag_group:") and not d["is_deleted"]:
                bodies[title] = d["body"]
    return bodies


def crawl(bodies, seeds):
    """Tag links on each seed page. Returns {page: [tag, ...]}."""
    pages = {}
    for seed in seeds:
        title = "tag_group:" + seed
        body = bodies.get(title)
        if body is None:  # renamed or deleted group, keep going
            print(f"  !! missing wiki page: {title}")
            pages[title] = []
            continue
        links = {norm(m) for m in LINK.findall(body)}
        pages[title] = sorted(l for l in links if l
                              and not l.startswith("tag_group:")
                              and not l.startswith(SKIP))
    return pages


def read_list(path):
    """One tag per line, # comments. Missing file means no entries."""
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        return {norm(l) for l in fh if l.strip() and not l.startswith("#")}


def load_tags(path):
    with open(path, encoding="utf-8") as fh:
        return [(r["tag"], int(r["count"]), int(r["cat"]))
                for r in csv.DictReader(fh)]


def expand(matched, tags, state_words):
    """The groups list `dress` and `hair_ornament` but not `red_dress` or
    `star_hair_ornament`. Sweep tags.csv for compounds built on a matched tag:
    `X_<tag>` for a variant, `<tag>_lift`/`_pull`/... for a state."""
    # ponytail: string shapes, not semantics — `_ring` drags in `onion_ring`.
    # Prune with data/attire_exclude.txt if the noise ever matters.
    suffixes = tuple("_" + t for t in matched)
    states = {t + "_" + s for t in matched for s in state_words or ()}

    def modified(tag):
        for m in MODIFIERS:
            base = tag.removeprefix(m)
            if base != tag and (base in matched or base + "s" in matched
                                or base.rstrip("s") in matched):
                return True
        return False

    return {t for t, _, cat in tags
            if cat == 0 and (t.endswith(suffixes) or t in states or
                             modified(t))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", choices=sorted(SETS))
    ap.add_argument("--tags", default="data/tags.csv")
    ap.add_argument("--out", help="default data/<name>.csv")
    ap.add_argument("--include", help="default data/<name>_include.txt")
    ap.add_argument("--exclude", help="default data/<name>_exclude.txt")
    ap.add_argument("--rest", help="general tags left out, for eyeballing what "
                                   "was missed; default data/not_<name>.csv")
    ap.add_argument("--no-expand", action="store_true")
    args = ap.parse_args()

    conf = SETS[args.name]
    args.out = args.out or f"data/{args.name}.csv"
    args.include = args.include or f"data/{args.name}_include.txt"
    args.exclude = args.exclude or f"data/{args.name}_exclude.txt"
    args.rest = args.rest or f"data/not_{args.name}.csv"

    pages = crawl(load_wiki(), conf["seeds"])
    wiki = {t for tags in pages.values() for t in tags}
    print(f"{len(pages)} wiki pages, {len(wiki)} tag links")

    tags = load_tags(args.tags)
    known = {t for t, _, cat in tags if cat == 0}
    keep = wiki & known
    print(f"{len(keep)} of {len(wiki)} exist as general tags")

    # not intersected with `known`: `headwear` is no tag of its own but is the
    # head of `black_headwear`, and the final join drops it again
    included = read_list(args.include)
    keep |= included

    if not args.no_expand and conf.get("expand", True):
        # `swimsuit` buys `one-piece_swimsuit`, which buys
        # `one-piece_swimsuit_pull`, so sweep until it stops growing
        before = len(keep)
        while True:
            grown = expand(keep, tags, conf.get("states")) - keep
            if not grown:
                break
            keep |= grown
        print(f"+{len(keep) - before} compounds from the sweep")

    if conf.get("endswith"):
        extra = {t for t, _, cat in tags
                 if cat == 0 and t.endswith(conf["endswith"])}
        print(f"+{len(extra - keep)} tags ending {'/'.join(conf['endswith'])}")
        keep |= extra

    drop = ACTIONS + conf.get("drop", ())
    keep = {t for t in keep if not t.startswith(drop)}

    dropped = read_list(args.exclude)
    print(f"-{len(dropped)} excluded")
    for other in conf.get("minus", ()):
        overlap = {r["tag"] for r in csv.DictReader(open(f"data/{other}.csv"))}
        dropped |= overlap
        print(f"-{len(keep & overlap)} already in {other}.csv")
    keep -= dropped

    if args.rest:
        with open(args.rest, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(["tag", "count"])
            w.writerows((t, c) for t, c, cat in tags
                        if cat == 0 and t not in keep)
        print(f"leftovers -> {args.rest}")

    rows = [r for r in tags if r[0] in keep]  # tags.csv is already count-desc
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "count", "cat"])
        w.writerows(rows)
    print(f"{len(rows)} tags -> {args.out}")
    write_groups()


def write_groups(out=GROUPS_OUT):
    """tag,group for every subset built so far, gzipped for the browser.

    The client needs to know which group a tag belongs to before it can drop
    it, and prompt-tags.csv.gz can't say — rebuilding that means rerunning
    build_index.py over the whole dump."""
    labels = {}
    for name in sorted(SETS):
        path = f"data/{name}.csv"
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                labels.setdefault(r["tag"], []).append(name)
    with gzip.open(out, "wt", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "groups"])
        # space-separated: danbooru tags never contain a space
        w.writerows((t, " ".join(g)) for t, g in labels.items())
    print(f"{len(labels)} tags labelled -> {out}")


def demo():
    body = ("* [[hat]]\n** [[straw hat]] (see [[tag group:headwear]])\n"
            "* [[shrug (clothing)|]]\n* [[howto:tagging]]\n"
            "* [[dress#anchor|frock]]\n")
    pages = crawl({"tag_group:attire": body,
                   "tag_group:headwear": "* [[beanie]]"},
                  ["attire", "headwear"])
    assert pages["tag_group:attire"] == ["dress", "hat", "shrug_(clothing)",
                                         "straw_hat"]
    assert pages["tag_group:headwear"] == ["beanie"]

    tags = [("dress", 9, 0), ("red_dress", 8, 0), ("hat", 7, 0),
            ("hatsune_miku", 6, 4), ("witch_hat", 5, 0), ("cake", 4, 0),
            ("hair_ornament", 3, 0), ("star_hair_ornament", 2, 0),
            ("dress_lift", 1, 0), ("dressing", 1, 0)]
    keep = {"dress", "hat", "hair_ornament"}
    assert expand(keep, tags, STATES) == {"red_dress", "witch_hat", "dress_lift",
                                        "star_hair_ornament"}
    assert "dress_lift" not in expand(keep, tags, ())
    print("ok")


if __name__ == "__main__":
    main()
