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

console.log("ok");
