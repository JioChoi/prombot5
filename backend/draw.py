"""Random prompt drawing, server side.

The browser used to do this itself: 1.1 GB of index on Hugging Face, read a few
hundred KB at a time over ranged requests. That works, but every session pays
the latency and re-downloads the same posting lists. Here the same files sit on
local disk and are mmapped, so a draw is a handful of page-cache reads.

The index is exactly what build_index.py writes — nothing is modified, only
read:

  tag-dict.csv.gz  tag,count,off,len,cat,id — off/len address postings.bin
  postings.bin     per tag: post numbers, ascending, delta + LEB128 varint
  prompts.bin      per post: varint fav, varint danbooru id, varint tag count,
                   then its tag ids, ascending, delta + varint
  prompts.idx      uint32 LE, N+1 entries: byte offset of each record
  prompts.json     row count and the fav_count -> prefix-length table

Posts are ranked by favourites, so a score floor is a prefix of every list and
needs no per-post lookup.

Memory: the dictionary (~110k tags) is held, the three big files are not — they
are mapped, so their pages are file-backed and the OS evicts them under
pressure. Steady state is tens of MB of anonymous memory whatever the corpus
size.
"""

import gzip
import json
import mmap
import os
import random
import struct
from array import array

# Where the index lives. The repo copy is frontend/public; a deployment points
# this at wherever the files were put.
INDEX_DIR = os.environ.get("INDEX_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "public"
)

# A posting list this long is decoded and drawn from directly; anything longer
# is common enough that testing random posts finds a match sooner than decoding
# would. Decoding runs at ~4M/s, so this is a quarter-second ceiling — kept
# generous on purpose: walking the list proves an empty query empty, while
# sampling can only run out of budget and call it empty, which is how a thin
# query gets wrongly reported as matching nothing.
LIST_MAX = 1_000_000
# Records a draw may read before it gives up and calls the query empty. A query
# matching one post in 10⁵ is past what sampling can answer.
BUDGET = 60_000
# Postings a count may decode before it estimates instead. Decoding runs at
# ~4M/s, so this is a quarter-second ceiling on the exact path.
COUNT_MAX = 1_000_000
# Records a count may test one by one, which is what makes an exact answer
# possible for a query built on a tag this rare or rarer.
EXACT_RECORDS = 60_000
# Records a count samples when it cannot be exact. A hundredth of a percent of
# the corpus, which is a few percent of error on anything worth showing.
SAMPLE = 8192


