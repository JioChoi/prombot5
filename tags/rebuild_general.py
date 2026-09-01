"""Rebuild general.csv from tags.csv, minus every tag already filed elsewhere.

    python tags/rebuild_general.py

Source is tags.csv cat 0 (same as split_groups.py). Any tag claimed by
another csv here — themed files, groups.csv, false_positives.csv — is left
out. temp.csv is scratch, so it never excludes anything.
"""

import csv
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SKIP = {"tags.csv", "temp.csv", "general.csv"}


def claimed():
    tags = set()
    for f in sorted(os.listdir(HERE)):
        if f.endswith(".csv") and f not in SKIP:
            with open(os.path.join(HERE, f), encoding="utf-8") as fh:
                tags |= {r["tag"] for r in csv.DictReader(fh)}
    return tags


def main():
    taken = claimed()
    with open(os.path.join(HERE, "tags.csv"), encoding="utf-8") as fh:
        rows = [(r["tag"], int(r["count"])) for r in csv.DictReader(fh)
                if r["cat"] == "0" and r["tag"] not in taken]
    rows.sort(key=lambda r: -r[1])
    with open(os.path.join(HERE, "general.csv"), "w", newline="",
              encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["tag", "count"])
        w.writerows(rows)
    print(f"general.csv: {len(rows)} tags ({len(taken)} excluded)")


if __name__ == "__main__":
    main()
