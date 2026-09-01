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

/* Every danbooru tag that means "something is covering it up". Drawn tags are
   whatever the source post wore, so a prompt that asks for `uncensored` can
   still come back with `mosaic_censoring` from the draw — these come out when
   it does. Copied from censor.dat; small and static, so it travels with the
   code rather than costing a fetch. */
const CENSOR = new Set([
    "censored", "bar_censor", "blank_censor", "blur_censor", "glitch_censor",
    "heart_censor", "light_censor", "mosaic_censoring", "novelty_censor",
    "character_censor", "censored_by_text", "flower_censor", "interface_censor",
    "emoji_censor", "convenient_censoring", "hair_censor", "tail_censor",
    "out-of-frame_censoring", "pointless_censoring", "censored_with_cum",
    "ribbon_censor", "steam_censor", "censored_nipples", "identity_censor",
    "soap_censor", "censored_text", "transparent_censoring", "scribble_censor",
    "star_censor", "censored_food", "fake_censor", "censored_gesture",
    "wing_censor", "censored_anus", "censored_violence", "tape_censor",
    "water_censor", "petal_censor", "censored_feet", "removable_censorship",
    "leaf_censor", "censored_testicles", "censored_profanity",
    "speech_bubble_censor", "sparkle_censor", "patreon_logo_censor",
    "feather_censor", "necklace_censor", "shadow_censor", "censored_urethra",
    "inconsistent_censoring", "censored_clitoris", "blood_censor",
    "treasure_mark_censor",
]);

/** Rank of each bucket in the finished prompt. */
const ORDER = { count: 0, character: 1, copyright: 2, artist: 3, other: 4, meta: 5 };

/** Which closer a bracket is looking for. */
const CLOSER = { "(": ")", "[": "]", "{": "}" };

/** What a typed tag is "really" saying, so `(Blue Eyes:1.3)` and `blue_eyes`
    count as the same tag. Weights, wrapping brackets and escapes come off. */
export function keyOf(tag) {
    let key = tag
        .replace(/^artist:/, "")
        .replace(/\\(.)/g, "$1")
        .trim();

    /* Emphasis comes off a pair at a time, and only where the tag actually
       opens with a bracket. Taking a closer off the end on its own would eat
       the disambiguator half of a name — `leaf (pokemon)` is who the character
       is, not a bracket somebody put round `leaf`. */
    while (key.length > 1 && CLOSER[key[0]] === key.at(-1)) key = key.slice(1, -1).trim();

    return key
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
 * What no tag is allowed to be — whether it was drawn or filled in.
 *
 * Asking for a tag and asking against it is the same contradiction wherever
 * the request came from, and `uncensored` anywhere — pinned text or a
 * character's own caption — rules out the whole censor list.
 */
function bans({ negative = "", beginning = "", ending = "", characters = [] }) {
    const banned = new Set(parsePrompt(negative).map((e) => keyOf(e.tag)));
    const asked = [beginning, ending, ...characters.map((c) => c.text ?? "")];
    if (asked.some((t) => parsePrompt(t).some((e) => keyOf(e.tag) === "uncensored"))) {
        for (const t of CENSOR) banned.add(t);
    }
    return banned;
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
        if (present.has(tag) || opts.banned.has(tag)) return;
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
 *
 * `negative` and the character captions never reach the output; they are read
 * for what they rule out — anything in the negative prompt, and the censor
 * tags when anyone asked for `uncensored`. Filling *them* in is a separate
 * job, since they leave the app as their own fields: see fillCharacters.
 */
export async function buildPrompt({
    beginning = "",
    ending = "",
    negative = "",
    characters = [],
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

    const banned = bans({ negative, beginning, ending, characters });

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
                !pinned.has(keyOf(e.tag)) &&
                !banned.has(keyOf(e.tag)),
        );

    let entries = [...head, ...drawn, ...tail];

    if (autoCopyright || strengthenCharacteristic || strengthenAttire) {
        entries = entries.concat(
            await fillIn(entries, {
                autoCopyright,
                strengthenCharacteristic,
                strengthenAttire,
                banned,
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

/**
 * The cast, each caption filled in from whoever it names.
 *
 * The base prompt is filled in by buildPrompt above, but a character's own
 * caption is a second place a name can appear — and for a multi-character
 * image it is the *only* place, since that is where NovelAI reads who is who.
 * A caption naming Sakuya gets her maid headdress in her own caption, not in
 * the base one, or every character in the picture would end up wearing it.
 *
 * Captions are appended to rather than re-rendered: what someone typed is
 * theirs, down to the spacing. Returns the same objects when nothing is added,
 * so positions and ids ride through untouched.
 */
export async function fillCharacters(characters, opts) {
    if (!opts.autoCopyright && !opts.strengthenCharacteristic && !opts.strengthenAttire) {
        return characters;
    }
    const banned = bans({ ...opts, characters });
    return Promise.all(
        characters.map(async (c) => {
            const text = c.text ?? "";
            const added = await fillIn(parsePrompt(text), { ...opts, banned });
            if (!added.length) return c;
            const tags = added.map((e) => (opts.reformat ? spaced(e.tag) : e.tag));
            const head = text.trim().replace(/,+$/, "").trim();
            return { ...c, text: head ? `${head}, ${tags.join(", ")}` : tags.join(", ") };
        }),
    );
}
