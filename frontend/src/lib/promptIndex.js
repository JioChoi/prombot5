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

const DICT_URL = `${DATA}/tag-dict.csv.gz`;
const META_URL = `${DATA}/prompts.json`;
const POSTINGS_URL = `${DATA}/postings.bin`;
const PROMPTS_URL = `${DATA}/prompts.bin`;
const OFFSETS_URL = `${DATA}/prompts.idx`;
const ANCHORS_URL = `${DATA}/prompts.anc.gz`;
const GROUPS_URL = `${DATA}/tag-groups.csv.gz`;
/* The one data file small enough to travel with the site (540 KB), and the one
   that has to move in lockstep with the code that reads it — the column list
   has changed once already. Same-origin, so a stale copy on the data host can
   never shift its fields out from under this. */
const PROFILES_URL = "/characters.csv.gz";
// danbooru category ids; the client only cares which tags are artists
export const ARTIST = 1;

let loadingMeta = null;
let loadingDict = null;
let loadingGroups = null;
let loadingProfiles = null;
let meta = null;
const dict = new Map(); // tag -> [offset, length, postings, category, tag id]
const names = new Map(); // tag id -> [tag, category], the same rows by id
const lists = new Map(); // tag -> Int32Array of post numbers, ascending
const groups = new Map(); // tag -> ["attire", "nsfw", ...]
const profiles = new Map(); // character -> { series, features, attire }

/** 19 KB: the totals and the fav_count ladder. Enough to count with no tags. */
function loadMeta() {
    loadingMeta ??= fetch(META_URL)
        .then(tracked)
        .then((b) => JSON.parse(new TextDecoder().decode(b)))
        .then((m) => {
            meta = m;
        });
    return loadingMeta;
}

/**
 * Every whole-file this module reads, fetched up front — about 2.6 MB, most of
 * it the dictionary. Without this the first Generate pays for all of them
 * serially before it can even pick a post, which read as the app hanging.
 *
 * The corpus itself stays on demand and range-read: postings.bin and
 * prompts.bin are a gigabyte between them, and a run touches a sliver.
 */
export function warmPromptIndex() {
    return Promise.all([loadMeta(), loadDict(), loadGroups(), loadProfiles(), loadAnchors()]);
}

/* Where every 64th record starts in prompts.bin, from build_anchors.py.

   The full table is prompts.idx, 42 MB, which has to stay on the server — so
   reading a record meant asking it where the record was and only then asking
   for the record. Two round trips, strictly in series, and on a phone that
   chain *is* the wait before a prompt appears.

   Every 64th offset is 260 KB, which can be held. A post's block brackets it
   in prompts.bin, so one request covers it and `window` walks forward inside
   the block — about 3.5 KB of records, decoded in microseconds. */
const STRIDE = 64; // must match build_anchors.py
let loadingAnchors = null;
let anchors = null;

function loadAnchors() {
    loadingAnchors ??= (async () => {
        const res = await fetch(ANCHORS_URL);
        if (!res.ok) throw new Error(`anchors: ${res.status}`);
        const bytes = await gunzip(await tracked(res));
        // gap varints, ascending — the same encoding the postings use
        const out = [];
        let at = 0;
        let v = 0;
        while (at < bytes.length) {
            let gap;
            [gap, at] = varint(bytes, at);
            out.push((v += gap));
        }
        anchors = Uint32Array.from(out);
    })()
        // A data host without the file is not a broken app: `window` falls back
        // to the two-request path, which is what every client did before this.
        .catch(() => {});
    return loadingAnchors;
}

/** Un-gzip, unless the server already did it for us. */
async function gunzip(bytes) {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    const blob = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(blob).arrayBuffer());
}

/* How far the warm-up has got, in bytes, so the app can show a bar for it.
   One subscriber, because there is one bar. Both numbers grow as responses
   arrive — a file whose headers have not landed yet is not in `total` — so the
   fraction is a lower bound on how much is left, never an exact one. */
const loaded = { done: 0, total: 0 };
let watcher = null;

export function onWarmProgress(fn) {
    watcher = fn;
}

