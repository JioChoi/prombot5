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
# subsets split out later live here; the four originals stay in data/
GROUPS = "data/groups"
# every general tag no subset claimed — the LLM's to-do list
UNGROUPED = "data/groups/ungrouped.csv"
# Seeds come from the sections of the [[tag_groups]] index. Following links
# instead of using a fixed list walks the whole tag_group graph (attire -> hair
# -> body parts -> ...), which drags `solo` and `blush` into everything.
# danbooru's clothing-state convention: `<garment>_lift`, `<garment>_pull`, ...
# `holding_hat` is a pose tag that happens to name a garment, not a garment
ACTIONS = ("holding_", "removing_", "grabbing_", "adjusting_", "pulling_",
           "wearing_", "undressing_", "putting_on_", "taking_off_")
STATES = ("lift", "pull", "aside", "tug", "down", "up", "removed",
          "grab", "hold", "only", "set", "peek", "overhang", "tucked_in",
          "on_shoulders", "around_waist", "partially_removed")
SETS = {
    # Worn but not clothing: jewelry, glasses, piercings, hair ornaments. Same
    # compound sweep as attire, so `hair_ornament` buys `star_hair_ornament`.
    "accessory": {
        "dir": GROUPS,
        "seeds": ["accessories", "eyewear", "glasses", "piercings",
                  "embellishment", "prints"],
        # the accessories page links every hat and glove too. Rule: if the wiki
        # files it under a *wear page, it is clothing and attire keeps it.
        "not_seeds": ["headwear", "handwear", "legwear", "covering",
                      "sleeves"],
        "states": STATES,
    },
    # "Attire and body accessories", minus makeup / fashion_style / nudity —
    # those describe a face or a lack of clothes. `jobs` rides along because a
    # job tag is a costume: `maid`, `nun`, `police`.
    "attire": {
        "dir": GROUPS,
        "seeds": ["attire", "dress", "handwear", "headwear",
                  "legwear", "neck_and_neckwear", "sexual_attire", "bra",
                  "panties", "sleeves", "covering", "jobs"],
        # accessory is built first and wins the tags both pages link
        "minus": ["accessory"],
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
    # ---- groups below live in data/groups/, one label each ----
    # A garment being moved is an action, not a garment: `skirt_lift`,
    # `adjusting_hat`. No wiki page lists these — the convention *is* the rule,
    # so it is built off attire.csv by suffix/prefix instead of a crawl.
    "clothes_action": {
        "dir": GROUPS,
        "from": ["attire", "accessory"],
        "states": STATES,
        "actions": ACTIONS,
    },
    # `posture` is how the body is held; `verbs_and_gerunds` is what it does.
    "pose": {
        "dir": GROUPS,
        "seeds": ["posture", "verbs_and_gerunds", "dances", "holding_tags"],
        "minus": ["attire", "clothes_action"],
        "expand": False,
    },
    # where the picture happens, indoors/outdoors/weather/scenery
    "scene": {
        "dir": GROUPS,
        "seeds": ["backgrounds", "locations", "real_world_locations",
                  "doors_and_gates", "water", "fire"],
        "minus": ["attire", "feature"],
        "expand": False,
    },
    # camera and canvas: angle, crop, focus, how many people are in frame
    "composition": {
        "dir": GROUPS,
        "seeds": ["image_composition", "focus_tags", "character_count",
                  "groups", "lighting"],
        "expand": False,
    },
    # how it was drawn, not what is drawn
    "style": {
        "dir": GROUPS,
        "seeds": ["visual_aesthetic", "artistic_license", "drawing_software",
                  "fine_art_parody", "theme", "meme"],
        "minus": ["attire", "feature"],
        "expand": False,
    },
    # props and scenery objects — held things land in pose too, that is fine
    "object": {
        "dir": GROUPS,
        "seeds": ["food_tags", "technology", "cards", "board_games", "flowers",
                  "birds", "cats", "dogs", "sports"],
        "minus": ["attire", "feature", "scene"],
        "expand": False,
    },
    # not a picture of anything: watermarks, years, translations, resolution
    "meta": {
        "dir": GROUPS,
        "seeds": ["metatags", "year_tags", "text", "language", "phrases",
                  "symbols", "audio_tags", "companies_and_brand_names"],
        "minus": ["attire", "feature", "expression"],
        "expand": False,
    },
}
# [[tag]], [[tag|display]], [[tag#anchor]] — take the target only
LINK = re.compile(r"\[\[([^\]|#]+)")
# wiki namespaces that are prose, not tags
SKIP = ("category:", "howto:", "help:", "about:", "api:", "list_of")
# `single_thighhigh` is one of a matched plural, `male_swimwear` a variant of it
MODIFIERS = ("single_", "multiple_", "male_", "female_")


def sdir(name):
    """Directory holding data/<name>.csv and its include/exclude lists."""
    return SETS[name].get("dir", "data")


def read_subset(name):
    import csv as _csv
    with open(f"{sdir(name)}/{name}.csv", encoding="utf-8") as fh:
        return {r["tag"] for r in _csv.DictReader(fh)}


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


def derive(conf, known):
    """Tags built from other subsets by the naming convention alone:
    `<garment>_lift` and `adjusting_<garment>`, off data/attire.csv."""
    base = set().union(*(read_subset(n) for n in conf["from"]))
    states = {t + "_" + s for t in base for s in conf.get("states", ())}
    actions = {a + t for t in base for a in conf.get("actions", ())}
    return known & (states | actions)


# `minus` reads another subset's csv, so the dependency order is fixed
ORDER = ["accessory", "attire", "feature", "expression", "nsfw", "clothes_action", "pose",
         "scene", "object", "composition", "style", "meta"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", choices=sorted(SETS) + ["all"])
    ap.add_argument("--tags", default="data/tags.csv")
    ap.add_argument("--out", help="default data/<name>.csv")
    ap.add_argument("--include", help="default data/<name>_include.txt")
    ap.add_argument("--exclude", help="default data/<name>_exclude.txt")
    ap.add_argument("--no-expand", action="store_true")
    args = ap.parse_args()

    if args.name == "all":
        for name in ORDER:
            print(f"== {name}")
            build(argparse.Namespace(**{**vars(args), "name": name}))
        return
    build(args)


def build(args):
    conf = SETS[args.name]
    d = sdir(args.name)
    os.makedirs(d, exist_ok=True)
    args.out = args.out or f"{d}/{args.name}.csv"
    args.include = args.include or f"{d}/{args.name}_include.txt"
    args.exclude = args.exclude or f"{d}/{args.name}_exclude.txt"

    tags = load_tags(args.tags)
    known = {t for t, _, cat in tags if cat == 0}

    if conf.get("from"):
        keep = derive(conf, known)
        print(f"{len(keep)} tags derived from {', '.join(conf['from'])}")
    else:
        pages = crawl(load_wiki(), conf["seeds"])
        wiki = {t for tags_ in pages.values() for t in tags_}
        print(f"{len(pages)} wiki pages, {len(wiki)} tag links")
        keep = wiki & known
        print(f"{len(keep)} of {len(wiki)} exist as general tags")

    # not intersected with `known`: `headwear` is no tag of its own but is the
    # head of `black_headwear`, and the final join drops it again
    included = read_list(args.include)
    keep |= included

    if conf.get("not_seeds"):
        clothes = {t for tags_ in crawl(load_wiki(), conf["not_seeds"]).values()
                   for t in tags_}
        print(f"-{len(keep & clothes)} filed under {'/'.join(conf['not_seeds'])}")
        keep -= clothes

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

    drop = conf.get("drop", ())
    if not conf.get("actions"):
        drop += ACTIONS
    keep = {t for t in keep if not t.startswith(drop)}

    dropped = read_list(args.exclude)
    print(f"-{len(dropped)} excluded")
    for other in conf.get("minus", ()):
        overlap = read_subset(other)
        dropped |= overlap
        print(f"-{len(keep & overlap)} already in {other}.csv")
    keep -= dropped

    rows = [r for r in tags if r[0] in keep]  # tags.csv is already count-desc
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "count", "cat"])
        w.writerows(rows)
    print(f"{len(rows)} tags -> {args.out}")
    write_groups(tags)


def write_groups(tags, out=GROUPS_OUT):
    """tag,group for every subset built so far, gzipped for the browser, plus
    data/groups/ungrouped.csv — the general tags no subset claimed.

    The client needs to know which group a tag belongs to before it can drop
    it, and prompt-tags.csv.gz can't say — rebuilding that means rerunning
    build_index.py over the whole dump."""
    labels = {}
    for name in sorted(SETS):
        path = f"{sdir(name)}/{name}.csv"
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

    with open(UNGROUPED, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "count"])
        rest = [(t, c) for t, c, cat in tags if cat == 0 and t not in labels]
        w.writerows(rest)
    print(f"{len(rest)} tags ungrouped -> {UNGROUPED}")


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
