import assert from "node:assert/strict";
import { buildPrompt } from "./prompt.js";

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

console.log("ok");
