/* node --test src/lib/drawProgress.test.mjs — the bar behind a draw: it only
   moves forward, and it lands on 1 exactly when the draw is done. Serves
   public/ off disk with ranges, like promptIndex.test.mjs. */
import assert from "node:assert";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import test from "node:test";

const dir = new URL("../../public/", import.meta.url).pathname;
globalThis.fetch = async (url, opts) => {
    const path = dir + url.slice(1);
    const r = opts?.headers?.Range;
    if (!r) return new Response(readFileSync(path), { status: 200 });
    // Range-read off the fd: prompts.bin is 575 MB and slurping it per request
    // makes the test slower than the thing it is testing.
    const [s, e] = r.slice(6).split("-").map(Number);
    const buf = Buffer.alloc(e - s + 1);
    const fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, buf.length, s);
    closeSync(fd);
    return new Response(buf.subarray(0, n), { status: 206 });
};

const { onDrawProgress, randomPrompt, warmPromptIndex } = await import("./promptIndex.js");
await warmPromptIndex();

test("draw progress rises and finishes at 1", async () => {
    const seen = [];
    onDrawProgress((p) => seen.push(p));
    const post = await randomPrompt({ include: [], exclude: [], minScore: 100 });
    assert.ok(post.tags.length > 0);
    assert.equal(seen[0], 0);
    assert.equal(seen.at(-1), 1);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `${seen}`);
    // every request moved it, and none of them claimed to be the end
    assert.ok(seen.length > 2 && seen.slice(0, -1).every((p) => p < 1));
});
