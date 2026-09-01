"""Split the general (cat 0) tags of tags.csv into themed csvs using the danbooru tag_group wiki.

    python tags/split_groups.py

Membership comes from the wiki only: a tag leaves general.csv when a
tag_group page (or a named section of one) links it. No name patterns, no
suffix sweeps — a tag the wiki never mentions stays in general.csv.

Reuses load_wiki/crawl/LINK from build_subset.py.
"""

import csv
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from build_subset import LINK, SKIP, load_wiki, norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# Whole pages. First group in ORDER to claim a tag keeps it.
PAGES = {
    # how many people are in frame: 1girl, 4others, multiple_boys
    "count": ["character_count", "groups"],
    # what the subject is doing — verbs, poses, dances, and a garment being
    # moved or held (skirt_lift, covering_breasts)
    "action": ["verbs_and_gerunds", "posture", "dances", "holding_tags",
               "covering"],
    "nsfw": ["sex_acts", "simulated_sex_acts", "sexual_positions",
             "sex_objects", "sexual_attire", "pussy", "penis",
             "bdsm_and_torture", "censorship"],
    # face_tags is a face being pulled, not a face; gestures is the hand one
    "expression": ["face_tags", "gestures"],
    "attire": ["attire", "dress", "handwear", "headwear", "legwear",
               "neck_and_neckwear", "bra", "panties", "sleeves", "jobs",
               "accessories", "eyewear", "glasses", "piercings",
               "embellishment", "prints", "fashion_style"],
    # things in the picture rather than on the body
    "object": ["food_tags", "technology", "cards", "board_games", "flowers",
               "birds", "cats", "dogs", "sports", "symbols", "water", "fire",
               "doors_and_gates"],
    "feature": ["body_parts", "hair", "hair_color", "hair_styles", "eyes_tags",
                "ears_tags", "breasts_tags", "breasts", "ass", "hands", "feet",
                "shoulders", "tail", "wings", "skin_color", "skin_folds"],
}

# tag_group:nudity mixes clothing states with bare skin, so it is split by
# section anchor instead of taken whole.
NUDITY = "tag_group:nudity"
NUDITY_SECTIONS = {
    # the exposure sections are all "garment moved out of the way" lists
    "action": ["any", "misc", "chest", "breasts", "legs", "ass",
               "exceptions", "touching", "cover"],
    "nsfw": ["complete", "gender", "partial", "nipples", "torso",
             "breastsparts", "shoulders", "head", "points", "miscmore"],
}

ORDER = ["count", "expression", "attire", "feature", "action", "nsfw", "object"]
SECTION = re.compile(r"^h[1-6]#?(\S*)\.\s*(.*)$", re.M)


def links(body):
    """Tag links in a chunk of wiki text."""
    return {n for n in (norm(m) for m in LINK.findall(body))
            if n and not n.startswith("tag_group:") and not n.startswith(SKIP)}


def sections(body):
    """{anchor: section body} for a page written with h4#anchor. headers."""
    parts = SECTION.split(body)
    it = iter(parts[1:])
    return {a: b for a, _t, b in zip(it, it, it)}


def collect(bodies):
    """{group: {tag, ...}} straight off the wiki, before precedence."""
    out = {}
    for group, seeds in PAGES.items():
        got = set()
        for seed in seeds:
            body = bodies.get("tag_group:" + seed)
            if body is None:
                print(f"  !! missing wiki page: tag_group:{seed}")
                continue
            got |= links(body)
        out[group] = got
    secs = sections(bodies[NUDITY])
    for group, anchors in NUDITY_SECTIONS.items():
        for a in anchors:
            if a not in secs:
                print(f"  !! missing {NUDITY} section: {a}")
            out.setdefault(group, set()).update(links(secs.get(a, "")))
    return out


def existing():
    """{tag: file} for every tag already filed in a csv here.

    Hand edits win: a rerun never moves a tag that some csv already claims,
    so search.py's puts survive."""
    claimed = {}
    for f in sorted(os.listdir(HERE)):
        if not f.endswith(".csv") or f in ("tags.csv", "temp.csv",
                                           "general.csv"):
            continue
        with open(os.path.join(HERE, f), encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                claimed.setdefault(r["tag"], f)
    return claimed


def main():
    # tags.csv, not general.csv: general.csv is an output, so reading it
    # would make a second run split what the first run already split
    src = os.path.join(HERE, "tags.csv")
    with open(src, encoding="utf-8") as fh:
        rows = [(r["tag"], r["count"]) for r in csv.DictReader(fh)
                if r["cat"] == "0"]
    known = {t for t, _ in rows}

    claimed = existing()
    found = collect(load_wiki())
    taken, assigned = set(claimed), {}
    for group in ORDER:
        mine = {t for t, f in claimed.items() if f == group + ".csv"}
        new = (found[group] & known) - taken
        taken |= new
        assigned[group] = mine | new
        print(f"{group}: {len(mine)} kept, +{len(new)} new "
              f"({len(found[group])} wiki links)")

    for group in ORDER:
        write(f"{group}.csv", [r for r in rows if r[0] in assigned[group]])
    write("general.csv", [r for r in rows if r[0] not in taken])


def write(name, rows):
    with open(os.path.join(HERE, name), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "count"])
        w.writerows(rows)
    print(f"{len(rows)} tags -> tags/{name}")


def demo():
    body = ("h4#one. One\n* [[skirt lift]]\n* [[tag group:attire]]\n"
            "h4#two. Two\n* [[nude]]\n* [[howto:tagging]]\n")
    assert sections(body).keys() == {"one", "two"}
    assert links(sections(body)["one"]) == {"skirt_lift"}
    assert links(sections(body)["two"]) == {"nude"}
    print("ok")


if __name__ == "__main__":
    demo() if "--demo" in sys.argv else main()
