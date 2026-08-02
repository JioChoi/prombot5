/* Assembling the text that leaves the app: the user's pinned prompt, the tags
   drawn from the index, and the tail — deduplicated, optionally reordered into
   the order the models were trained on, optionally reformatted.

   Emphasis is carried per tag rather than per group. `{{miku, [1girl]}` reads
   as miku at +2 and 1girl at +1, and comes back out as `{{miku}}, {1girl}` —
   the same weights the user asked for, just no longer sharing brackets, since a
   reordered prompt can't keep a group contiguous. */

import { ARTIST, categoryOf, profileOf } from "./promptIndex.js";

const COPYRIGHT = 3;
const CHARACTER = 4;
const META = 5;
const RATING = 9;

/** `1girl`, `2boys`, `6+others`, `multiple_girls` — how many people are in it. */
const COUNT = /^(\d+\+?|multiple|no)[_ ](girls?|boys?|others?|humans?)$|^\d+\+?(girls?|boys?|others?)$/;

/* Quality words the models want last. They are prompt vocabulary, not danbooru
   tags, so no category lookup will ever place them. */
const QUALITY = new Set([
    "masterpiece", "best quality", "amazing quality", "great quality",
    "good quality", "normal quality", "low quality", "worst quality",
    "very aesthetic", "aesthetic", "high quality", "absurdres", "highres",
    "lowres", "very awa", "incredibly absurdres",
]);

/** Rank of each bucket in the finished prompt. */
const ORDER = { count: 0, character: 1, copyright: 2, artist: 3, other: 4, meta: 5 };

/** What a typed tag is "really" saying, so `(Blue Eyes:1.3)` and `blue_eyes`
    count as the same tag. Weights, wrapping brackets and escapes come off. */
export function keyOf(tag) {
    return tag
        .replace(/^artist:/, "")
        .replace(/\\(.)/g, "$1")
        .replace(/^[([{]+|[)\]}]+$/g, "")
        .replace(/:\s*[\d.]+$/, "")
        .trim()
        .toLowerCase()
        .replaceAll(" ", "_");
}

/**
 * Split a written prompt into tags, each with the net weight of the brackets
 * around it: `{` and `}` count +1, `[` and `]` count -1. Brackets only count as
 * emphasis where a tag could start, so `pom_pom_(clothes)` stays one tag.
 */
export function parsePrompt(text) {
    const out = [];
    let depth = 0;
    let buf = "";

    const flush = () => {
        const tag = buf.trim();
        if (tag) out.push({ tag, weight: depth });
        buf = "";
    };

    for (const ch of text) {
        if ((ch === "{" || ch === "[") && !buf.trim()) {
            depth += ch === "{" ? 1 : -1;
        } else if (ch === "}" || ch === "]") {
            flush();
            depth -= ch === "}" ? 1 : -1;
        } else if (ch === ",") {
            flush();
        } else {
            buf += ch;
        }
    }
    flush();
    return out;
}

/** Tags back to text, each wearing its own brackets. */
export function renderPrompt(entries) {
    return entries
        .map(({ tag, weight }) =>
            weight > 0
                ? "{".repeat(weight) + tag + "}".repeat(weight)
                : weight < 0
                  ? "[".repeat(-weight) + tag + "]".repeat(-weight)
                  : tag,
        )
        .join(", ");
}

/** Danbooru writes underscores; the models read spaces. Kaomoji keep theirs —
    `^_^` and `>_<` are drawn with the underscore. */
function spaced(tag) {
    return /[a-z]/i.test(tag) ? tag.replaceAll("_", " ") : tag;
}

/** Danbooru's rating tags. The category is the reliable signal, but the tags are
    also literally named `rating:general`, which is enough on its own when the
    category never got looked up. */
function isRating(e) {
    return e.cat === RATING || /^rating:/i.test(keyOf(e.tag));
}

