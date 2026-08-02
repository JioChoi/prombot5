/* Danbooru tag index: ~191k tags, loaded once and searched with native
   String.indexOf over one big joined blob. That is far faster than looping
   191k JS strings per keystroke, and because the blob is built in
   count-descending order, matches come out already ranked by usage. */

const URL = "/tags.csv.gz";

export const CATEGORIES = {
    0: { name: "general", color: "#8fb8ff" },
    1: { name: "artist", color: "#ff8a8a" },
    3: { name: "copyright", color: "#d79bff" },
    4: { name: "character", color: "#7fd7a0" },
    5: { name: "meta", color: "#e0b06a" },
    9: { name: "rating", color: "#9c8fff" },
};

let loading = null;
let index = null;

export function loadTagIndex() {
    loading ??= fetchIndex().then((idx) => (index = idx));
    return loading;
}

export function isReady() {
    return index !== null;
}

async function fetchIndex() {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`tags: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // The server may or may not have already un-gzipped it for us.
    const gzipped = buf[0] === 0x1f && buf[1] === 0x8b;
    const text = gzipped
        ? await new Response(
              new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")),
          ).text()
        : new TextDecoder().decode(buf);
    return build(text);
}

function build(text) {
    const lines = text.split("\n");
    const n = lines.length;
    const names = new Array(n);
    const counts = new Int32Array(n);
    const cats = new Uint8Array(n);
    // Where this tag's posting list lives in postings.bin.
    let size = 0;

    for (let i = 1; i < n; i++) {
        const line = lines[i];
        if (!line) continue;
        const c2 = line.lastIndexOf(",");
        const c1 = line.lastIndexOf(",", c2 - 1);
        let tag = line.slice(0, c1);
        // csv quoting: only tags containing a double quote are quoted
        if (tag.charCodeAt(0) === 34) tag = tag.slice(1, -1).replaceAll('""', '"');
        names[size] = tag;
        counts[size] = +line.slice(c1 + 1, c2);
        cats[size] = +line.slice(c2 + 1);
        size++;
    }
    names.length = size;

    // blob = "\n" + tag0 + "\n" + tag1 + ... so a needle starting with "\n"
    // can only match at a tag boundary — that is the prefix search.
    const offsets = new Int32Array(size);
    let pos = 1;
    for (let i = 0; i < size; i++) {
        offsets[i] = pos;
        pos += names[i].length + 1;
    }
    const blob = "\n" + names.join("\n") + "\n";

    return { names, counts, cats, blob, offsets, size };
}

/** blob char offset -> tag id */
function idAt(idx, pos) {
    const { offsets } = idx;
    let lo = 0;
    let hi = idx.size - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

export function normalize(q) {
    return q.trim().toLowerCase().replaceAll(" ", "_");
}

/**
 * Splits Danbooru's `artist:foo` filter off the front of a query. The prefix may
 * be shortened as long as it still names one category — `char:` and `art:` work,
 * `c:` is ambiguous and is left alone as ordinary text.
 *
 * A bare `artist:` is a valid query: it means "the biggest artist tags", which is
 * how you browse a category you cannot spell yet.
 */
export function parseQuery(query) {
    const colon = query.indexOf(":");
    if (colon < 1) return { cat: null, term: query };

    const prefix = query.slice(0, colon).trim().toLowerCase();
    const named = Object.entries(CATEGORIES).filter(([, c]) => c.name.startsWith(prefix));
    if (named.length !== 1) return { cat: null, term: query };

    return { cat: +named[0][0], term: query.slice(colon + 1) };
}

/**
 * What to put back in front of a completed tag. A `artist:` filter is part of
 * what was written, so completing under it keeps it — except when the tag
 * already carries that namespace itself (the rating tags are literally named
 * `rating:general`), where re-adding it would double the prefix.
 */
export function completionPrefix(token, label) {
    const { cat } = parseQuery(token);
    if (cat === null || parseQuery(label).cat === cat) return "";
    return token.slice(0, token.indexOf(":") + 1);
}

/** Top `limit` tags for `query`, prefix matches first, then substring. */
export function searchTags(query, limit = 5) {
    const idx = index;
    if (!idx) return [];

    const { cat, term } = parseQuery(query);
    const q = normalize(term);
    if (!q && cat === null) return [];

    const hits = [];
    const seen = new Set();

    const take = (id) => {
        if (seen.has(id) || (cat !== null && idx.cats[id] !== cat)) return;
        seen.add(id);
        hits.push({
            id,
            tag: idx.names[id],
            label: idx.names[id].replaceAll("_", " "),
            count: idx.counts[id],
            cat: idx.cats[id],
        });
    };

    // Bare `artist:` — nothing to match on, so walk the index, which is already
    // ordered by count, and take the first tags of that category.
    if (!q) {
        for (let id = 0; id < idx.size && hits.length < limit; id++) take(id);
        return hits;
    }

    const scan = (needle, trim) => {
        let at = idx.blob.indexOf(needle);
        while (at !== -1 && hits.length < limit) {
            take(idAt(idx, at + trim));
            at = idx.blob.indexOf(needle, at + needle.length);
        }
    };

    scan("\n" + q, 1);
    if (hits.length < limit) scan(q, 0);
    return hits;
}

/** The word being typed: everything between the caret and the separator
    (comma or newline) behind it. */
export function activeToken(text, caret) {
    let start = caret;
    while (start > 0) {
        const ch = text.charCodeAt(start - 1);
        if (ch === 44 /* , */ || ch === 10 /* \n */) break;
        start--;
    }
    const raw = text.slice(start, caret);
    // Emphasis brackets belong to the prompt syntax, not to the tag: someone
    // typing `{{blue ey` is still searching for blue_eyes. Skipping them keeps
    // the brackets in place when the completion is accepted, since `start`
    // moves past them.
    const lead = raw.length - raw.replace(/^[\s([{<]+/, "").length;
    return { start: start + lead, end: caret, text: raw.slice(lead) };
}
