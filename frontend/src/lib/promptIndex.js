/* How many posts match a filter, without downloading the corpus.

   Posts are numbered by fav_count descending, so a score floor is just a
   prefix of every posting list. Every file here is read by range request and
   nothing is downloaded whole: the dictionary, the posting lists and the post
   records are all blocked so a query pays for the blocks it touches. Files come
   from build_index.py and build_dict.py. */

/* Where the index lives. Empty means same-origin, which is how dev runs. The
   built site is ~1.1 GB short of being able to carry these itself, so in
   production they are served from wherever VITE_DATA points — that host has to
   allow this origin by CORS and honour Range, since every read here is a range
   request. */
const DATA = import.meta.env?.VITE_DATA ?? "";

const LOOKUP_URL = `${DATA}/tag-lookup.bin`;
const LOOKUP_IDX_URL = `${DATA}/tag-lookup.json.gz`;
const NAMES_URL = `${DATA}/tag-names.bin`;
const NAMES_IDX_URL = `${DATA}/tag-names.idx`;
const META_URL = `${DATA}/prompts.json`;
// tags per tag-names.bin block; must match build_dict.NAME_BLOCK. Small on
// purpose: a prompt's thirty tags land in thirty scattered blocks, so the block
// is sized to carry one name, not to be scanned.
const NAME_BLOCK = 64;
const POSTINGS_URL = `${DATA}/postings.bin`;
const PROMPTS_URL = `${DATA}/prompts.bin`;
const OFFSETS_URL = `${DATA}/prompts.idx`;
const GROUPS_URL = `${DATA}/tag-groups.csv.gz`;
const PROFILES_URL = `${DATA}/characters.csv.gz`;
// danbooru category ids; the client only cares which tags are artists
export const ARTIST = 1;

let loadingMeta = null;
let loadingLookupIdx = null;
let loadingNamesIdx = null;
let loadingGroups = null;
let loadingProfiles = null;
let meta = null;
let lookupIdx = null; // { block, end, blocks: [[firstTag, byteOffset], ...] }
let namesIdx = null; // Uint32Array of block offsets, one past the end
const dict = new Map(); // tag -> [offset, length, postings, category, tag id]
const names = new Map(); // tag id -> [tag, category], likewise
const fetchedBlocks = new Map(); // block number -> in-flight or settled fetch
const lists = new Map(); // tag -> Int32Array of post numbers, ascending
const groups = new Map(); // tag -> ["attire", "nsfw", ...]
const profiles = new Map(); // character -> { series, features, attire }

/** 19 KB: the totals and the fav_count ladder. Enough to count with no tags. */
function loadMeta() {
    loadingMeta ??= fetch(META_URL)
        .then((r) => r.json())
        .then((m) => {
            meta = m;
        });
    return loadingMeta;
}

/* 49 KB: the first tag name of each 256-tag block of tag-lookup.bin. A query
   binary-searches this, then range-requests the one block it landed in — the
   whole dictionary is 28 MB and no query has ever needed more than a sliver. */
function loadLookupIdx() {
    loadingLookupIdx ??= text(LOOKUP_IDX_URL).then((json) => {
        lookupIdx = JSON.parse(json);
    });
    return loadingLookupIdx;
}

/** 14 KB: byte offset of each block of tag-names.bin, plus a terminator. */
function loadNamesIdx() {
    loadingNamesIdx ??= fetch(NAMES_IDX_URL)
        .then((r) => r.arrayBuffer())
        .then((b) => {
            namesIdx = new Uint32Array(b);
        });
    return loadingNamesIdx;
}

/**
 * Every whole-file this module reads, fetched up front — about 660 KB, most of
 * it the character profiles. Without this the first Generate pays for all of
 * them serially before it can even pick a post, which read as the app hanging
 * unless the Generator tab had already been opened and warmed them.
 *
 * The blocked files (the dictionary, postings, records) stay on demand: they are
 * tens of megabytes and a run touches a sliver.
 */
