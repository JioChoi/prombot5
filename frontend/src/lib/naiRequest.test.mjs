import assert from "node:assert/strict";
import { buildRequest, skipCfgSigma } from "./naiRequest.js";

const settings = {
    model: "nai-diffusion-4-5-full",
    negative: "ugly",
    useCoords: true,
    width: 832,
    height: 1216,
    steps: 28,
    guidance: 5.5,
    rescale: 0,
    sampler: "k_euler_ancestral",
    noiseSchedule: "karras",
    seed: "1234",
    varietyPlus: false,
    characters: [
        { id: 1, text: "hatsune miku", negative: "red hair", x: 0.1, y: 0.5 },
        { id: 2, text: "kagamine rin", negative: "", x: 0.9, y: 0.5 },
        { id: 3, text: "skipped one", negative: "", x: 0.5, y: 0.5, off: true },
        { id: 4, text: "   ", negative: "", x: 0.7, y: 0.5 },
    ],
};

const { body, seed } = buildRequest({ prompt: "best quality", settings });
const p = body.parameters;

assert.equal(seed, 1234);
assert.equal(p.seed, 1234);
assert.equal(body.input, "best quality");
assert.equal(p.v4_prompt.caption.base_caption, "best quality");
assert.equal(p.negative_prompt, "ugly");
assert.equal(p.v4_negative_prompt.caption.base_caption, "ugly");
assert.equal(p.stream, "msgpack");

// Skipped and empty characters are dropped, not sent disabled: a slot that stays
// behind shifts every character after it.
assert.equal(p.characterPrompts.length, 2);
assert.deepEqual(
    p.characterPrompts.map((c) => c.prompt),
    ["hatsune miku", "kagamine rin"],
);

// The cast is sent in three places and they have to agree, index for index —
// including the negatives, where an empty one still needs its slot.
const pos = p.v4_prompt.caption.char_captions;
const neg = p.v4_negative_prompt.caption.char_captions;
assert.equal(pos.length, 2);
assert.equal(neg.length, 2);
assert.deepEqual(pos.map((c) => c.char_caption), ["hatsune miku", "kagamine rin"]);
assert.deepEqual(neg.map((c) => c.char_caption), ["red hair", ""]);
assert.deepEqual(p.characterPrompts.map((c) => c.center), [
    { x: 0.1, y: 0.5 },
    { x: 0.9, y: 0.5 },
]);
assert.deepEqual(pos.map((c) => c.centers[0]), neg.map((c) => c.centers[0]));

// Variety+ off means the field must be null, not absent or 0.
assert.equal(p.skip_cfg_above_sigma, null);
const on = buildRequest({ prompt: "x", settings: { ...settings, varietyPlus: true } });
assert.equal(on.body.parameters.skip_cfg_above_sigma, skipCfgSigma(832, 1216));
// The reference resolution is where the constant applies unscaled.
assert.ok(Math.abs(skipCfgSigma(832, 1216) - 19.343056794463642) < 1e-9);
assert.ok(skipCfgSigma(1216, 1216) > skipCfgSigma(832, 1216));

// A blank seed is randomised rather than sent empty, and stays in range.
const rand = buildRequest({ prompt: "x", settings: { ...settings, seed: "" } });
assert.ok(Number.isInteger(rand.seed) && rand.seed >= 0 && rand.seed < 4294967295);
assert.equal(rand.body.parameters.seed, rand.seed);

// No characters at all: the lists are empty, never undefined.
const solo = buildRequest({ prompt: "x", settings: { ...settings, characters: [] } });
assert.deepEqual(solo.body.parameters.characterPrompts, []);
assert.deepEqual(solo.body.parameters.v4_prompt.caption.char_captions, []);

// stream:false is the non-streaming endpoint's body — the flag must be gone,
// not false, since that endpoint ignores it either way.
const plain = buildRequest({ prompt: "x", settings, stream: false });
assert.ok(!("stream" in plain.body.parameters));

console.log("ok");
