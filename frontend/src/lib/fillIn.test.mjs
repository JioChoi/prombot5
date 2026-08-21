/* node --test src/lib/fillIn.test.mjs — what a named character brings with
   them, in the base prompt and in their own caption. Serves public/ off disk,
   so the profiles are the real ones build_characters.py wrote. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dir = new URL("../../public/", import.meta.url).pathname;
globalThis.fetch = async (url) => new Response(readFileSync(dir + url.slice(1)));

const { buildPrompt, fillCharacters } = await import("./prompt.js");

const post = { tags: ["outdoors"], cats: [0] };
const base = { post, reorder: false, reformat: false };

test("the base prompt is filled in from the name it carries", async () => {
    const off = await buildPrompt({ ...base, beginning: "1girl, hatsune miku" });
    assert.ok(!off.includes("twintails"), off);

    const on = await buildPrompt({
        ...base,
        beginning: "1girl, hatsune miku",
        strengthenCharacteristic: true,
    });
    assert.ok(on.includes("twintails") && on.includes("aqua_hair"), on);
    // features only: her profile carries no attire, and Reimu's must not leak in
    assert.ok(!on.includes("detached_sleeves"), on);

    const series = await buildPrompt({
        ...base,
        beginning: "hakurei reimu",
        autoCopyright: true,
    });
    assert.ok(series.includes("touhou"), series);
});

test("attire and features are separate switches", async () => {
    const attire = await buildPrompt({
        ...base,
        beginning: "hakurei reimu",
        strengthenAttire: true,
    });
    assert.ok(attire.includes("detached_sleeves") && attire.includes("hair_tubes"), attire);
    assert.ok(!attire.includes("brown_hair"), attire);

    const features = await buildPrompt({
        ...base,
        beginning: "hakurei reimu",
        strengthenCharacteristic: true,
    });
    assert.ok(features.includes("brown_hair"), features);
    assert.ok(!features.includes("detached_sleeves"), features);
});

test("nothing already asked for, or asked against, is added", async () => {
    const out = await buildPrompt({
        ...base,
        beginning: "hakurei reimu, {{detached sleeves}}",
        negative: "hair_tubes",
        strengthenAttire: true,
    });
    // the pinned copy keeps its weight and is not repeated
    assert.equal(out.match(/detached[ _]sleeves/g).length, 1, out);
    assert.ok(out.includes("{{detached sleeves}}"), out);
    assert.ok(!out.includes("hair_tubes"), out);
});

test("a character's caption is filled from the name in that caption", async () => {
    const cast = [
        { id: 1, x: 0.5, y: 0.5, text: "hakurei reimu", negative: "" },
        { id: 2, text: "sakuya izayoi" },
    ];
    const filled = await fillCharacters(cast, { strengthenAttire: true });
    assert.ok(filled[0].text.startsWith("hakurei reimu, "), filled[0].text);
    assert.ok(filled[0].text.includes("detached_sleeves"), filled[0].text);
    // whatever else the character was carrying rides through untouched
    assert.equal(filled[0].x, 0.5);
    assert.equal(filled[0].id, 1);
    // each caption gets its own character's look, never the other's
    assert.ok(!filled[1].text.includes("detached_sleeves"), filled[1].text);
});

test("reformat spaces what it adds; switches off change nothing", async () => {
    const cast = [{ id: 1, text: "hakurei reimu" }];
    const spaced = await fillCharacters(cast, { strengthenAttire: true, reformat: true });
    assert.ok(spaced[0].text.includes("detached sleeves"), spaced[0].text);

    const same = await fillCharacters(cast, { reorder: true, reformat: true });
    assert.equal(same[0], cast[0]);
});