export function warmPromptIndex() {
    return Promise.all([
        loadMeta(),
        loadLookupIdx(),
        loadNamesIdx(),
        loadGroups(),
        loadProfiles(),
    ]);
}

/** [offset, length, postings, category, id], or undefined for an unknown tag. */
async function entry(tag) {
    if (dict.has(tag)) return dict.get(tag);
    await loadLookupIdx();
    const b = lookupIdx.blocks;
    // last block whose first tag is <= the one we want
    let lo = 0;
    let hi = b.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (b[mid][0] <= tag) lo = mid + 1;
        else hi = mid;
    }
    if (!lo) return undefined; // sorts before the first tag in the file
    const from = b[lo - 1][1];
    const to = (lo < b.length ? b[lo][1] : lookupIdx.end) - 1;
    await once(`l${lo}`, async () => {
        const body = decode(await range(LOOKUP_URL, from, to));
        for (const line of body.split("\n")) {
            if (!line) continue;
            // tag,count,off,len,cat,id — read from the right, tag names hold commas
            const f = line.split(",");
            dict.set(f.slice(0, -5).join(","), [
                +f.at(-4), +f.at(-3), +f.at(-5), +f.at(-2), +f.at(-1),
            ]);
        }
    });
    return dict.get(tag);
}

/** [tag, category] for a record's id. Ids are count-descending, so the blocks a
    prompt needs are mostly the first ones, already cached. */
async function name(id) {
    if (names.has(id)) return names.get(id);
    await loadNamesIdx();
    const b = Math.floor(id / NAME_BLOCK);
    await once(`n${b}`, async () => {
        const body = decode(await range(NAMES_URL, namesIdx[b], namesIdx[b + 1] - 1));
        let at = b * NAME_BLOCK;
        for (const line of body.split("\n")) {
            // `<cat><name>`, one digit of danbooru category up front
            if (line) names.set(at++, [line.slice(1), +line[0]]);
        }
    });
    return names.get(id);
}

/** The danbooru category of any tag, drawn or typed, or undefined if unknown. */
export async function categoryOf(tag) {
    return (await entry(tag))?.[3];
}

/** Run `work` once per key, even when several callers race for the block. */
function once(key, work) {
    if (!fetchedBlocks.has(key)) fetchedBlocks.set(key, work());
    return fetchedBlocks.get(key);
}

function decode(bytes) {
    return new TextDecoder().decode(bytes);
}

/* Which subsets a tag belongs to — a tag can be in several, `crotchless_panties`
   is attire and nsfw both. 80 KB, and only a query that switches one of them off
   ever asks for it. Written by build_subset.py; prompt-tags.csv.gz can't carry
   this without a full reindex. */
function loadGroups() {
    loadingGroups ??= text(GROUPS_URL).then((csv) => {
        for (const line of csv.split("\n").slice(1)) {
            if (!line) continue;
            // tag,groups — split from the right, tag names contain commas;
            // the labels are space-separated and tags never contain a space
            const cut = line.lastIndexOf(",");
            groups.set(line.slice(0, cut), line.slice(cut + 1).split(" "));
        }
    });
    return loadingGroups;
}

/* What a character canonically looks like — their series and the few traits
   they wear in most of their pictures, from build_characters.py. ~500 KB, and
   only the switches that fill a prompt in ever ask for it. */
function loadProfiles() {
    loadingProfiles ??= text(PROFILES_URL).then((csv) => {
        for (const line of csv.split("\n").slice(1)) {
            if (!line) continue;
            // character,series,features,attire — traits are space-separated
            const f = line.split(",");
            profiles.set(f.slice(0, -3).join(","), {
                series: f.at(-3),
                features: f.at(-2) ? f.at(-2).split(" ") : [],
                attire: f.at(-1) ? f.at(-1).split(" ") : [],
            });
        }
    });
    return loadingProfiles;
}