/** Body bytes of a response, counting them into `loaded` as they arrive. */
async function tracked(res) {
    // Content-Length is the compressed length when the server applied its own
    // encoding, while the reader hands back decompressed bytes — the ratio can
    // run past 1, so the display clamps. These files are pre-gzipped and served
    // as-is, so in practice the two agree.
    const len = +res.headers.get("content-length");
    if (!len || !res.body) return new Uint8Array(await res.arrayBuffer());
    loaded.total += len;
    const reader = res.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
        loaded.done += value.length;
        watcher?.(Math.min(1, loaded.done / loaded.total));
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

/* 2 MB gzipped: every tag used 50 times or more, which is 109k of the 928k in
   the corpus but 98.6% of all tag occurrences. It used to be blocked and
   range-requested, which made looking one tag up cheap and decoding a drawn
   post expensive — thirty scattered tags meant thirty round trips before a
   prompt could be shown. Held whole instead, every lookup below is a Map hit.

   Cut tags are simply absent: their postings are unreachable and a record that
   mentions one resolves to nothing, so they never reach a prompt. */
function loadDict() {
    loadingDict ??= text(DICT_URL).then((csv) => {
        for (const line of csv.split("\n")) {
            if (!line) continue;
            // tag,count,off,len,cat,id — read from the right, tag names hold commas
            const f = line.split(",");
            const tag = f.slice(0, -5).join(",");
            const cat = +f.at(-2);
            const id = +f.at(-1);
            dict.set(tag, [+f.at(-4), +f.at(-3), +f.at(-5), cat, id]);
            names.set(id, [tag, cat]);
        }
    });
    return loadingDict;
}

/** [offset, length, postings, category, id], or undefined for an unknown tag. */
async function entry(tag) {
    await loadDict();
    return dict.get(tag);
}

/** [tag, category] for a record's id, or undefined when the tag was cut. */
async function name(id) {
    await loadDict();
    return names.get(id);
}

/** The danbooru category of any tag, drawn or typed, or undefined if unknown. */
export async function categoryOf(tag) {
    return (await entry(tag))?.[3];
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
        const lines = csv.split("\n");
        // character,series,features,attire[,posts] — the count was added later,
        // and this file is served from the data host, not from the build, so a
        // client can meet a copy that predates it. Read the header rather than
        // assume: guessing per row would silently shift every field by one.
        const tail = lines[0].endsWith(",posts") ? 4 : 3;
        for (const line of lines.slice(1)) {
            if (!line) continue;
            // Split from the right — a character name may contain a comma, the
            // trailing fields never do. Traits are space-separated.
            const f = line.split(",");
            profiles.set(f.slice(0, -tail).join(","), {
                series: f.at(-tail),
                features: f.at(1 - tail) ? f.at(1 - tail).split(" ") : [],
                attire: f.at(2 - tail) ? f.at(2 - tail).split(" ") : [],
                posts: tail === 4 ? +f.at(-1) : 0,
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

/** Every profile, keyed by character. The same Map the lookups above read, so
    browsing the whole list costs nothing beyond the one download. */
export async function allProfiles() {
    await loadProfiles();
    return profiles;
}

/** Body text of a .gz the server may or may not have already un-gzipped. */
async function text(url) {
    const buf = await tracked(await fetch(url));
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
const MIN_CHUNK = 1 << 18;
const MAX_CHUNK = 1 << 22;

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
    // Size the first read for the whole job rather than creeping up to it. A
    // range request costs about the same whether it carries 64 KB or 1 MB —
    // over a CDN it is ~1s of latency either way — so the thing to minimise is
    // the number of them, not the bytes. Post numbers run 0..posts and the list
    // is roughly even across them, so reaching `limit` needs about that
    // fraction of the bytes; the margin covers a tag that skews to the top.
    let chunk = Math.max(MIN_CHUNK, Math.ceil((len * limit * 1.5) / meta.posts));

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
async function select({ include = [], exclude = [], minScore = 0 }, upto = 0) {
    await loadMeta();
    // `upto` counts within the first N posts instead of the whole floor, which
    // is how an estimate buys a bounded amount of reading. Posts are ranked by
    // favourites, so that prefix is the most-liked slice, not a random one.
    const limit = upto || bound(minScore);
    if (!limit) return { limit: 0, hits: EMPTY, excluded: EMPTY };
    if (!include.length && !exclude.length) return { limit, hits: null, excluded: EMPTY };
    // one block fetch per named tag, and they go out together
    await Promise.all([...include, ...exclude].map(entry));
    if (include.some((t) => !dict.has(t))) return { limit, hits: EMPTY, excluded: EMPTY };

    // Every list this query needs, fetched at once. They were read one after
    // another before, and each one is a round trip that dominates its own
    // decode — two tags meant waiting out two latencies in series.
    const wanted = [...include, ...exclude].filter((t) => dict.has(t));
    const read = new Map(
        await Promise.all(
            wanted.map(async (t) => [t, clip(await postings(t, limit), limit)]),
        ),
    );

    // Smallest list first: it caps the size of every merge after it.
    const inc = include.sort((a, b) => dict.get(a)[2] - dict.get(b)[2]);
    let hits = inc.length ? read.get(inc[0]) : null;
    for (const tag of inc.slice(1)) {
        if (!hits.length) return { limit, hits: EMPTY, excluded: EMPTY };
        hits = merge(hits, read.get(tag), true);
    }
    if (!hits) {
        // Excluded lists overlap, so union them rather than summing.
        let out = EMPTY;
        for (const tag of exclude) {
            if (read.has(tag)) out = union(out, read.get(tag));
        }
        return { limit, hits: null, excluded: out };
    }
    for (const tag of exclude) {
        if (!hits.length || !read.has(tag)) continue;
        hits = merge(hits, read.get(tag), false);
    }
    return { limit, hits, excluded: EMPTY };
}

/**
 * How much posting list a count may read before it estimates instead.
 *
 * The same number on both sides on purpose: countPrompts gives up above it and
 * estimatePrompts takes over below it, so exactly one of them answers. Two
 * budgets would drift and leave a query that neither will touch.
 *
 * Sized to about one request — a range request costs ~1s of latency whatever
 * it carries, so a bigger budget is nearly free and keeps more queries on the
 * exact path, where the answer cannot wobble as the floor moves.
 */
export const COUNT_BUDGET = 1_200_000;

/**
 * A count from a slice of the corpus rather than all of it.
 *
 * Exact counting has to intersect whole posting lists. This intersects the same
 * lists over the first N posts only — a real intersection, so co-occurrence is
 * measured rather than assumed — and scales the answer up. Reading stops at N,
 * which is what bounds the cost.
 *
 * The bias is that posts are ranked by favourites, so the slice is the
 * best-liked part of the corpus and tags that skew popular are over-counted.
 * That beats assuming independence, which is wrong by 10x on correlated pairs.
 *
 * Returns null when the exact count was going to be cheap anyway.
 */
export async function estimatePrompts(query, budget = COUNT_BUDGET) {
    const { include = [], exclude = [], minScore = 0 } = query;
    // Only bow out where countPrompts answers for free, or nothing shows the
    // number at all: it returns null once the lists cost more than its budget,
    // and one tag *with a floor* is not the free case — the dictionary knows a
    // tag's total over the whole corpus, not over the part above a floor.
    if (!exclude.length && !minScore && include.length < 2) return null;

    await loadMeta();
    const limit = bound(minScore);
    if (!limit) return 0;

    const named = await Promise.all([...include, ...exclude].map(entry));
    if (include.some((t) => !dict.has(t))) return 0; // unknown tag, no matches

    // Bytes to read every list as far as the floor, and the slice that fits.
    const full = named.reduce((n, e) => n + (e?.[1] ?? 0), 0) * (limit / meta.posts);
    if (full <= budget) return null; // cheap enough to be exact
    const upto = Math.max(1, Math.floor((limit * budget) / full));

    const { hits, excluded } = await select(query, upto);
    const found = hits ? hits.length : upto - excluded.length;

    // Pin the extrapolation between what is already known for certain. The
    // slice is part of the range, so its count is a floor; an intersection
    // cannot outgrow its smallest list or the corpus above the fav floor, so
    // that is the ceiling. Without this a tag whose posts crowd the popular
    // end scales past its own total — `1girl` above a floor of 1 came out at
    // 8.5M against a corpus-wide 7.4M, which reads as the count going *down*
    // when the floor is dropped to nothing and the exact answer takes over.
    const ceiling = include.length
        ? Math.min(limit, ...include.map((t) => dict.get(t)[2]))
        : limit;
    return Math.min(Math.max(found, Math.round(found * (limit / upto))), ceiling);
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

/**
 * How many posts a query draws from: `{ n, exact }`.
 *
 * The one entry point for a count, because the two paths below only work as a
 * pair. countPrompts gives up above a byte budget and estimatePrompts takes
 * over below it, and if the two budgets ever disagree there is a band of
 * queries neither will answer — which showed up as the number freezing on the
 * previous, smaller figure while the fav floor was lowered.
 */
export async function promptCount(query) {
    const n = await countPrompts(query, COUNT_BUDGET);
    if (n !== null) return { n, exact: true };
    return { n: await estimatePrompts(query), exact: false };
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
    drawStep();
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
    // `end` is where the next record starts, which is what lets a block be
    // walked without asking prompts.idx where each record begins.
    return { post, id, fav, ids, end: at };
}

/**
 * The records of `n` consecutive posts, in two range requests however many
 * posts that is: prompts.idx is uint32 LE, so one read of n+1 entries brackets
 * a run of records that is itself contiguous in prompts.bin.
 */
async function window(from, n) {
    if (anchors) return block(from, n);
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

/**
 * The same window in one request, using the held anchor table.
 *
 * The blocks holding the run are fetched whole and walked from their first
 * record — up to 63 records of preamble, ~1.7 KB on average, against a round
 * trip saved. Records are self-delimiting, so walking needs no offsets.
 */
async function block(from, n) {
    const first = Math.floor(from / STRIDE);
    const last = Math.floor((from + n - 1) / STRIDE);
    const start = anchors[first];
    // The final anchor is the end of the file, so a run touching the last block
    // has nothing past it to bracket with.
    const end = anchors[Math.min(last + 1, anchors.length - 1)];
    const bytes = await range(PROMPTS_URL, start, end - 1);
    const out = [];
    let at = 0;
    for (let post = first * STRIDE; post < from + n; post++) {
        const rec = decodeRecord(bytes, at, post);
        at = rec.end;
        if (post >= from) out.push(rec);
    }
    return out;
}

/** A record with its tags spelled out, the shape callers get back. */
async function named(rec) {
    const ids = [...rec.ids];
    const pairs = await Promise.all(ids.map(name));
    // A tag under the dictionary's cut has no row, so it resolves to nothing
    // and is dropped here. That is what keeps rare tags out of drawn prompts:
    // the records still hold their ids, and nothing can name them.
    const known = pairs.filter(Boolean);
    return {
        post: rec.post,
        id: rec.id,
        fav: rec.fav,
        tags: known.map((n) => n[0]),
        cats: known.map((n) => n[1]),
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

/* How a draw is getting on, for the bar the app shows while it runs.

   A draw is a chain of range requests whose length is not known up front: a
   selective query misses and probes again, so there is no total to divide by.
   Each finished request closes a fixed share of whatever is left, which moves
   steadily, never stalls and never claims to be done before it is.

   ponytail: asymptotic, not a measurement. An exact bar needs the record
   offsets in the posting lists, which is a reindex of a 575 MB file. */
let drawWatcher = null;
let drawing = false;
let drawSteps = 0;

export function onDrawProgress(fn) {
    drawWatcher = fn;
}

function drawStep() {
    if (drawing) drawWatcher?.(1 - 0.7 ** ++drawSteps);
}

/** A random matching post, or null when nothing matches. */
export async function randomPrompt(query) {
    // Nested draws would fight over the bar; the outer one owns it.
    const own = !drawing;
    if (own) {
        drawing = true;
        drawSteps = 0;
        drawWatcher?.(0);
    }
    try {
        return await draw(query);
    } finally {
        if (own) {
            drawing = false;
            drawWatcher?.(1);
        }
    }
}

async function draw(query) {
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
