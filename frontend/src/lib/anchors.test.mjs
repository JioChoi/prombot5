/* node --test src/lib/anchors.test.mjs — the block walk lands on the right
   record. A one-post slip decodes a neighbour's bytes, so checking the header
   against prompts.idx (the full table the anchors are a downsample of) is the
   whole proof. */
import assert from "node:assert";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import test from "node:test";

const dir = new URL("../../public/", import.meta.url).pathname;
function slice(path, s, e) {
    const buf = Buffer.alloc(e - s + 1);
    const fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, buf.length, s);
    closeSync(fd);
    return buf.subarray(0, n);
}
globalThis.fetch = async (url, opts) => {
    const path = dir + url.slice(1);
    const r = opts?.headers?.Range;
    if (!r) return new Response(readFileSync(path), { status: 200 });
    const [s, e] = r.slice(6).split("-").map(Number);
    return new Response(slice(path, s, e), { status: 206 });
};

const { randomPrompt, warmPromptIndex } = await import("./promptIndex.js");
await warmPromptIndex();

const idx = new Uint32Array(readFileSync(dir + "prompts.idx").buffer);

/** The header of post p, read the slow honest way: full table, then the bytes. */
function header(p) {
    const bytes = slice(dir + "prompts.bin", idx[p], idx[p + 1] - 1);
    let at = 0;
    const next = () => {
        let v = 0;
        for (let shift = 0; ; shift += 7) {
            const b = bytes[at++];
            v += (b & 0x7f) * 2 ** shift;
            if (!(b & 0x80)) return v;
        }
    };
    return { fav: next(), id: next(), tags: next() };
}

test("a drawn record is the record its post number names", async () => {
    for (let i = 0; i < 50; i++) {
        const post = await randomPrompt({ include: [], exclude: [], minScore: 0 });
        const want = header(post.post);
        assert.equal(post.id, want.id, `post ${post.post}`);
        assert.equal(post.fav, want.fav, `post ${post.post}`);
        // tags come back minus whatever the dictionary cut, never more
        assert.ok(post.tags.length <= want.tags && post.tags.length > 0);
    }
});

test("the last block, where there is nothing past it to bracket with", async () => {
    // the final posts have no favourites, so a floor of 0 is the only way in
    const post = await randomPrompt({ include: ["1girl"], exclude: [], minScore: 0 });
    assert.equal(post.id, header(post.post).id);
});
