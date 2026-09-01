import assert from "node:assert/strict";
import {
    MISC,
    MISC_LABEL,
    applySort,
    buildIndex,
    portrait,
    searchCharacters,
    searchSeries,
    switchCharacter,
    withTags,
} from "./characters.js";

const profiles = new Map([
    ["hatsune_miku", { series: "vocaloid", features: ["twintails"], attire: [], posts: 130 }],
    ["kagamine_rin", { series: "vocaloid", features: ["blonde_hair"], attire: [], posts: 40 }],
    ["hakurei_reimu", { series: "touhou", features: [], attire: ["hair_bow"], posts: 90 }],
    ["kirisame_marisa", { series: "touhou", features: [], attire: ["witch_hat"], posts: 80 }],
    // The only member of its series, so it is filed under the catch-all group.
    ["lone_wolf", { series: "obscure_ova", features: ["wolf_ears"], attire: [], posts: 10 }],
    // No series at all lands in the same place.
    ["nameless", { series: "", features: [], attire: [], posts: 5 }],
]);

const idx = buildIndex(profiles);

// A one-character series is not its own group; it joins the catch-all with the
// series-less characters, and that group is never labelled after one of them.
const groups = Object.fromEntries(idx.series.map((g) => [g.key, g]));
assert.deepEqual(Object.keys(groups).sort(), [MISC, "touhou", "vocaloid"]);
assert.equal(groups[MISC].count, 2);
assert.equal(groups[MISC].label, MISC_LABEL);
assert.equal(groups.vocaloid.count, 2);

// A series is as popular as its most-drawn member, not the sum, and that member
// is the one whose picture the series tile wears.
assert.equal(groups.vocaloid.posts, 130);
assert.equal(groups.vocaloid.cover, "hatsune_miku");
assert.equal(groups.touhou.posts, 90);
assert.equal(groups.touhou.cover, "hakurei_reimu");
// Every group has a cover even when nobody in it has a post count to rank by.
assert.ok(groups[MISC].cover);

// Filenames are the tag, and `/` is the one character that cannot survive as
// one — pick_picture.py writes it as `_`, so the URL has to match.
// The initial is a directory: a git repo holds 10k files per directory and
// there are 17.9k pictures.
assert.ok(portrait("hatsune_miku").endsWith("/h/hatsune_miku.webp"));
// Anything that is not a letter or digit shares one bucket.
assert.ok(portrait("(o)_(o)").includes("/_/"));
assert.ok(portrait("k/da_kai'sa").endsWith("/k/k_da_kai'sa.webp"));
assert.ok(portrait("2b_(nier:automata)").endsWith("/2/2b_(nier_automata).webp"));
// A leading `<letter>:` reads as a URI scheme, so the path stops being relative.
assert.ok(portrait("i:p_masquerena").endsWith("/i/i_p_masquerena.webp"));
// A name ending in a dot would otherwise build `c.c..webp`, and `..` in a path
// is refused by the store the pictures are served from.
assert.ok(portrait("c.c.").endsWith("/c/c.c.webp"));
assert.ok(portrait("f.l.u.d.d.").endsWith("/f/f.l.u.d.d.webp"));
assert.ok(
    portrait("biwa_hayahide_(pf._winning_equation...)_(umamusume)").endsWith(
        "/b/biwa_hayahide_(pf._winning_equation.)_(umamusume).webp",
    ),
);
// Single dots inside a name are ordinary and must survive untouched.
assert.ok(portrait("a.b.a").endsWith("/a/a.b.a.webp"));

// Search reaches name, series, feature and attire alike.
const names = (q) => searchCharacters(idx, q).map((c) => c.name).sort();
assert.deepEqual(names("miku"), ["hatsune_miku"]);
assert.deepEqual(names("touhou"), ["hakurei_reimu", "kirisame_marisa"]);
assert.deepEqual(names("witch hat"), ["kirisame_marisa"]);
assert.deepEqual(names("twintails"), ["hatsune_miku"]);
// Underscores in the query are the same as spaces — tags are written both ways.
assert.deepEqual(names("witch_hat"), ["kirisame_marisa"]);
// An empty query is not a filter.
assert.equal(searchCharacters(idx, "  ").length, 6);