/** The canonical look of a character, or undefined if we have no profile. */
export async function profileOf(character) {
    await loadProfiles();
    return profiles.get(character);
}

/** Body text of a .gz the server may or may not have already un-gzipped. */
async function text(url) {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    return buf[0] === 0x1f && buf[1] === 0x8b
        ? new Response(
              new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")),
          ).text()
        : new TextDecoder().decode(buf);
}

/** Posts with at least this many favourites, i.e. the usable prefix length. */
function bound(minScore) {
    if (minScore <= 0) return meta.posts;
    // favBounds is [score, postsWithAtLeastThatMany], score descending, one row
    // per fav_count that exists. Take the last row still at or above the floor;
    // the first row *below* it would let posts under the floor through, and
    // scores are sparse up top, so that gap is real.
    const b = meta.favBounds;
    let lo = 0;
    let hi = b.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (b[mid][0] >= minScore) lo = mid + 1;
        else hi = mid;
    }
    return lo ? b[lo - 1][1] : 0;
}

/** A tag's post numbers, ascending, decoded only as far as `limit`.

    `1girl` is 7.4 MB of postings and a query with a fav floor wants the head of
    that, not the tail, so the bytes arrive a chunk at a time and stop early. A
    cached list is reused when it already reaches past the floor asked for. */
const CHUNK = 1 << 16;
const MAX_CHUNK = 1 << 20;

async function postings(tag, limit) {
    const held = lists.get(tag);
    if (held && held.upto >= limit) return held.arr;

    const [off, len, count] = dict.get(tag);
    const out = new Int32Array(count);
    let value = 0;
    let i = 0;
    let at = 0;
    let bytes = new Uint8Array(0);
    let read = 0;
    // A read that stops at the floor usually stops early, so the first chunk is
    // small; a list being read to its end doubles its way up to full size
    // rather than paying a round trip per 64 KB.
    let chunk = CHUNK;

    while (i < count) {
        if (at + 10 > bytes.length && read < len) {
            // keep the undecoded tail, it may hold a split varint
            const want = Math.min(chunk, len - read);
            chunk = Math.min(chunk * 2, MAX_CHUNK);
            const more = await range(POSTINGS_URL, off + read, off + read + want - 1);
            const rest = bytes.subarray(at);
            const buf = new Uint8Array(rest.length + more.length);
            buf.set(rest);
            buf.set(more, rest.length);
            bytes = buf;
            read += want;
            at = 0;
        }
        let gap = 0;
        let shift = 0;
        for (;;) {
            const b = bytes[at++];
            gap += (b & 0x7f) * 2 ** shift;
            if (!(b & 0x80)) break;
            shift += 7;
        }
        out[i++] = value += gap;
        // everything past the floor would be clipped off anyway
        if (value >= limit) break;
    }

    const arr = out.subarray(0, i);
    // a list read to its end covers every floor; a truncated one covers `value`
    lists.set(tag, { arr, upto: i === count ? Infinity : value });
    return arr;
}

/** Ascending list cut to the posts that clear the score floor. */
function clip(list, limit) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid] < limit) lo = mid + 1;
        else hi = mid;
    }
    return list.subarray(0, lo);
}

/** Merge two ascending lists: `keep` decides whether a match survives. */
function merge(a, b, keep) {
    const out = new Int32Array(a.length);
    let i = 0;
    let j = 0;
    let w = 0;
    while (i < a.length) {
        while (j < b.length && b[j] < a[i]) j++;
        const same = j < b.length && b[j] === a[i];
        if (same === keep) out[w++] = a[i];
        i++;
    }
    return out.subarray(0, w);
}

