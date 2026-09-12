import assert from "node:assert/strict";
import test from "node:test";
import { buildQuery, onDrawProgress, promptCount, randomPrompt } from "./promptIndex.js";

// A contradiction is provably empty here, so neither counting nor drawing
// should trouble the server with it.
globalThis.fetch = async (url) => { throw new Error(`Unexpected request: ${url}`); };

for (const tag of ["1girl", "Blue Eyes"]) {
    test(`include and exclude ${tag} resolves without asking`, async () => {
        const query = buildQuery({
            include: `outdoors, ${tag}`,
            exclude: tag.toLowerCase().replaceAll(" ", "_"),
            minScore: 0,
        });
        assert.deepEqual(await promptCount(query, "key"), { n: 0, exact: true });
        const progress = [];
        onDrawProgress((value) => progress.push(value));
        assert.equal(await randomPrompt(query, "key"), null);
        assert.deepEqual(progress, [0, 1]);
        onDrawProgress(null);
    });
}
