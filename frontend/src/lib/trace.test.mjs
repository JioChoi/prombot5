/* node --test src/lib/trace.test.mjs — where each tag in the finished prompt
   came from, which is all the preview sheet knows. Serves public/ off disk. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dir = new URL("../../public/", import.meta.url).pathname;
globalThis.fetch = async (url) => new Response(readFileSync(dir + url.slice(1)));

const { tracePrompt, traceCharacters, renderPrompt } = await import("./prompt.js");

const post = { tags: ["outdoors", "blue_sky"], cats: [0, 0] };
const base = { post, reorder: false, reformat: false };

test("typed, drawn and filled-in tags are told apart", async () => {
    const { text, parts } = await tracePrompt({
        ...base,
        beginning: "hakurei reimu",
        ending: "masterpiece",
        autoCopyright: true,
        strengthenAttire: true,
    });
    const by = (tag) => parts.find((p) => p.tag === tag);

    assert.equal(by("hakurei reimu").origin, "typed");
    assert.equal(by("masterpiece").origin, "typed");
    assert.equal(by("outdoors").origin, "drawn");
    assert.equal(by("touhou").origin, "series");
    assert.equal(by("touhou").from, "hakurei_reimu");
    assert.equal(by("detached_sleeves").origin, "attire");

    // the pieces still render back to exactly what buildPrompt sends
    assert.equal(renderPrompt(parts), text);
});

test("a caption's parts are what was typed plus what was appended", async () => {
    const [only] = await traceCharacters([{ text: "hatsune miku" }], {
        strengthenCharacteristic: true,
    });
    assert.equal(only.parts[0].tag, "hatsune miku");
    assert.equal(only.parts[0].origin, "typed");
    assert.ok(only.parts.slice(1).every((p) => p.origin === "feature"));
    assert.ok(only.character.text.startsWith("hatsune miku, "));

    // nothing switched on: the caption is all the user's
    const [off] = await traceCharacters([{ text: "hatsune miku" }], {});
    assert.deepEqual(off.added, []);
    assert.equal(off.parts.length, 1);
});
