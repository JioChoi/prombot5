/* The character browser's data layer: one pass over the profile Map turns it
   into a flat list, a per-character search string, and the series grouping the
   list view walks. Everything below is a pure function of that index so the
   component can memo it and the tests can call it without a fetch.

   Searching is a plain substring scan over 19k pre-lowered strings — about a
   millisecond, which is under a keystroke. The blob+indexOf trick tagIndex uses
   only starts paying off an order of magnitude further up.
   ponytail: linear scan, swap in tagIndex's blob scan if the list ever grows
   past ~100k characters. */

import { keyOf, parsePrompt, renderPrompt } from "./prompt.js";
import { allProfiles } from "./promptIndex.js";

/** Characters whose series has no one else in it are collected here rather than
    left as a screenful of one-entry groups. */
export const MISC = "\0misc";
export const MISC_LABEL = "Other series";

export const SORTS = [
    { value: "popular", label: "Most popular" },
    { value: "unpopular", label: "Least popular" },
    { value: "name", label: "Name A–Z" },
    { value: "name-desc", label: "Name Z–A" },
    { value: "favorites", label: "Favorites only" },
];

/** Tag form -> what a person reads, and what goes into a prompt. */
export const pretty = (tag) => tag.replaceAll("_", " ");

/* The reference pictures pick_picture.py chose: one webp per character, ~20 KB,
   17.9k of them. Far too much to ship with the site, so they sit beside the
   index on the data host. About 1.3k characters have no usable picture and the
   tiles fall back to a plate; a 404 is the only way to find that out, which is
   why nothing here tries to know in advance. */
const IMAGES = `${import.meta.env?.VITE_DATA ?? ""}/character-images`;

/**
 * Where a character's reference picture lives. This has to reproduce
 * pick_picture.py's repo_path() exactly, and both are shaped by what the store
 * serving these files will accept.
 *
 * Three rewrites make the filename: a slash is a directory (lancelot_(fate/zero)),
 * a colon is a URI scheme — `i:p_masquerena.webp` is not a relative path at all
 * — and a run of dots is traversal, since `c.c.` + `.webp` is `c.c..webp`.
 *
 * Then the initial is a directory, because a git repo holds at most 10k files
 * per directory and there are 17.9k pictures. Bucketing by first character
 * splits them into 34 (largest ~2k), which is a rule both sides can apply
 * without agreeing on a hash.
 */
export function portrait(name) {
    const stem = name.replaceAll("/", "_").replaceAll(":", "_");
    const file = `${stem}.webp`.replace(/\.{2,}/g, ".");
    const head = file[0].toLowerCase();
    const bucket = /[a-z0-9]/.test(head) ? head : "_";
    return `${IMAGES}/${bucket}/${encodeURIComponent(file)}`;
}

let building = null;

/** The index, built once per page load. */
export function loadCharacters() {
    building ??= allProfiles().then(buildIndex);
    return building;
}

/**
 * `{ list, series }`. `list` is every character with the fields the cards show
 * plus `hay`, the lowercased haystack search matches against. `series` is one
 * entry per group, already carrying the numbers the sorts need, so sorting the
 * series list never has to walk its members again.
 */
export function buildIndex(profiles) {
    const list = [];
    for (const [name, p] of profiles) {
        const label = pretty(name);
        const series = pretty(p.series || "");
        const features = p.features.map(pretty);
        const attire = p.attire.map(pretty);
        list.push({
            name,
            label,
            seriesKey: p.series || "",
            series,
            features,
            attire,
            posts: p.posts || 0,
            // Everything the search is allowed to match, in one string. Built
            // here, once, rather than re-joined on every keystroke.
            hay: `${label} ${series} ${features.join(" ")} ${attire.join(" ")}`.toLowerCase(),
        });
    }

    // Two passes: how many share a series decides whether the series is its own
    // group, and only then can members be filed under the right key.
    const sizes = new Map();
    for (const c of list) {
        if (c.seriesKey) sizes.set(c.seriesKey, (sizes.get(c.seriesKey) ?? 0) + 1);
    }

    const series = new Map();
    for (const c of list) {
        const solo = !c.seriesKey || sizes.get(c.seriesKey) === 1;
        c.group = solo ? MISC : c.seriesKey;
        let g = series.get(c.group);
        if (!g) {
            g = {
                key: c.group,
                label: solo ? MISC_LABEL : c.series,
                members: [],
                count: 0,
                // A series is as popular as its most-drawn character, and wears
                // that character's picture on its tile.
                posts: 0,
                cover: "",
            };
            series.set(c.group, g);
        }
        g.members.push(c);
        g.count++;
        if (c.posts > g.posts || !g.cover) {
            g.posts = Math.max(g.posts, c.posts);
            g.cover = c.name;
        }
    }

    return { list, series: [...series.values()] };
}

/** Query -> what `hay` is compared against; "" means "match everything". */
export function normalize(q) {
    return q.trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
}

/** Characters matching `q` across name, series, features and attire. */
export function searchCharacters(index, q) {
    const needle = normalize(q);
    if (!needle) return index.list;
    return index.list.filter((c) => c.hay.includes(needle));
}

/**
 * Sorts a list of characters or of series in place-safe fashion (a copy).
 * `favorites` is a Set of character names; the "favorites" sort is a filter,
 * which is what makes it usable from the same menu as the orderings.
 */
export function applySort(items, sort, favorites) {
    const isFav = (it) =>
        it.members ? it.members.some((m) => favorites.has(m.name)) : favorites.has(it.name);

    if (sort === "favorites") {
        return items.filter(isFav).sort((a, b) => b.posts - a.posts);
    }
    const by = {
        popular: (a, b) => b.posts - a.posts,
        unpopular: (a, b) => a.posts - b.posts,
        name: (a, b) => a.label.localeCompare(b.label),
        "name-desc": (a, b) => b.label.localeCompare(a.label),
    }[sort];
    return [...items].sort(by ?? (() => 0));
}

/** Groups matching `q` by their own name only — a member's name reaches that
    member, which the character results already show. The catch-all has no name
    of its own, so it never matches. */
export function searchSeries(index, q) {
    const needle = normalize(q);
    if (!needle) return index.series;
    return index.series.filter(
        (g) => g.key !== MISC && g.label.toLowerCase().includes(needle),
    );
}

/** What "copy name with tags" puts on the clipboard. */
export function withTags(c) {
    return [c.label, ...c.features, ...c.attire].join(", ");
}

/**
 * Swap whoever the first character slot names for `label`.
 *
 * A character slot is a prompt like `hakurei reimu, smile, hair bow`: one
 * character tag and the traits around it. Switching keeps the traits and takes
 * the people out — *every* known character name in the slot, not only the first,
 * or switching a two-hander would quietly leave the second person in. The new
 * name lands where the first one stood, wearing that tag's brackets, since the
 * weight belonged to the slot and not to whoever was in it. A slot naming nobody
 * gets the name put in front, and no slots at all means there is nothing to
 * switch: the caller creates one.
 *
 * `names` is the set of underscore-form character names, i.e. `index.list`
 * mapped by `name`.
 */
export function switchCharacter(characters, label, names) {
    const [first, ...rest] = characters;
    if (!first) return null;

    const entries = parsePrompt(first.text);
    const at = entries.findIndex((e) => names.has(keyOf(e.tag)));
    const kept = entries.filter((e) => !names.has(keyOf(e.tag)));
    kept.splice(at < 0 ? 0 : at, 0, { tag: label, weight: at < 0 ? 0 : entries[at].weight });

    return [{ ...first, text: renderPrompt(kept) }, ...rest];
}
