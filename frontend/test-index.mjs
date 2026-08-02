/* Drives promptIndex.js against the files in public/ with a fetch that reads
   from disk, so the counting path can be checked without a browser.

       node test-index.mjs

   Counts are verified against prompt-tags.csv.gz, the file the client used to
   download whole. Also reports bytes moved, which is the point of the split. */

import { createReadStream, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const DIR = new URL("./public/", import.meta.url).pathname;
let bytesRead = 0;
let requests = 0;

globalThis.fetch = async (url, opts) => {
    const path = DIR + url.replace(/^\//, "");
    const size = statSync(path).size;
    const m = /bytes=(\d+)-(\d+)/.exec(opts?.headers?.Range ?? "");
    requests++;
    if (!m) {
        bytesRead += size;
        const body = readFileSync(path);
        return { status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), json: async () => JSON.parse(body) };
    }
    const [from, to] = [+m[1], Math.min(+m[2], size - 1)];
    bytesRead += to - from + 1;
    const chunks = [];
    for await (const c of createReadStream(path, { start: from, end: to })) chunks.push(c);
    const body = Buffer.concat(chunks);
    return { status: 206, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
};

const { countPrompts, randomPrompt, buildQuery } = await import("./src/lib/promptIndex.js");

// ground truth straight out of the dictionary the client no longer downloads
const truth = new Map();
for (const line of gunzipSync(readFileSync(new URL("../data/prompt-tags.csv.gz", import.meta.url).pathname)).toString().split("\n").slice(1)) {
    if (!line) continue;
    const f = line.split(",");
    truth.set(f.slice(0, -4).join(","), +f.at(-4));
}

function mark(label) {
    const t = Date.now();
    const [r0, b0] = [requests, bytesRead];
    return () => console.log(
        `${label.padEnd(34)} ${String(Date.now() - t).padStart(5)} ms  ` +
        `${String(requests - r0).padStart(3)} req  ${((bytesRead - b0) / 1e6).toFixed(2)} MB`,
    );
}

let done = mark("count 1girl (cold)");
let n = await countPrompts(buildQuery({ include: "1girl", exclude: "", minScore: 0, filters: {} }));
done();
console.assert(n === truth.get("1girl"), `1girl ${n} != ${truth.get("1girl")}`);

// the NSFW pill thins the prompt, it no longer narrows the pool
done = mark("count nsfw-off (pool unchanged)");
n = await countPrompts(buildQuery({ include: "", exclude: "", minScore: 0, filters: { nsfw: true } }));
const all = await countPrompts(buildQuery({ include: "", exclude: "", minScore: 0, filters: {} }));
done();
console.assert(n === all, `nsfw pill changed the pool: ${n} != ${all}`);

done = mark("count cat_girl + blue_eyes");
n = await countPrompts(buildQuery({ include: "cat_girl, blue_eyes", exclude: "", minScore: 0, filters: {} }));
done();
console.assert(n > 0 && n <= truth.get("cat_girl"), `intersection ${n}`);

done = mark("count 1girl, minScore 500");
n = await countPrompts(buildQuery({ include: "1girl", exclude: "", minScore: 500, filters: {} }));
done();
console.assert(n > 0 && n < truth.get("1girl"), `floor ${n}`);

done = mark("count unknown tag");
n = await countPrompts(buildQuery({ include: "not_a_real_tag_zzz", exclude: "", minScore: 0, filters: {} }));
done();
console.assert(n === 0, `unknown ${n}`);

done = mark("random prompt (cold names)");
let p = await randomPrompt(buildQuery({ include: "cat_girl", exclude: "", minScore: 100, filters: {} }));
done();
console.assert(p?.tags.includes("cat_girl"), `tags ${p?.tags}`);

done = mark("random prompt (warm)");
p = await randomPrompt(buildQuery({ include: "cat_girl", exclude: "", minScore: 100, filters: {} }));
done();

done = mark("random prompt, all four types off");
p = await randomPrompt(buildQuery({
    include: "cat_girl", exclude: "", minScore: 100,
    filters: { attire: true, characteristic: true, expression: true, nsfw: true },
}));
done();
console.assert(!p.tags.includes("cat_girl"), "feature tags should be dropped");
// nothing left in the prompt may belong to any of the three subsets
const groupOf = new Map();
for (const line of gunzipSync(readFileSync(DIR + "tag-groups.csv.gz")).toString().split("\n").slice(1)) {
    if (!line) continue;
    const cut = line.lastIndexOf(",");
    groupOf.set(line.slice(0, cut), line.slice(cut + 1));
}
const leaked = p.tags.filter((t) => groupOf.has(t));
console.assert(!leaked.length, `leaked: ${leaked}`);
console.log("sample:", p.tags.slice(0, 12).join(", "));

// categories ride along with the names, so an artist tag can be labelled
done = mark("artist category on a drawn prompt");
p = await randomPrompt(buildQuery({ include: "", exclude: "", minScore: 800, filters: {} }));
done();
console.assert(p.cats.length === p.tags.length, "cats must line up with tags");
const artists = p.tags.filter((_, i) => p.cats[i] === 1);
console.log("artists:", artists.join(", ") || "(none in this draw)");
console.assert(p.cats.every((c) => c >= 0 && c <= 9), `bad category: ${p.cats}`);

console.log(`\ntotal ${requests} requests, ${(bytesRead / 1e6).toFixed(2)} MB`);