/** Merge two ascending lists into one, without duplicating what they share. */
function union(a, b) {
    const out = new Int32Array(a.length + b.length);
    let i = 0;
    let j = 0;
    let w = 0;
    while (i < a.length || j < b.length) {
        const takeA = j >= b.length || (i < a.length && a[i] <= b[j]);
        const v = takeA ? a[i++] : b[j++];
        if (!w || out[w - 1] !== v) out[w++] = v;
    }
    return out.subarray(0, w);
}

export function splitTags(text) {
    return text
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase().replaceAll(" ", "_"))
        .filter(Boolean);
}

const EMPTY = new Int32Array(0);

/**
 * Posts carrying every include tag, no exclude tag, at or above the score.
 * Unknown include tags match nothing; unknown excludes exclude nothing.
 *
 * `hits` is the match list, or null when there are no include tags — then the
 * matches are every post below `limit` except the ones in `excluded`, which is
 * far cheaper to keep than the complement of ten million posts.
 */
async function select({ include = [], exclude = [], minScore = 0 }) {
    await loadMeta();
    const limit = bound(minScore);
    if (!limit) return { limit: 0, hits: EMPTY, excluded: EMPTY };
    if (!include.length && !exclude.length) return { limit, hits: null, excluded: EMPTY };
    // one block fetch per named tag, and they go out together
    await Promise.all([...include, ...exclude].map(entry));
    if (include.some((t) => !dict.has(t))) return { limit, hits: EMPTY, excluded: EMPTY };

    // Smallest list first: it caps the size of every merge after it.
    const inc = include.sort((a, b) => dict.get(a)[2] - dict.get(b)[2]);
    let hits = inc.length ? clip(await postings(inc[0], limit), limit) : null;
    for (const tag of inc.slice(1)) {
        if (!hits.length) return { limit, hits: EMPTY, excluded: EMPTY };
        hits = merge(hits, clip(await postings(tag, limit), limit), true);
    }
    if (!hits) {
        // Excluded lists overlap, so union them rather than summing.
        let out = EMPTY;
        for (const tag of exclude) {
            if (dict.has(tag)) out = union(out, clip(await postings(tag, limit), limit));
        }
        return { limit, hits: null, excluded: out };
    }
    for (const tag of exclude) {
        if (!hits.length || !dict.has(tag)) continue;
        hits = merge(hits, clip(await postings(tag, limit), limit), false);
    }
    return { limit, hits, excluded: EMPTY };
}

/**
 * A count without the posting lists, for showing something immediately.
 *
 * Exact counting has to intersect the lists, and two common tags are ~8 MB of
 * them; the dictionary already knows each tag's total, so this multiplies the
 * rates instead and costs one small block per tag.
 *
 * It assumes tags are independent, which they are not — `1girl` and `solo`
 * co-occur far more than chance, `1girl` and `1boy` far less — so treat it as
 * an order of magnitude, not an answer. Returns null when there is nothing to
 * estimate from, i.e. when the exact path was already going to be free.
 */
export async function estimatePrompts(query) {
    const { include = [], exclude = [], minScore = 0 } = query;
    // one tag and nothing else is a dictionary read, and the dictionary is exact
    if (include.length < 2 && !exclude.length) return null;

    await loadMeta();
    const limit = bound(minScore);
    if (!limit) return 0;

    const counts = await Promise.all(
        include.map(async (t) => (await entry(t))?.[2] ?? 0),
    );
    if (counts.some((c) => !c)) return 0; // an unknown tag matches nothing

    // Rates against the whole corpus, applied to the part above the floor.
    let rate = 1;
    for (const c of counts) rate *= c / meta.posts;
    for (const t of exclude) {
        const c = (await entry(t))?.[2] ?? 0;
        rate *= 1 - c / meta.posts;
    }
    return Math.round(rate * limit);
}

/**
 * The exact count, or null when it would cost more than `maxBytes` of posting
 * list to work out. Counting is the one job that really does have to intersect
 * the lists, and two common tags are megabytes of them — on a slow connection
 * that is minutes for a number nobody waits on. The estimate above stands in.
 */
