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
const GROUPS_URL = `${DATA}/tag-groups.csv.gz`;
/* 6 KB, and read on every draw rather than only when a pill is off, so it
   travels with the site like characters.csv.gz does. */
const REQUIRES_URL = "/tag-requires.csv.gz";
/* The one data file small enough to travel with the site (540 KB), and the one
   that has to move in lockstep with the code that reads it — the column list
   has changed once already. Same-origin, so a stale copy on the data host can
   never shift its fields out from under this. */
const PROFILES_URL = "/characters.csv.gz";
// danbooru category ids; the client only cares which tags are artists
export const ARTIST = 1;

let loadingDict = null;
let loadingGroups = null;
let loadingRequires = null;
let loadingProfiles = null;
const dict = new Map(); // tag -> [offset, length, postings, category]
const groups = new Map(); // tag -> ["attire", "nsfw", ...]
const requires = new Map(); // tag -> ["skirt", ...] — garments it needs worn
const profiles = new Map(); // character -> { series, features, attire }

export function warmPromptIndex() {
    return Promise.all([loadDict(), loadGroups(), loadProfiles()]);
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
            // tag,count,off,len,cat,id — read from the right, tag names hold commas.
            // The id is the record's own way of naming a tag; records are the
            // server's business now, so only the count columns are kept.
            const f = line.split(",");
            const tag = f.slice(0, -5).join(",");
            dict.set(tag, [+f.at(-4), +f.at(-3), +f.at(-5), +f.at(-2)]);
        }
    });
    return loadingDict;
}

/** [offset, length, postings, category], or undefined for an unknown tag. */
async function entry(tag) {
    await loadDict();
    return dict.get(tag);
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

/* What a tag needs already worn: `skirt_lift` -> ["skirt"]. Written by
   build_groups.py off working/tags/requiring.txt. */
function loadRequires() {
    loadingRequires ??= text(REQUIRES_URL).then((csv) => {
        for (const line of csv.split("\n").slice(1)) {
            if (!line) continue;
            const cut = line.lastIndexOf(",");
            requires.set(line.slice(0, cut), line.slice(cut + 1).split(" "));
        }
    });
    return loadingRequires;
}

/**
 * The two tables buildPrompt needs to drop a `skirt_lift` with no skirt under
 * it: what each tag requires, and which tags are garments. Both are cached, so
 * the cost is one fetch each for the life of the page.
 */
export async function wardrobe() {
    await Promise.all([loadRequires(), loadGroups()]);
    return { requires, groups };
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

/** A typed tag list as the index spells tags: lowercase, underscored. */
export function splitTags(text) {
    return text
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase().replaceAll(" ", "_"))
        .filter(Boolean);
}

function contradicts({ include = [], exclude = [] }) {
    return include.some((tag) => exclude.includes(tag));
}

/* The draw itself happens on the server: it holds the index on local disk,
   so a prompt is one request rather than the dozens of ranged reads a
   client-side sample took. It draws and nothing else — every filter below,
   and everything prompt.js does afterwards, still happens here.

   The key identifies the caller for the server's rate limit, and the server
   refuses without one. It is the same key generation uses; it is hashed there
   and never stored. */
const API = import.meta.env?.VITE_API ?? "";

/* The bar behind a draw. One request now, so it has two positions rather than
   an asymptote: started, and done. */
let drawWatcher = null;

export function onDrawProgress(fn) {
    drawWatcher = fn;
}

/** The query as the server takes it. */
function params(query) {
    return new URLSearchParams({
        include: (query.include ?? []).join(","),
        exclude: (query.exclude ?? []).join(","),
        minScore: String(query.minScore ?? 0),
    });
}

/**
 * A GET against the draw API, as the caller's key.
 *
 * A header value the browser refuses — a key pasted with a newline in it — is
 * rejected before the request leaves, and iOS Safari reports that as "The
 * string did not match the expected pattern", which names neither the key nor
 * the step. So the key is trimmed, and a throw from `fetch` is renamed.
 */
async function ask(path, query, token, retried = false) {
    const key = (token ?? "").trim();
    if (!key) throw new Error("Log in with your NovelAI key to use the generator");
    let res;
    try {
        res = await fetch(`${API}${path}?${params(query)}`, {
            headers: { Authorization: `Bearer ${key}` },
        });
    } catch (e) {
        throw new Error(`Request rejected by the browser: ${e.name}: ${e.message}`);
    }
    // An empty pool is 204; a 404 means this build of the server has no such
    // route, which is a different problem with a different fix.
    if (res.status === 204) return null;
    // The server allows one draw every few seconds. Waiting it out is what the
    // caller would do anyway, and it keeps an unattended loop running instead
    // of ending it over a limit that clears itself.
    if (res.status === 429) {
        const after = Number(res.headers.get("retry-after"));
        if (Number.isFinite(after) && after > 0 && after <= 30 && !retried) {
            await new Promise((r) => setTimeout(r, after * 1000));
            return ask(path, query, token, true);
        }
    }
    if (res.ok) {
        // A server without this endpoint may answer the SPA's index.html with a
        // 200. Parsing that as JSON throws a message about strings and patterns
        // that says nothing about the real problem, so check first.
        const kind = res.headers.get("content-type") ?? "";
        if (!kind.includes("json")) {
            throw new Error(`${path} answered ${kind || "no type"} — is the backend up to date?`);
        }
        return res.json();
    }
    const why = await res.json().catch(() => ({}));
    throw new Error(why.detail || `Request failed (${res.status})`);
}

/**
 * How many posts a query draws from: `{ n, exact }`.
 *
 * Exact where the server could intersect the posting lists, sampled where they
 * were too long for that — which the sheet shows as "about N".
 */
export async function promptCount(query, token) {
    if (contradicts(query)) return { n: 0, exact: true };
    return ask("/api/prompt-count", query, token);
}

/** A random matching post, or null when nothing matches. */
export async function randomPrompt(query, token) {
    drawWatcher?.(0);
    try {
        // No post can both contain and not contain a tag, and the server would
        // spend its whole budget proving it.
        if (contradicts(query)) return null;
        const post = await ask("/api/prompt", query, token);
        return post && (await filtered(post, query));
    } finally {
        drawWatcher?.(1);
    }
}

/**
 * The drawn post with the switched-off tag types taken out.
 *
 * A switched-off type thins the prompt; it never rejects the post, so the count
 * in the sheet stays the count the user gets. Two kinds of switch, cutting on
 * different things: characters, artists and series are danbooru categories
 * carried on the record itself, while attire/features/expressions/nsfw are
 * subsets that only tag-groups knows about — which is why that file is fetched
 * only when one is off.
 */
async function filtered(post, query) {
    const drop = query.drop ?? [];
    const dropCats = query.dropCats ?? [];
    if (!drop.length && !dropCats.length) return post;
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
    scene: "scene",
    object: "object",
    // an art-style tag names the look an artist draws in, so it goes with them
    artist: "style",
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