// A series matches on its own name *or* on any member, so searching a character
// still surfaces the group they are in.
// Series match on the series name alone — a member's name reaches the member.
assert.deepEqual(searchSeries(idx, "marisa").map((g) => g.key), []);
assert.deepEqual(
    searchSeries(idx, "vocal").map((g) => g.key),
    ["vocaloid"],
);
// The catch-all has no name of its own, so nothing reaches it.
assert.deepEqual(searchSeries(idx, "other").map((g) => g.key), []);
assert.deepEqual(searchSeries(idx, "wolf ears").map((g) => g.key), []);

// Sorting never mutates what it was handed.
const before = idx.list.map((c) => c.name);
const desc = applySort(idx.list, "popular", new Set()).map((c) => c.name);
assert.deepEqual(idx.list.map((c) => c.name), before);
assert.equal(desc[0], "hatsune_miku");
assert.equal(desc.at(-1), "nameless");
assert.deepEqual(applySort(idx.list, "unpopular", new Set()).map((c) => c.name), [...desc].reverse());
assert.equal(applySort(idx.list, "name", new Set())[0].label, "hakurei reimu");
assert.equal(applySort(idx.list, "name-desc", new Set())[0].label, "nameless");

// "Favorites" is a filter wearing a sort's clothes — it must drop the rest.
const favs = new Set(["kagamine_rin", "hakurei_reimu"]);
assert.deepEqual(
    applySort(idx.list, "favorites", favs).map((c) => c.name),
    ["hakurei_reimu", "kagamine_rin"],
);
// A series survives that filter when any one of its members is favorited.
assert.deepEqual(
    applySort(idx.series, "favorites", favs).map((g) => g.key).sort(),
    ["touhou", "vocaloid"],
);

// Copying with tags puts the readable name first, then its traits.
assert.equal(withTags(idx.list[2]), "hakurei reimu, hair bow");

// Switching recasts the first slot: the name goes, the traits and the slot's
// own fields stay, and later slots are untouched.
const charNames = new Set(idx.list.map((c) => c.name));
const cast = [
    { id: 1, text: "hakurei reimu, smile, hair bow", negative: "blurry", x: 2, y: 3 },
    { id: 2, text: "kagamine rin", negative: "" },
];
const switched = switchCharacter(cast, "hatsune miku", charNames);
assert.deepEqual(switched[0], {
    id: 1,
    text: "hatsune miku, smile, hair bow",
    negative: "blurry",
    x: 2,
    y: 3,
});
assert.equal(switched[1], cast[1]);
assert.equal(cast[0].text, "hakurei reimu, smile, hair bow");

// The character need not lead, and its brackets belong to the slot, not to it.
assert.equal(
    switchCharacter([{ text: "smile, [[kirisame marisa]], witch hat" }], "hatsune miku", charNames)[0]
        .text,
    "smile, [[hatsune miku]], witch hat",
);

// A slot naming nobody gets the name put in front rather than losing its traits.
assert.equal(
    switchCharacter([{ text: "smile, witch hat" }], "hatsune miku", charNames)[0].text,
    "hatsune miku, smile, witch hat",
);

// Everyone in the slot goes, not only the first: a two-hander must not keep
// its second character after being switched to somebody else.
assert.equal(
    switchCharacter(
        [{ text: "hakurei reimu, smile, kirisame marisa, witch hat" }],
        "hatsune miku",
        charNames,
    )[0].text,
    "hatsune miku, smile, witch hat",
);

// The parentheses in a disambiguated name are part of it, not emphasis round it,
// so it has to be recognised as the character in the slot like any other name.
const disambiguated = new Set([...charNames, "leaf_(pokemon)"]);
assert.equal(
    switchCharacter([{ text: "leaf (pokemon), smile" }], "hatsune miku", disambiguated)[0].text,
    "hatsune miku, smile",
);
assert.equal(
    switchCharacter([{ text: "[[leaf (pokemon)]], smile" }], "hatsune miku", disambiguated)[0].text,
    "[[hatsune miku]], smile",
);

// Nothing to switch: the caller creates a slot instead.
assert.equal(switchCharacter([], "hatsune miku", charNames), null);

console.log("ok");
