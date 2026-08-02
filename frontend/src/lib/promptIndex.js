/* How many posts match a filter, without downloading the corpus.

   Posts are numbered by fav_count descending, so a score floor is just a
   prefix of every posting list. Every file here is read by range request and
   nothing is downloaded whole: the dictionary, the posting lists and the post
   records are all blocked so a query pays for the blocks it touches. Files come
   from build_index.py and build_dict.py. */

const LOOKUP_URL = "/tag-lookup.bin";
const LOOKUP_IDX_URL = "/tag-lookup.json.gz";
const NAMES_URL = "/tag-names.bin";
const NAMES_IDX_URL = "/tag-names.idx";
const META_URL = "/prompts.json";
// tags per block in both dictionary files; must match build_dict.BLOCK
const BLOCK = 256;
const POSTINGS_URL = "/postings.bin";
const PROMPTS_URL = "/prompts.bin";
const OFFSETS_URL = "/prompts.idx";
const GROUPS_URL = "/tag-groups.csv.gz";
const PROFILES_URL = "/characters.csv.gz";
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
const dict = new Map(); // tag -> [offset, length, postings, category]
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

/** [offset, length, postings, category], or undefined for an unknown tag. */
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
            // tag,count,off,len,cat — read from the right, tag names hold commas
            const f = line.split(",");
            dict.set(f.slice(0, -4).join(","), [
                +f.at(-3), +f.at(-2), +f.at(-4), +f.at(-1),
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
    const b = Math.floor(id / BLOCK);
    await once(`n${b}`, async () => {
        const body = decode(await range(NAMES_URL, namesIdx[b], namesIdx[b + 1] - 1));
        let at = b * BLOCK;
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
const CHUNK = 1 << 20;

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

    while (i < count) {
        if (at + 10 > bytes.length && read < len) {
            // keep the undecoded tail, it may hold a split varint
            const want = Math.min(CHUNK, len - read);
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

export async function countPrompts(query) {
    // The dictionary already knows how many posts carry a tag. With no floor
    // and nothing to intersect, that number *is* the answer — no posting list.
    const { include = [], exclude = [], minScore = 0 } = query;
    if (include.length === 1 && !exclude.length && !minScore) {
        return (await entry(include[0]))?.[2] ?? 0;
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

/** One post's record, pulled with two range requests and nothing else. */
async function record(post) {
    // prompts.idx is uint32 LE with a trailing entry, so the pair brackets the
    // record's bytes.
    const ends = await range(OFFSETS_URL, post * 4, post * 4 + 7);
    const view = new DataView(ends.buffer, ends.byteOffset, 8);
    const from = view.getUint32(0, true);
    const to = view.getUint32(4, true);

    const bytes = await range(PROMPTS_URL, from, to - 1);
    let at = 0;
    let fav, id, count;
    [fav, at] = varint(bytes, at);
    [id, at] = varint(bytes, at);
    [count, at] = varint(bytes, at);

    const ids = [];
    let tagId = 0;
    for (let i = 0; i < count; i++) {
        let gap;
        [gap, at] = varint(bytes, at);
        ids.push((tagId += gap));
    }
    // Ids are count-descending, so a prompt's tags sit in a handful of blocks,
    // usually the first ones — after the first prompt these are all cache hits.
    const named = await Promise.all(ids.map(name));
    return { post, id, fav, tags: named.map((n) => n[0]), cats: named.map((n) => n[1]) };
}

/** A random matching post, or null when nothing matches. */
export async function randomPrompt(query) {
    const { limit, hits, excluded } = await select(query);
    const total = hits ? hits.length : limit - excluded.length;
    if (total <= 0) return null;
    const k = Math.floor(Math.random() * total);
    const post = await record(hits ? hits[k] : skipping(k, excluded));

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
