import assert from "node:assert/strict";
import test from "node:test";
import { buildQuery, countPrompts, estimatePrompts, onDrawProgress, promptCount, randomPrompt } from "./promptIndex.js";

// A contradiction is provably empty even offline. Neither counting nor drawing
// should sample records or download a posting list to discover it.
globalThis.fetch = async (url) => { throw new Error(`Unexpected index read: ${url}`); };

for (const tag of ["1girl", "Blue Eyes"]) {
    test(`include and exclude ${tag} resolves without I/O`, async () => {
        const query = buildQuery({ include: `outdoors, ${tag}`, exclude: tag.toLowerCase().replaceAll(" ", "_"), minScore: 0 });
        assert.equal(await countPrompts(query), 0);
        assert.equal(await countPrompts(query, 0), 0);
        assert.equal(await estimatePrompts(query), 0);
        assert.deepEqual(await promptCount(query), { n: 0, exact: true });
        const progress = [];
        onDrawProgress((value) => progress.push(value));
        assert.equal(await randomPrompt(query), null);
        assert.deepEqual(progress, [0, 1]);
        onDrawProgress(null);
    });
}
