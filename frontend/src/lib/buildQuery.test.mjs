import assert from "node:assert/strict";
import { buildQuery } from "./promptIndex.js";

const q = (filters) => buildQuery({ include: "rain", exclude: "text", minScore: 50, filters });

// Nothing switched off: nothing to cut.
assert.deepEqual(q({}).drop, []);
assert.deepEqual(q({}).dropCats, []);

// The two kinds of pill cut on different things and must not be confused:
// characters/artists/series are danbooru categories carried on the record,
// the rest are subsets that live in tag-groups.
assert.deepEqual(q({ character: true }).dropCats, [4]);
assert.deepEqual(q({ artist: true }).dropCats, [1]);
// an artist off takes their style tags with them
assert.deepEqual(q({ artist: true }).drop, ["style"]);
assert.deepEqual(q({ copyright: true }).dropCats, [3]);
assert.deepEqual(q({ character: true }).drop, []);

assert.deepEqual(q({ nsfw: true }).drop, ["nsfw"]);
// the two new pills cut scene and object tags out of the draw
assert.deepEqual(q({ scene: true }).drop, ["scene"]);
assert.deepEqual(q({ object: true }).drop, ["object"]);
assert.deepEqual(q({ characteristic: true }).drop, ["feature"]);
assert.deepEqual(q({ nsfw: true }).dropCats, []);

// Both kinds at once, each landing in its own list.
const both = q({ artist: true, attire: true });
assert.deepEqual(both.dropCats, [1]);
assert.deepEqual(both.drop, ["attire", "style"]);

// A pill that is on (false) must not cut.
assert.deepEqual(q({ artist: false, nsfw: false }).dropCats, []);
assert.deepEqual(q({ artist: false, nsfw: false }).drop, []);

assert.deepEqual(q({}).include, ["rain"]);
assert.deepEqual(q({}).exclude, ["text"]);

console.log("ok");
