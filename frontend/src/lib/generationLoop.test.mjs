import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Execute the application's generation functions, retaining refs across simulated
// committed renders. Network and image storage are replaced at their boundaries.
const source = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const start = source.indexOf("    async function once()");
const functions = source.slice(start, source.indexOf("\n    return (", start));
const defaults = {
    randomize: true, include: "old include", exclude: "old exclude", omit: "old omit",
    filters: { artist: true }, minScore: 0, beginning: "old beginning", ending: "",
    negative: "", characters: [], extras: {}, useCoords: false, model: "test",
    width: 832, height: 1216, steps: 28, guidance: 5, rescale: 0, sampler: "test",
    noiseSchedule: "test", seed: "", varietyPlus: false, autoDownload: false,
    delay: 0, background: false, busy: false, token: "test-token",
};

function harness(onDraw) {
    const autoRef = { current: true };
    const onceRef = { current: null };
    const queries = [], prompts = [];
    const noop = () => {};
    const common = {
        autoRef, onceRef, useLayoutEffect: fn => fn(), performance, Date, setTimeout,
        URL: { createObjectURL: () => "blob:test", revokeObjectURL: noop },
        NoMatchingPromptError: class extends Error {},
        setOnDraw: noop, setPreview: noop, refreshSubscription: noop, stamp: () => "",
        clock: () => "", setShots: noop, setActiveId: noop, download: noop,
        setWaitLeft: noop, setBusy: noop, setError: noop, keepAwake: noop,
        releaseAwake: noop, setAutoGen: noop,
        buildQuery: x => x,
        randomPrompt: async query => {
            queries.push(query);
            await onDraw?.(queries.length, render, autoRef);
            return { tags: [], cats: [] };
        },
        buildPrompt: async x => x,
        fillCharacters: async x => x,
        buildRequest: x => ({ body: x }),
        generate: async (_, body) => {
            prompts.push(body.prompt);
            if (prompts.length === 2) autoRef.current = false;
            return {};
        },
    };
    function render(settings) {
        return vm.runInNewContext(`(function(){${functions}; return run;})()`, {
            ...common, ...defaults, ...settings,
        });
    }
    return { render, queries, prompts };
}

test("edits during a draw apply to the next image without mixing the current image's settings", async () => {
    const h = harness((n, render) => {
        if (n === 1) render({
            include: "new include", exclude: "new exclude", omit: "new omit",
            filters: { artist: false }, beginning: "new beginning",
        });
    });
    await h.render({})();
    assert.equal(h.queries.length, 2);
    assert.equal(h.queries[0].include, "old include");
    assert.equal(h.prompts[0].omit, "old omit");
    assert.equal(h.prompts[0].beginning, "old beginning");
    assert.equal(h.queries[1].include, "new include");
    assert.equal(h.queries[1].exclude, "new exclude");
    assert.equal(h.queries[1].filters.artist, false);
    assert.equal(h.prompts[1].omit, "new omit");
    assert.equal(h.prompts[1].beginning, "new beginning");
});

test("switching off the loop during a draw still finishes only the current image", async () => {
    const h = harness((_, render, autoRef) => {
        render({ omit: "edited" });
        autoRef.current = false;
    });
    await h.render({})();
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0].omit, "old omit");
});