/** Which slot a tag sorts into. `cat` is the danbooru category when known. */
function bucket(tag, cat) {
    const key = keyOf(tag);
    if (COUNT.test(key) || key === "solo" || key === "solo_focus") return ORDER.count;
    if (QUALITY.has(key.replaceAll("_", " "))) return ORDER.meta;
    if (cat === CHARACTER) return ORDER.character;
    if (cat === COPYRIGHT) return ORDER.copyright;
    if (cat === ARTIST) return ORDER.artist;
    if (cat === META || cat === RATING) return ORDER.meta;
    return ORDER.other;
}

/**
 * What a named character brings with them: their series, and the traits they
 * wear in most of their pictures. Nothing already in the prompt is repeated,
 * and a character with no profile contributes nothing.
 */
async function fillIn(entries, opts) {
    const present = new Set(entries.map((e) => keyOf(e.tag)));
    const added = [];

    const push = (tag, cat) => {
        if (present.has(tag)) return;
        present.add(tag);
        added.push({ tag, weight: 0, cat });
    };

    for (const e of entries) {
        // a typed character has no category yet; the lookup is cached either way
        e.cat ??= await categoryOf(keyOf(e.tag)).catch(() => undefined);
        if (e.cat !== CHARACTER) continue;
        const profile = await profileOf(keyOf(e.tag)).catch(() => undefined);
        if (!profile) continue;
        if (opts.autoCopyright && profile.series) push(profile.series, COPYRIGHT);
        // The profile is already capped at five per group by the build, and
        // ordered most-characteristic first.
        if (opts.strengthenCharacteristic) for (const t of profile.features) push(t, 0);
        if (opts.strengthenAttire) for (const t of profile.attire) push(t, 0);
    }
    return added;
}

/**
 * The finished prompt.
 *
 * `post` is what randomPrompt returned — tags with their categories. Tags the
 * user already pinned are dropped from the draw, since the pinned copy is the
 * one carrying their weight. Reordering is the only step that needs to know a
 * typed tag's category, so it is the only one that goes looking for it.
 */
export async function buildPrompt({
    beginning,
    ending,
    post,
    reorder,
    reformat,
    dropRating,
    autoCopyright,
    strengthenCharacteristic,
    strengthenAttire,
}) {
    const head = parsePrompt(beginning);
    const tail = parsePrompt(ending);
    const pinned = new Set([...head, ...tail].map((e) => keyOf(e.tag)));

    // Meta is bookkeeping — `commentary_request`, `bad_id`, `absurdres` say
    // something about the upload, not about the picture.
    //
    // dropRating only reaches here, the drawn tags: a `rating:` someone typed
    // into their own prompt is a choice, while a drawn one is whatever the
    // source post happened to be rated.
    const drawn = post.tags
        .map((tag, i) => ({ tag, weight: 0, cat: post.cats[i] }))
        .filter(
            (e) =>
                e.cat !== META &&
                !(dropRating && isRating(e)) &&
                !pinned.has(keyOf(e.tag)),
        );

    let entries = [...head, ...drawn, ...tail];

    if (autoCopyright || strengthenCharacteristic || strengthenAttire) {
        entries = entries.concat(
            await fillIn(entries, {
                autoCopyright,
                strengthenCharacteristic,
                strengthenAttire,
            }),
        );
    }

    if (reorder) {
        // one block fetch per typed tag, and the drawn ones are already cached
        await Promise.all(
            entries.map(async (e) => {
                e.cat ??= await categoryOf(keyOf(e.tag)).catch(() => undefined);
            }),
        );
        // stable, so tags inside a bucket stay in the order they arrived
        entries = entries
            .map((e, i) => [bucket(e.tag, e.cat), i, e])
            .sort((a, b) => a[0] - b[0] || a[1] - b[1])
            .map((r) => r[2]);
    }

    return renderPrompt(
        entries.map((e) => {
            let tag = e.tag;
            if (reformat) {
                if (e.cat === ARTIST && !tag.startsWith("artist:")) tag = `artist:${tag}`;
                tag = tag.startsWith("artist:")
                    ? `artist:${spaced(tag.slice(7))}`
                    : spaced(tag);
            }
            return { tag, weight: e.weight };
        }),
    );
}
