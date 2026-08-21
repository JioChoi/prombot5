/* node --test src/lib/warmProgress.test.mjs — the byte counter behind the
   download bar: chunks are reassembled whole, and the fraction ends at 1. */
import assert from "node:assert";
import { gzipSync } from "node:zlib";
import test from "node:test";

const csv = gzipSync("character,series,features,attire,posts\nmiku,vocaloid,twintails,tie,5\n");

globalThis.fetch = async () =>
    new Response(
        new ReadableStream({
            start(c) {
                // two chunks, so the reassembly is actually exercised
                c.enqueue(csv.subarray(0, 10));
                c.enqueue(csv.subarray(10));
                c.close();
            },
        }),
        { headers: { "content-length": String(csv.length) } },
    );

const { allProfiles, onWarmProgress } = await import("./promptIndex.js");

test("progress reaches 1 and the body survives chunking", async () => {
    const seen = [];
    onWarmProgress((p) => seen.push(p));
    const profiles = await allProfiles();
    assert.deepEqual(profiles.get("miku"), {
        series: "vocaloid",
        features: ["twintails"],
        attire: ["tie"],
        posts: 5,
    });
    assert.equal(seen.at(-1), 1);
    assert.ok(seen.length > 1 && seen.every((p) => p > 0 && p <= 1));
});
