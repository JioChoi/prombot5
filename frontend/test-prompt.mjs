/* Checks prompt assembly — parsing weights, dedupe, reorder, reformat — with a
   stubbed category lookup, so it runs without the index files.

       node test-prompt.mjs
*/

import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

// promptIndex reaches for fetch at call time only, but importing it pulls in
// nothing else, so a tiny stub of categoryOf keeps this test offline.
const CATS = {
    hatsune_miku: 4, izayoi_sakuya: 4, vocaloid: 3, touhou: 3, as109: 1, wlop: 1,
    blue_eyes: 0, cat_girl: 0, highres: 5, "rating:general": 9, smile: 0,
};
const PROFILES = {
    hatsune_miku: {
        series: "vocaloid",
        features: ["long_hair", "twintails", "very_long_hair", "aqua_hair"],
        attire: ["thighhighs", "detached_sleeves"],
    },
    izayoi_sakuya: { series: "touhou", features: ["grey_hair"], attire: ["maid_headdress"] },
};
const src = readFileSync(new URL("./src/lib/prompt.js", import.meta.url), "utf8");
const stub = src.replace(
    'import { ARTIST, categoryOf, profileOf } from "./promptIndex.js";',
    `const ARTIST = 1;
     const CATS = ${JSON.stringify(CATS)};
     const PROFILES = ${JSON.stringify(PROFILES)};
     const categoryOf = async (t) => CATS[t];
     const profileOf = async (c) => PROFILES[c];`,
);
const tmp = new URL("./.prompt-under-test.mjs", import.meta.url);
writeFileSync(tmp, stub);
const { parsePrompt, renderPrompt, buildPrompt } = await import(tmp.href);

// meta tags are dropped from the draw, whatever the ordering
assert.equal(
    await buildPrompt({
        beginning: "", ending: "",
        post: { tags: ["1girl", "highres", "absurdres"], cats: [0, 5, 5] },
        reorder: false, reformat: false,
    }),
    "1girl",
);

// weights survive a round trip, nested groups included
assert.deepEqual(parsePrompt("{{miku, [1girl, best quality]}"), [
    { tag: "miku", weight: 2 },
    { tag: "1girl", weight: 1 },
    { tag: "best quality", weight: 1 },
]);
assert.equal(renderPrompt(parsePrompt("{a}, [[b]], c")), "{a}, [[b]], c");
// a tag's own parentheses are not emphasis
assert.deepEqual(parsePrompt("pom_pom_(clothes), (smile:1.2)"), [
    { tag: "pom_pom_(clothes)", weight: 0 },
    { tag: "(smile:1.2)", weight: 0 },
]);

const post = {
    tags: ["blue_eyes", "hatsune_miku", "highres", "as109", "vocaloid", "1girl", "smile"],
    cats: [0, 4, 5, 1, 3, 0, 0],
};

// the order the models were trained on: count, character, series, artist, the
// rest, meta last
assert.equal(
    await buildPrompt({ beginning: "", ending: "", post, reorder: true, reformat: false }),
    "1girl, hatsune_miku, vocaloid, as109, blue_eyes, smile",
);

// reformat: spaces, artist label, one separator style
assert.equal(
    await buildPrompt({ beginning: "", ending: "", post, reorder: true, reformat: true }),
    "1girl, hatsune miku, vocaloid, artist:as109, blue eyes, smile",
);

// the user's own example, weights kept per tag
assert.equal(
    await buildPrompt({
        beginning: "{{hatsune_miku, [1girl, best quality]}",
        ending: "",
        post: { tags: [], cats: [] },
        reorder: true,
        reformat: false,
    }),
    "{1girl}, {{hatsune_miku}}, {best quality}",
);

// a pinned tag wins, and the draw does not repeat it
assert.equal(
    await buildPrompt({
        beginning: "{{blue_eyes}}",
        ending: "masterpiece",
        post: { tags: ["blue_eyes", "1girl"], cats: [0, 0] },
        reorder: true,
        reformat: false,
    }),
    "1girl, {{blue_eyes}}, masterpiece",
);

// reorder off: pinned text, then the draw, then the tail — untouched
assert.equal(
    await buildPrompt({
        beginning: "masterpiece",
        ending: "highres",
        post: { tags: ["1girl", "smile"], cats: [0, 0] },
        reorder: false,
        reformat: false,
    }),
    "masterpiece, 1girl, smile, highres",
);

// kaomoji keep their underscores when reformatting
assert.equal(
    await buildPrompt({
        beginning: "",
        ending: "",
        post: { tags: ["^_^", ">_<", "cat_girl"], cats: [0, 0, 0] },
        reorder: false,
        reformat: true,
    }),
    "^_^, >_<, cat girl",
);

// auto copyright: the series comes along with the character, once
assert.equal(
    await buildPrompt({
        beginning: "hatsune_miku", ending: "",
        post: { tags: ["1girl"], cats: [0] },
        reorder: true, reformat: false, autoCopyright: true,
    }),
    "1girl, hatsune_miku, vocaloid",
);

// strengthening fills in the canonical look, capped by the profile itself
assert.equal(
    await buildPrompt({
        beginning: "hatsune_miku", ending: "",
        post: { tags: ["1girl"], cats: [0] },
        reorder: true, reformat: false,
        strengthenCharacteristic: true, strengthenAttire: true,
    }),
    "1girl, hatsune_miku, long_hair, twintails, very_long_hair, aqua_hair, " +
        "thighhighs, detached_sleeves",
);

// nothing already in the prompt is repeated, and weights on it survive
assert.equal(
    await buildPrompt({
        beginning: "{{izayoi_sakuya}}, [grey_hair]", ending: "",
        post: { tags: ["maid_headdress"], cats: [0] },
        reorder: false, reformat: false,
        autoCopyright: true, strengthenCharacteristic: true, strengthenAttire: true,
    }),
    "{{izayoi_sakuya}}, [grey_hair], maid_headdress, touhou",
);

// a character with no profile adds nothing
assert.equal(
    await buildPrompt({
        beginning: "cat_girl", ending: "",
        post: { tags: ["1girl"], cats: [0] },
        reorder: false, reformat: false, autoCopyright: true,
    }),
    "cat_girl, 1girl",
);

unlinkSync(tmp);
console.log("ok");
