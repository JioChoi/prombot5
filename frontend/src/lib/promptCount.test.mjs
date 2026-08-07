/* node src/lib/promptCount.test.mjs — serves public/ off disk with ranges.

   Covers the one thing this pair gets wrong when it drifts: a count must
   always come back, and lowering the favourites floor must never show fewer
   prompts than a higher floor did. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dir = new URL("../../public/", import.meta.url).pathname;
globalThis.fetch = async (url, opts) => {
    const buf = readFileSync(dir + url.slice(1));
    const r = opts?.headers?.Range;
    if (!r) return new Response(buf, { status: 200 });
    const [s, e] = r.slice(6).split("-").map(Number);
    return new Response(buf.subarray(s, e + 1), { status: 206 });
};

const { buildQuery, promptCount, warmPromptIndex } = await import("./promptIndex.js");
await warmPromptIndex();

const FILTERS = { character: true, artist: true, copyright: true };
const FLOORS = [200, 100, 50, 20, 10, 5, 1, 0];

// A single common tag with a floor is the case that used to answer with
// nothing: too big for the exact path, and skipped by the estimate as "cheap".
for (const [include, exclude] of [
    ["outdoors", ""],
    ["1girl", ""],
    ["1girl", "monochrome"],
    ["1girl, outdoors", "speech_bubble"],
    ["", "speech_bubble"],
]) {
    let previous = 0;
    let previousFloor = null;

    for (const minScore of FLOORS) {
        const { n, exact } = await promptCount(
            buildQuery({ include, exclude, minScore, filters: FILTERS }),
        );
        const where = `include="${include}" exclude="${exclude}" minScore=${minScore}`;

        // Whichever path answers, it has to answer with a number.
        assert.equal(typeof n, "number", `${where}: got ${n}`);
        assert.ok(Number.isFinite(n) && n >= 0, `${where}: got ${n}`);
        assert.equal(typeof exact, "boolean", where);

        // Lowering the floor widens the corpus, so the count can only grow.
        // A drop here is what a stale display looks like from the outside.
        assert.ok(
            n >= previous,
            `${where}: ${n} is fewer than ${previous} at minScore=${previousFloor}`,
        );
        previous = n;
        previousFloor = minScore;
    }
}

// No tags at all is the whole corpus, and it is exact — nothing to intersect.
const all = await promptCount(buildQuery({ include: "", exclude: "", minScore: 0, filters: {} }));
assert.equal(all.exact, true);
assert.ok(all.n > 10_000_000, `${all.n}`);

// An unknown tag matches nothing, exactly.
const none = await promptCount(
    buildQuery({ include: "zzz_not_a_real_tag", exclude: "", minScore: 0, filters: {} }),
);
assert.equal(none.n, 0);

console.log("ok");