class Index:
    """The four files, mapped. One instance per process; see `index()`."""

    def __init__(self, path=INDEX_DIR):
        meta = json.load(open(os.path.join(path, "prompts.json")))
        self.posts = meta["posts"]
        # [score, postsWithAtLeastThatMany], score descending
        self.bounds = meta["favBounds"]

        # tag -> (off, len, count, id); id -> (tag, cat). Two views of one row.
        self.tags = {}
        self.names = []
        with gzip.open(os.path.join(path, "tag-dict.csv.gz"), "rt", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                # read from the right: a tag name may contain commas
                f = line.rstrip("\n").split(",")
                tag = ",".join(f[:-5])
                count, off, length, cat, tid = (int(x) for x in f[-5:])
                self.tags[tag] = (off, length, count, tid)
                if tid >= len(self.names):
                    self.names.extend([None] * (tid + 1 - len(self.names)))
                self.names[tid] = (tag, cat)

        self.postings = _map(os.path.join(path, "postings.bin"))
        self.records = _map(os.path.join(path, "prompts.bin"))
        self.offsets = _map(os.path.join(path, "prompts.idx"))

    def bound(self, min_score):
        """Posts at or above `min_score`, i.e. the usable prefix length."""
        if min_score <= 0:
            return self.posts
        lo, hi = 0, len(self.bounds)
        while lo < hi:
            mid = (lo + hi) // 2
            if self.bounds[mid][0] >= min_score:
                lo = mid + 1
            else:
                hi = mid
        return self.bounds[lo - 1][1] if lo else 0

    def record(self, post):
        """(danbooru id, fav, {tag ids}) for a post number."""
        at = struct.unpack_from("<I", self.offsets, post * 4)[0]
        buf = self.records
        fav, at = _varint(buf, at)
        did, at = _varint(buf, at)
        n, at = _varint(buf, at)
        ids = set()
        tid = 0
        for _ in range(n):
            gap, at = _varint(buf, at)
            tid += gap
            ids.add(tid)
        return did, fav, ids

    def list_of(self, tag, limit):
        """A tag's post numbers below `limit`, ascending."""
        off, length, count, _ = self.tags[tag]
        buf = self.postings
        out = array("i")
        at = off
        end = off + length
        value = 0
        while at < end:
            gap, at = _varint(buf, at)
            value += gap
            if value >= limit:
                break
            out.append(value)
        return out

    def count(self, include=(), exclude=(), min_score=0):
        """How many posts match: `(n, exact)`.

        Exact where it is affordable — walking the rarest include tag's posts
        and testing each record, or subtracting the excluded ones from the
        floor. Where it is not, the same walk is sampled and the answer says so,
        which is what the sheet shows as "about N".
        """
        limit = self.bound(min_score)
        if not limit:
            return 0, True
        if any(t not in self.tags for t in include):
            return 0, True
        if set(include) & set(exclude):
            return 0, True  # no post both has and lacks a tag

        inc = [self.tags[t][3] for t in include]
        exc = [self.tags[t][3] for t in exclude if t in self.tags]

        def fits(ids):
            return all(i in ids for i in inc) and not any(i in ids for i in exc)

        # A single tag with nothing to subtract and no floor is a number the
        # dictionary already holds — however common the tag is.
        if len(include) == 1 and not exc and limit == self.posts:
            return self.tags[include[0]][2], True

        # each list is read only as far as the floor, so scale by the prefix
        share = limit / self.posts
        if include:
            rarest = min(include, key=lambda t: self.tags[t][2])
            rare = self.tags[rarest][2] * share
            if rare <= COUNT_MAX:
                posts = self.list_of(rarest, limit)
                # One tag and nothing to subtract: the list itself is the answer,
                # so a common tag stays exact instead of being sampled.
                if len(include) == 1 and not exc:
                    return len(posts), True
                if len(posts) <= EXACT_RECORDS:
                    return sum(1 for p in posts if fits(self.record(p)[2])), True
                # Sampled out of that list rather than out of the corpus: every
                # candidate already carries one of the tags, so a query one post
                # in 10⁴ still lands hundreds of hits instead of none.
                hits = sum(
                    1 for p in random.sample(list(posts), SAMPLE) if fits(self.record(p)[2])
                )
                return round(len(posts) * hits / SAMPLE), False
        elif sum(self.tags[t][2] for t in exclude if t in self.tags) * share <= COUNT_MAX:
            out = array("i")
            for tag in exclude:
                if tag in self.tags:
                    out = _union(out, self.list_of(tag, limit))
            return limit - len(out), True

        hits = sum(1 for _ in range(SAMPLE) if fits(self.record(random.randrange(limit))[2]))
        return round(limit * hits / SAMPLE), False

    def named(self, ids):
        """Tag names and categories for a record's ids, in dictionary order.

        A tag under build_dict.py's cut has no row and resolves to nothing, which
        is what keeps rare tags out of drawn prompts."""
        rows = [self.names[i] for i in sorted(ids) if i < len(self.names) and self.names[i]]
        return [r[0] for r in rows], [r[1] for r in rows]

    def draw(self, include=(), exclude=(), min_score=0):
        """One random post matching the query, or None.

        Candidates are tested rather than enumerated: a record carries its own
        tag ids, so whether it matches is decided from the record alone. They
        come from the rarest include tag's list when that list is short, and
        from random post numbers otherwise — the same two paths the browser
        used, minus the network that made choosing between them delicate.
        """
        limit = self.bound(min_score)
        if not limit:
            return None
        if any(t not in self.tags for t in include):
            return None  # a tag nothing carries
        inc = [self.tags[t][3] for t in include]
        exc = [self.tags[t][3] for t in exclude if t in self.tags]

        def fits(ids):
            return all(i in ids for i in inc) and not any(i in ids for i in exc)

        rarest = min(include, key=lambda t: self.tags[t][2], default=None)
        if rarest is not None and self.tags[rarest][2] <= LIST_MAX:
            # Short list: walk it in random order. A miss is then an answer —
            # the query really has nothing — rather than a budget running out.
            posts = self.list_of(rarest, limit)
            order = list(range(len(posts)))
            random.shuffle(order)
            for k in order[:BUDGET]:
                post = posts[k]
                did, fav, ids = self.record(post)
                if fits(ids):
                    return self._post(post, did, fav, ids)
            return None

        for _ in range(BUDGET):
            post = random.randrange(limit)
            did, fav, ids = self.record(post)
            if fits(ids):
                return self._post(post, did, fav, ids)
        return None

    def _post(self, post, did, fav, ids):
        tags, cats = self.named(ids)
        return {"post": post, "id": did, "fav": fav, "tags": tags, "cats": cats}


def _union(a, b):
    """Two ascending lists as one, without repeating what they share."""
    out = array("i")
    i = j = 0
    while i < len(a) or j < len(b):
        take_a = j >= len(b) or (i < len(a) and a[i] <= b[j])
        v = a[i] if take_a else b[j]
        if take_a:
            i += 1
        else:
            j += 1
        if not out or out[-1] != v:
            out.append(v)
    return out


def _map(path):
    fh = open(path, "rb")
    # ACCESS_READ keeps the pages clean, so they are dropped rather than swapped
    return mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)


