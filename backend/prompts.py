"""The draw endpoint: one random post matching a query.

The browser asks for a prompt instead of reading the index itself. Nothing here
edits a prompt — it draws one and hands the tags back exactly as build_index.py
stored them; assembling, filtering and reordering all stay in the client.

Who is asking is the sha256 of their NovelAI key, as in presets.py — the key is
never stored and never leaves this process. A caller with no key is turned away:
drawing costs disk and CPU, and there is no anonymous tier.

The handler is a plain `def`: a draw is CPU work on mmapped files, so FastAPI
runs it in the threadpool instead of blocking the loop the generation stream
lives on.
"""

import hashlib
import time

from fastapi import APIRouter, HTTPException, Request, Response

import draw

router = APIRouter(prefix="/api")

# One prompt per this many seconds. Asking sooner is a violation, not a queue:
# the client is expected to wait, and hammering is what the strikes are for.
COOLDOWN = 5.0
# Counting is the cheaper call — a walk of one posting list, or a sample — and
# it is what someone does while tuning filters, so it gets its own shorter
# bucket. Sharing the draw's would make a count cost an image.
COUNT_COOLDOWN = 3.0
# Violations in one window before the door shuts, and for how long. Ten early
# asks inside a minute is a script; a few impatient taps spread out is a person.
STRIKES = 10
WINDOW = 60.0
BAN = 300.0
# How long a caller is remembered once they stop asking.
FORGET = 300.0
# Callers to remember at most. Each is ~100 bytes; the sweep below keeps the
# table to whoever is actually drawing.
MAX_CALLERS = 50_000

# "<endpoint>:<key hash>" -> [last call, strikes, window opened, banned until]
_seen = {}


def _caller(request: Request) -> str:
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Log in with your NovelAI key to draw prompts")
    return hashlib.sha256(token.encode()).hexdigest()


def _sweep(now):
    """Drop callers who are neither cooling down nor banned."""
    if len(_seen) <= MAX_CALLERS:
        return
    for k, s in list(_seen.items()):
        if now - s[0] > FORGET and now >= s[3]:
            del _seen[k]


def _allow(who, now, cooldown=COOLDOWN):
    """Seconds to wait, or 0 to go ahead. Records the call when it allows one."""
    s = _seen.get(who)
    if s is None:
        _sweep(now)
        _seen[who] = [now, 0, 0.0, 0.0]
        return 0

    if now < s[3]:
        return s[3] - now

    wait = cooldown - (now - s[0])
    if wait <= 0:
        s[0] = now
        return 0

    # Violations are counted per window, not for ever: the count starts again
    # with the first one that lands outside the last window.
    if now - s[2] > WINDOW:
        s[1], s[2] = 1, now
    else:
        s[1] += 1
    if s[1] >= STRIKES:
        s[1], s[2] = 0, 0.0
        s[3] = now + BAN
        return BAN
    return wait


def _gate(request, what, cooldown):
    """Rate limit for one endpoint, or 429. Returns the open index."""
    wait = _allow(f"{what}:{_caller(request)}", time.monotonic(), cooldown)
    if wait:
        raise HTTPException(
            429,
            f"One {what} every {cooldown:.0f}s. Try again in {wait:.0f}s.",
            headers={"Retry-After": str(int(wait) + 1)},
        )
    ix = draw.index()
    if not ix:
        raise HTTPException(503, "The prompt index is not installed on this server")
    return ix


@router.get("/prompt")
def prompt(request: Request, include: str = "", exclude: str = "", minScore: int = 0):
    """A random post: `{post, id, fav, tags, cats}`.

    An empty pool answers 204, not 404: 404 is what a server that has never
    heard of this route says, and the two must not read the same to the client —
    "no post matches your filters" and "your backend is out of date" call for
    very different fixes.
    """
    ix = _gate(request, "prompt", COOLDOWN)
    post = ix.draw(
        include=draw.split_tags(include),
        exclude=draw.split_tags(exclude),
        min_score=max(0, minScore),
    )
    if post is None:
        return Response(status_code=204)
    return post


@router.get("/prompt-count")
def prompt_count(request: Request, include: str = "", exclude: str = "", minScore: int = 0):
    """How big the pool is: `{n, exact}`. `exact` is false for a sampled answer."""
    ix = _gate(request, "count", COUNT_COOLDOWN)
    n, exact = ix.count(
        include=draw.split_tags(include),
        exclude=draw.split_tags(exclude),
        min_score=max(0, minScore),
    )
    return {"n": n, "exact": exact}


def demo():
    now = 1000.0
    _seen.clear()
    assert _allow("a", now) == 0  # first draw
    for i in range(1, STRIKES):  # nine early asks are answered with a wait
        assert 0 < _allow("a", now + i / 10) < BAN, i
    assert _allow("a", now + 1) == BAN  # the tenth shuts the door
    assert _allow("a", now + 2) > 0  # and it stays shut
    assert _allow("a", now + BAN + 2) == 0  # until it doesn't

    # the same ten, one window apart, never add up to a ban
    _seen.clear()
    t = now
    for _ in range(4):
        assert _allow("b", t) == 0
        for i in range(1, STRIKES):
            assert _allow("b", t + i / 10) < BAN
        t += WINDOW + COOLDOWN

    # the two endpoints have their own buckets: counting while tuning filters
    # must not cost the draw its turn
    _seen.clear()
    assert _allow("count:a", now, COUNT_COOLDOWN) == 0
    assert _allow("prompt:a", now) == 0
    assert _allow("count:a", now + COUNT_COOLDOWN, COUNT_COOLDOWN) == 0

    # patience is never punished, however long the session runs
    _seen.clear()
    t = now
    for _ in range(5):
        assert _allow("b", t) == 0
        t += COOLDOWN

    # a single impatient click every ten seconds is six a minute, under the
    # limit however long it goes on
    _seen.clear()
    t = now
    for _ in range(20):
        assert _allow("c", t) == 0
        assert 0 < _allow("c", t + 1) < BAN
        t += 10
    print("ok")


if __name__ == "__main__":
    demo()
