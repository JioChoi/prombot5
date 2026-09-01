import assert from "node:assert/strict";
import { buildPrompt, keyOf } from "./prompt.js";

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

console.log("ok");