export async function countPrompts(query, maxBytes = Infinity) {
    // The dictionary already knows how many posts carry a tag. With no floor
    // and nothing to intersect, that number *is* the answer — no posting list.
    const { include = [], exclude = [], minScore = 0 } = query;
    if (include.length === 1 && !exclude.length && !minScore) {
        return (await entry(include[0]))?.[2] ?? 0;
    }
    if (maxBytes < Infinity) {
        await loadMeta();
        const limit = bound(minScore);
        const named = await Promise.all([...include, ...exclude].map(entry));
        // every list is read, each only as far as the floor
        const bytes = named.reduce((n, e) => n + (e?.[1] ?? 0), 0) * (limit / meta.posts);
        if (bytes > maxBytes) return null;
    }
    const { limit, hits, excluded } = await select(query);
    return hits ? hits.length : limit - excluded.length;
}

/** The k-th post below `limit` that `excluded` (ascending) doesn't cover. */
function skipping(k, excluded) {
    // Every excluded value at or below the answer pushes it up by one, so find
    // how many do: the count of j where excluded[j] - j <= k.
    let lo = 0;
    let hi = excluded.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (excluded[mid] - mid <= k) lo = mid + 1;
        else hi = mid;
    }
    return k + lo;
}

/** Both header and tag ids are LEB128; returns [value, nextOffset]. */
function varint(bytes, at) {
    let v = 0;
    let shift = 0;
    for (;;) {
        const b = bytes[at++];
        v += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80)) break;
        shift += 7;
    }
    return [v, at];
}

async function range(url, from, to) {
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A server that ignored the Range header sent the whole file.
    return res.status === 206 ? bytes : bytes.subarray(from, to + 1);
}

/** One record's tag ids, from `bytes` starting at `at`. Names are not resolved:
    a candidate is judged on ids, and only the post that wins is spelled out. */
function decodeRecord(bytes, at, post) {
    let fav, id, count;
    [fav, at] = varint(bytes, at);
    [id, at] = varint(bytes, at);
    [count, at] = varint(bytes, at);

    const ids = new Set();
    let tagId = 0;
    for (let i = 0; i < count; i++) {
        let gap;
        [gap, at] = varint(bytes, at);
        ids.add((tagId += gap));
    }
    return { post, id, fav, ids };
}

/**
 * The records of `n` consecutive posts, in two range requests however many
 * posts that is: prompts.idx is uint32 LE, so one read of n+1 entries brackets
 * a run of records that is itself contiguous in prompts.bin.
 */
async function window(from, n) {
    const ends = await range(OFFSETS_URL, from * 4, (from + n) * 4 + 3);
    const view = new DataView(ends.buffer, ends.byteOffset, ends.byteLength);
    const start = view.getUint32(0, true);
    const end = view.getUint32(n * 4, true);
    const bytes = await range(PROMPTS_URL, start, end - 1);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(decodeRecord(bytes, view.getUint32(i * 4, true) - start, from + i));
    }
    return out;
}

/** A record with its tags spelled out, the shape callers get back. */
async function named(rec) {
    const ids = [...rec.ids];
    // Ids are count-descending, so a prompt's tags sit in a handful of blocks,
    // usually the first ones — after the first prompt these are all cache hits.
    const pairs = await Promise.all(ids.map(name));
    return {
        post: rec.post,
        id: rec.id,
        fav: rec.fav,
        tags: pairs.map((n) => n[0]),
        cats: pairs.map((n) => n[1]),
    };
}

