/* node src/lib/promptIndex.test.mjs — serves public/ off disk with ranges and
   checks the counts against a brute-force scan of prompts.bin. */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import assert from "node:assert";

const dir = new URL("../../public/", import.meta.url).pathname;
globalThis.fetch = async (url, opts) => {
    const buf = readFileSync(dir + url.slice(1));
    const r = opts?.headers?.Range;
    if (!r) return new Response(buf, { status: 200 });
    const [s, e] = r.slice(6).split("-").map(Number);
    return new Response(buf.subarray(s, e + 1), { status: 206 });
};

const { countPrompts, randomPrompt, splitTags } = await import("./promptIndex.js");

// brute force: decode every record and match tags by name
const meta = JSON.parse(readFileSync(dir + "prompts.json"));
// the dictionary's source, which build_dict.py blocks up — it is not served
const tags = gunzipSync(readFileSync(dir + "../../data/prompt-tags.csv.gz"))
    .toString()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split(",").slice(0, -4).join(","));
const prm = readFileSync(dir + "prompts.bin");
const off = new Uint32Array(readFileSync(dir + "prompts.idx").buffer);

function scan(want, not, minScore) {
    const wantIds = want.map((t) => tags.indexOf(t));
    const notIds = not.map((t) => tags.indexOf(t));
    let n = 0;
    for (let i = 0; i < meta.posts; i++) {
        let at = off[i];
        const next = () => {
            let v = 0;
            let sh = 0;
            for (;;) {
                const b = prm[at++];
                v += (b & 0x7f) * 2 ** sh;
                if (!(b & 0x80)) break;
                sh += 7;
            }
            return v;
        };
        const fav = next();
        next();
        const count = next();
        const ids = new Set();
        let run = 0;
        for (let k = 0; k < count; k++) ids.add((run += next()));
        if (fav >= minScore && wantIds.every((t) => ids.has(t)) &&
            !notIds.some((t) => ids.has(t))) n++;
    }
    return n;
}

const cases = [
    [["hatsune_miku"], [], 0],
    [["hatsune_miku", "solo"], ["comic"], 100],
    [[], [], 500],
    [[], ["1girl", "solo"], 800], // overlapping excludes must not double-count
    [["nonexistent_tag_xyz"], [], 0],
];
for (const [inc, exc, minScore] of cases) {
    const got = await countPrompts({ include: inc, exclude: exc, minScore });
    assert.equal(got, scan(inc, exc, minScore), `${inc} / ${exc} / ${minScore}`);
    console.log(`ok ${JSON.stringify(inc)} minus ${JSON.stringify(exc)} >=${minScore}: ${got}`);
}
/* The draw samples rather than intersecting, so what it hands back is the
   claim to check: every tag asked for, none of the ones ruled out, over the
   floor — and a null only when a full scan agrees there is nothing. */
const draws = [
    [["1girl", "outdoors"], ["speech_bubble"], 0], // uniform candidates
    [["kirisame_marisa", "outdoors"], [], 100], // drawn from the rarest list
    [["hatsune_miku", "kirisame_marisa"], [], 5000], // thin enough to come up empty
];
for (const [inc, exc, minScore] of draws) {
    for (let i = 0; i < 3; i++) {
        const p = await randomPrompt({ include: inc, exclude: exc, minScore });
        if (!p) {
            assert.equal(scan(inc, exc, minScore), 0, `${inc} said none`);
            continue;
        }
        assert(inc.every((t) => p.tags.includes(t)), `${inc}: ${p.tags}`);
        assert(!exc.some((t) => p.tags.includes(t)), `${exc}: ${p.tags}`);
        assert(p.fav >= minScore, `fav ${p.fav} under ${minScore}`);
    }
    console.log(`ok draw ${JSON.stringify(inc)} minus ${JSON.stringify(exc)} >=${minScore}`);
}

assert.deepEqual(splitTags("Hatsune Miku, , long hair\nsolo"), [
    "hatsune_miku", "long_hair", "solo",
]);
console.log("ok");
