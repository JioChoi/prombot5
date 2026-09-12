import assert from "node:assert/strict";
import { buildPrompt, keyOf } from "./prompt.js";
import { readFileSync } from "node:fs";

// promptIndex caches whatever the first fetch did, failures included, so the
// data files are served from public/ before any prompt is built.
globalThis.fetch = async (url) =>
    new Response(readFileSync("public" + new URL(url, "http://x").pathname));

const post = { tags: ["1girl", "rating:general", "blue_eyes", "commentary"], cats: [0, 9, 0, 5] };
const base = { beginning: "rating:explicit, masterpiece", ending: "rating:safe", post, reorder: false, reformat: false };

const kept = await buildPrompt(base);
assert.ok(kept.includes("rating:general"), kept);

const dropped = await buildPrompt({ ...base, dropRating: true });
// Drawn rating gone; the ones typed into beginning/ending survive untouched.
assert.ok(!dropped.includes("rating:general"), dropped);
assert.ok(dropped.includes("rating:explicit") && dropped.includes("rating:safe"), dropped);
assert.ok(dropped.includes("1girl") && dropped.includes("blue_eyes"), dropped);

// A rating whose category never resolved is still a rating by name.
const byName = await buildPrompt({
    ...base,
    dropRating: true,
    post: { tags: ["1girl", "rating:questionable"], cats: [0, undefined] },
});
assert.ok(!byName.includes("questionable"), byName);

// Nothing the negative prompt rules out survives the draw, weights and all.
const censored = { tags: ["1girl", "mosaic_censoring", "blue_eyes"], cats: [0, 0, 0] };
const vetoed = await buildPrompt({ ...base, post: censored, negative: "{blue eyes:1.2}" });
assert.ok(!vetoed.includes("blue_eyes"), vetoed);
assert.ok(vetoed.includes("mosaic_censoring"), vetoed);

// `uncensored` anywhere — pinned text or a character caption — takes the whole
// censor list out of the draw.
for (const asked of [
    { beginning: "uncensored" },
    { ending: "1girl, uncensored" },
    { characters: [{ text: "hatsune miku, uncensored" }] },
]) {
    const out = await buildPrompt({ ...base, post: censored, ...asked });
    assert.ok(!out.includes("mosaic_censoring"), out);
    assert.ok(out.includes("1girl"), out);
}

// A tag's own parentheses are part of its name — only a bracket the tag opens
// with is emphasis, and it takes its own closer off with it.
assert.equal(keyOf("leaf (pokemon)"), "leaf_(pokemon)");
assert.equal(keyOf("[[leaf (pokemon)]]"), "leaf_(pokemon)");
assert.equal(keyOf("(leaf (pokemon):1.3)"), "leaf_(pokemon)");
assert.equal(keyOf("(Blue Eyes:1.3)"), "blue_eyes");
assert.equal(keyOf("blue_eyes"), "blue_eyes");

// Search may select a female post for its clothes without adding its count.
const attire = { tags: ["1girl", "dress", "ribbon", "blue_eyes"], cats: [0, 0, 0, 0] };
assert.equal(await buildPrompt({
    beginning: "1boy", post: attire, omit: "1girl, Blue Eyes",
}), "1boy, dress, ribbon");

// Omit never deletes explicitly typed beginning/ending, including weights.
assert.equal(await buildPrompt({
    beginning: "{1girl}", ending: "blue eyes", post: attire,
    omit: "1girl, blue_eyes",
}), "{1girl}, dress, ribbon, blue eyes");

// No substring filtering, no source mutation, and an empty omit is compatible.
assert.equal(await buildPrompt({ post: attire, omit: "girl" }),
    await buildPrompt({ post: attire }));
assert.deepEqual(attire.tags, ["1girl", "dress", "ribbon", "blue_eyes"]);
assert.equal(await buildPrompt({ beginning: "1girl", post: { tags: [], cats: [] }, omit: "1girl" }), "1girl");

console.log("ok");

// A drawn tag that needs a garment goes out when the garment is not in the
// prompt, and stays when it is — wherever the garment was typed. The real
// tag-requires/tag-groups files stand in for the fetch.
{
    const lifted = { tags: ["1girl", "skirt_lift"], cats: [0, 0] };
    const bare = { beginning: "1girl", post: lifted };
    assert.ok(!(await buildPrompt(bare)).includes("skirt_lift"));

    for (const dressed of [
        { beginning: "1girl, pleated skirt" },
        { ending: "skirt" },
        { characters: [{ text: "hatsune miku, skirt" }] },
        { post: { tags: ["1girl", "skirt", "skirt_lift"], cats: [0, 0, 0] } },
    ]) {
        const out = await buildPrompt({ ...bare, ...dressed });
        assert.ok(out.includes("skirt_lift"), out);
    }

    // Nude undresses the prompt whatever else is in it.
    const nude = await buildPrompt({ beginning: "1girl, skirt, nude", post: lifted });
    assert.ok(!nude.includes("skirt_lift"), nude);
}

console.log("ok");