def _varint(buf, at):
    """LEB128, as build_index.py writes it. Returns (value, next offset)."""
    value = 0
    shift = 0
    while True:
        b = buf[at]
        at += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, at
        shift += 7


_index = None


def index():
    """The process-wide index, opened on first use. None when the files are not
    installed, which is how the API answers 503 instead of failing to start."""
    global _index
    if _index is None:
        _index = Index() if os.path.isfile(os.path.join(INDEX_DIR, "prompts.json")) else False
    return _index or None


def split_tags(text):
    """The query string's tag list, in the browser's own normal form."""
    out = []
    for part in text.replace("\n", ",").split(","):
        t = part.strip().lower().replace(" ", "_")
        if t:
            out.append(t)
    return out


def demo():
    ix = index()
    assert ix, f"no index in {INDEX_DIR}"
    assert _varint(b"\xac\x02", 0) == (300, 2)
    assert split_tags("Blue Eyes, rain\ncity lights") == ["blue_eyes", "rain", "city_lights"]

    # a floor is a prefix, and a lower floor can only widen it
    assert ix.bound(0) == ix.posts
    assert ix.bound(10) <= ix.bound(5) <= ix.posts

    hit = ix.draw(include=["hatsune_miku"], exclude=["1boy"], min_score=20)
    assert hit and "hatsune_miku" in hit["tags"] and "1boy" not in hit["tags"], hit
    assert len(hit["tags"]) == len(hit["cats"])

    # a contradiction has no answer, and says so rather than sampling forever
    assert ix.draw(include=["hatsune_miku"], exclude=["hatsune_miku"]) is None
    assert ix.draw(include=["no_such_tag_at_all"]) is None

    assert _union(array("i", [1, 3]), array("i", [3, 4])) == array("i", [1, 3, 4])

    # A tag rare enough to walk is counted exactly, and the answer is what the
    # dictionary already says the tag's own total is.
    rare = min(ix.tags, key=lambda t: abs(ix.tags[t][2] - EXACT_RECORDS // 3))
    n, exact = ix.count(include=[rare])
    assert exact and n == ix.tags[rare][2], (rare, n, exact)
    # one tag on its own is its own count, however common it is
    mid, exact = ix.count(include=["hatsune_miku"])
    assert exact and mid == ix.tags["hatsune_miku"][2], (mid, exact)
    # excluding a tag can only take posts away, never add any
    both, exact = ix.count(include=[rare], exclude=["1boy"])
    assert exact and 0 <= both <= n, (both, n)
    assert ix.count(include=[rare, "no_such_tag_at_all"]) == (0, True)
    assert ix.count(include=[rare], exclude=[rare]) == (0, True)

    # a floor is a prefix, so it can only shrink a count
    high, _ = ix.count(include=[rare], min_score=100)
    assert high <= n

    # A query too broad to intersect is sampled off the rarest tag's own list,
    # and lands within a few percent: `1girl` minus a tag most posts lack is
    # still nearly every `1girl`.
    big, exact = ix.count(include=["1girl"], exclude=["comic"])
    assert not exact and 0.8 * ix.tags["1girl"][2] < big <= ix.tags["1girl"][2], big
    print("ok", hit["id"], len(hit["tags"]), "tags;", n, rare, "exact,", big, "1girl (est)")


if __name__ == "__main__":
    demo()