/* Sampling, which is how a random post is actually found.

   Intersecting posting lists answers "which posts match" — but a draw only
   needs *one* of them, and the lists are the expensive part of this index:
   `1girl` alone is 7.4 MB. So candidates are tested instead of enumerated. A
   record carries its own tag ids, and the dictionary knows the id of every tag
   in the query, so a candidate is judged from its record and nothing else.

   Candidates come from whichever source is cheaper for the query:

     uniform — random runs of consecutive posts, ~60 bytes each. Costs one
       record per 1/selectivity, so it wins whenever the query is not rare.
     rarest — random entries of the smallest include tag's posting list, which
       for a rare tag is the whole point: 100 posts instead of 7 million.

   Posts are ordered by favourites, so a run of consecutive ones is a run of
   near-equal fav_count rather than an independent draw. That is a real bias and
   the reason the runs are short and scattered rather than one long one. */

// bytes a candidate costs: prompts.bin / posts, plus its two prompts.idx entries
const RECORD_BYTES = 62;
const MAX_RUN = 256; // candidates per pair of range requests, at most
const LANES = 4; // runs in flight at once, at most
const PROBES = 16; // single records in flight at once, on the rarest-tag path
const SCAN = 1024; // posting list short enough to walk rather than sample
const BUDGET = 1 << 14; // candidates before giving up and counting exactly

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Fisher-Yates over a copy, so a walk of a posting list is in no order. */
function shuffled(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/** Judge a candidate on ids alone. */
function fits(rec, inc, exc) {
    return inc.every((id) => rec.ids.has(id)) && !exc.some((id) => rec.ids.has(id));
}

/**
 * Where to draw candidates from, and how many it should take: `{ from, need }`,
 * `from` being a tag whose list to draw out of, or null for uniform.
 *
 * Independence is wrong — `1girl` and `solo` co-occur far above chance — but
 * this only sizes the reads and picks between two paths that are both correct
 * whichever it picks, so being out by a factor of a few costs a second round.
 */
function source(include, exclude, limit) {
    let rate = 1;
    for (const t of include) rate *= dict.get(t)[2] / meta.posts;
    for (const t of exclude) if (dict.has(t)) rate *= 1 - dict.get(t)[2] / meta.posts;
    const uniform = rate > 0 ? RECORD_BYTES / rate : Infinity;

    let rarest = null;
    for (const t of include) if (!rarest || dict.get(t)[2] < dict.get(rarest)[2]) rarest = t;
    // the list is read only as far as the score floor, so scale by the prefix
    const list = rarest ? dict.get(rarest)[1] * (limit / meta.posts) : Infinity;
    if (uniform <= list) return { from: null, need: candidates(rate) };
    // drawing from the list, the tag it belongs to is already satisfied
    return { from: rarest, need: candidates(rate / (dict.get(rarest)[2] / meta.posts)) };
}

/** Candidates to try at a hit rate of `rate` — two expected hits' worth. */
function candidates(rate) {
    return rate > 0 ? clamp(Math.ceil(2 / rate), 1, BUDGET) : BUDGET;
}

/** A matching record found by sampling, or undefined if the budget ran out. */
async function sample(query, limit, inc, exc) {
    const { from, need } = source(query.include ?? [], query.exclude ?? [], limit);
    // the rarest tag's list, ascending; every candidate is drawn out of it
    const list = from ? clip(await postings(from, limit), limit) : null;
    if (list && !list.length) return null; // no post carries it above the floor

    // A list short enough to walk is walked, in a random order: then a miss is
    // an answer rather than a budget running out, no post is fetched twice, and
    // the hit is still an even draw — every match is equally likely to be in
    // the first batch that finds one.
    if (list && list.length <= SCAN) {
        const order = shuffled(list);
        const wide = clamp(need, 1, PROBES);
        for (let i = 0; i < order.length; i += wide) {
            const recs = await Promise.all(
                order.slice(i, i + wide).map((p) => window(p, 1)),
            );
            const hits = recs.flat().filter((r) => fits(r, inc, exc));
            if (hits.length) return hits[Math.floor(Math.random() * hits.length)];
        }
        return null;
    }

    // Sized to the query: a common one is answered by a single short run, and
    // only a thin one pays for four long ones.
    const run = list ? 1 : clamp(need, 1, MAX_RUN);
    const lanes = clamp(Math.ceil(need / run), 1, list ? PROBES : LANES);

    for (let seen = 0; seen < BUDGET; seen += run * lanes) {
        const runs = await Promise.all(
            Array.from({ length: lanes }, () =>
                list
                    // the list's own entries are already scattered, so these are
                    // single records rather than runs
                    ? window(list[Math.floor(Math.random() * list.length)], 1)
                    : window(
                          Math.floor(Math.random() * Math.max(1, limit - run)),
                          Math.min(run, limit),
                      ),
            ),
        );
        const hits = runs.flat().filter((r) => r.post < limit && fits(r, inc, exc));
        if (hits.length) return hits[Math.floor(Math.random() * hits.length)];
    }
    return undefined;
}

/** A random matching post, or null when nothing matches. */
export async function randomPrompt(query) {
    await loadMeta();
    const include = query.include ?? [];
    const exclude = query.exclude ?? [];
    const limit = bound(query.minScore ?? 0);
    let rec;

    if (limit) {
        // one dictionary block per named tag, and they go out together
        await Promise.all([...include, ...exclude].map(entry));
        if (include.every((t) => dict.has(t))) {
            rec = await sample(
                query,
                limit,
                include.map((t) => dict.get(t)[4]),
                exclude.filter((t) => dict.has(t)).map((t) => dict.get(t)[4]),
            );
        } else {
            rec = null; // an unknown include tag matches nothing
        }
    } else {
        rec = null;
    }

    // Sampling gives up rather than proving a rare query empty; the posting
    // lists can prove it, so that is what the last resort is for.
    if (rec === undefined) {
        const { hits, excluded } = await select(query);
        const total = hits ? hits.length : limit - excluded.length;
        if (total <= 0) return null;
        const k = Math.floor(Math.random() * total);
        [rec] = await window(hits ? hits[k] : skipping(k, excluded), 1);
    }
    if (!rec) return null;

    const post = await named(rec);
    const drop = query.drop ?? [];
    const dropCats = query.dropCats ?? [];
    if (!drop.length && !dropCats.length) return post;

    // A switched-off tag type thins the prompt; it never rejects the post, so
    // the count in the sheet stays the count the user gets.
    //
    // Two kinds of switch, and they cut on different things: characters,
    // artists and series are danbooru categories carried on the record itself,
    // while attire/features/expressions/nsfw are subsets that only tag-groups
    // knows about — which is why that file is fetched only when one is off.
    if (drop.length) await loadGroups();
    const cut = (tag, cat) =>
        dropCats.includes(cat) || (groups.get(tag) ?? []).some((g) => drop.includes(g));

    const kept = post.tags
        .map((t, i) => [t, post.cats[i]])
        .filter(([t, c]) => !cut(t, c));
    return { ...post, tags: kept.map((k) => k[0]), cats: kept.map((k) => k[1]) };
}

/* Sheet pill -> the subset it turns off. build_subset.py names the subsets. */
const GROUP_OF = {
    attire: "attire",
    characteristic: "feature",
    expression: "expression",
    nsfw: "nsfw",
};

/* The other three pills are danbooru categories, not subsets: they are stamped
   on every tag record, so they need no extra file to cut on. */
const CAT_OF = { character: 4, artist: ARTIST, copyright: 3 };

/**
 * Settings shape -> query. Every switched-off tag type, NSFW included, thins the
 * prompt the generator hands back; none of them narrow the pool of posts, so the
 * count stays the count.
 */
export function buildQuery({ include, exclude, minScore, filters }) {
    return {
        include: splitTags(include),
        exclude: splitTags(exclude),
        minScore,
        drop: Object.keys(GROUP_OF).filter((k) => filters?.[k]).map((k) => GROUP_OF[k]),
        dropCats: Object.keys(CAT_OF).filter((k) => filters?.[k]).map((k) => CAT_OF[k]),
    };
}
