"""Dev helper for sorting tags out of general.csv by hand.

    python tags/search.py

1. search — substring-match general.csv, hits go to tags/temp.csv. Prune
   temp.csv in another editor, then
2. put — pick a target csv; every tag still in temp.csv moves out of
   general.csv and into it, kept in count-desc order.
"""

import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMP = os.path.join(HERE, "temp.csv")
GENERAL = os.path.join(HERE, "general.csv")
# tags.csv is the source of everything; general.csv is where put takes from
NOT_TARGETS = {"tags.csv", "temp.csv", "general.csv"}
HEADER = ["tag", "count"]


def read(path):
    with open(path, encoding="utf-8") as fh:
        return [(r["tag"], int(r["count"])) for r in csv.DictReader(fh)]


def write(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(HEADER)
        w.writerows(rows)


def ask(prompt):
    try:
        return input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)


def search(q=None):
    rows = read(GENERAL)
    if q is None:
        q = ask(f"search {len(rows)} tags> ")
    q = q.lower()
    if not q:
        return
    hits = [r for r in rows if q in r[0]]
    write(TEMP, hits)
    print(f"{len(hits)} hits -> {TEMP}")


def put():
    if not os.path.exists(TEMP):
        print("no temp.csv — search first")
        return
    move = read(TEMP)
    if not move:
        print("temp.csv is empty")
        return
    files = sorted(f for f in os.listdir(HERE)
                   if f.endswith(".csv") and f not in NOT_TARGETS)
    for i, f in enumerate(files, 1):
        print(f"  {i}. {f}")
    pick = ask(f"put {len(move)} tags into> ")
    if not pick.isdigit() or not 1 <= int(pick) <= len(files):
        print("cancelled")
        return
    target = os.path.join(HERE, files[int(pick) - 1])

    names = {t for t, _ in move}
    general = read(GENERAL)
    kept = [r for r in general if r[0] not in names]
    missing = names - {t for t, _ in general}
    if missing:
        print(f"  !! {len(missing)} not in general.csv, skipped: "
              f"{', '.join(sorted(missing)[:5])}")
    moved = [r for r in general if r[0] in names]

    rows = read(target) + moved
    rows.sort(key=lambda r: -r[1])
    write(target, rows)
    write(GENERAL, kept)
    print(f"{len(moved)} tags -> {files[int(pick) - 1]} "
          f"({len(rows)} total), general.csv now {len(kept)}")


def main():
    if len(sys.argv) > 1:
        search(" ".join(sys.argv[1:]))
        return
    while True:
        choice = ask("\n1. search  2. put  (enter to quit)> ")
        if choice == "1":
            search()
        elif choice == "2":
            put()
        elif not choice:
            return


if __name__ == "__main__":
    main()
