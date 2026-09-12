/* Tags that only make sense over a garment: `skirt_lift` needs a `skirt`,
   `open_clothes` needs something to be open. The draw hands back whatever the
   source post wore, but the attire pill and the omit list can take the garment
   out from under such a tag — leaving a prompt that asks for a lifted skirt on
   someone wearing none. build_groups.py writes the requirements to
   tag-requires.csv.gz; this decides which drawn tags no longer stand up. */

/** Nothing is worn, so nothing can be lifted, pulled or opened. */
const NUDE = new Set(["nude", "completely_nude"]);

/** "any garment at all", as opposed to a named one. */
const GENERIC = new Set(["clothes", "clothing"]);

/**
 * A predicate over the whole prompt: `unmet(tag)` is true when `tag` requires a
 * garment nothing in `tags` provides.
 *
 * `tags` is every tag the prompt ends up with — pinned, character captions and
 * the drawn ones that survived the pills — as plain keys. Requiring tags never
 * count as the garment themselves: `bra_lift` is filed under attire, but a bra
 * being lifted is not a second bra for `open_clothes` to open.
 */
export function unmetRequirement(tags, requires, groups) {
    const worn = [...tags].filter((t) => !requires.has(t));
    const bare = worn.some((t) => NUDE.has(t));
    const dressed = !bare && worn.some((t) => (groups.get(t) ?? []).includes("attire"));

    // `dress` is also worn as `red_dress`; `panties` is not worn as `no_panties`
    const has = (a) => worn.some((t) => t === a || t.endsWith("_" + a));

    return (tag) => {
        const need = requires.get(tag);
        if (!need) return false;
        return !need.some((a) => (GENERIC.has(a) ? dressed : !bare && has(a)));
    };
}
