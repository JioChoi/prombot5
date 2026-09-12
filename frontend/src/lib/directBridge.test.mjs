import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const listeners = [];
let request;
let requestId;
globalThis.window = {
    location: { origin: "http://localhost:8092" },
    addEventListener: (_, fn) => listeners.push(fn),
    postMessage(data) {
        if (data.type === "request") requestId = data.id;
        queueMicrotask(() => listeners.forEach(fn => fn({
            source: window, origin: window.location.origin, data,
        })));
    },
};
vm.runInNewContext(readFileSync(new URL("../../public/prombot-nai.user.js", import.meta.url), "utf8"), {
    window: { ...window }, unsafeWindow: window, Uint8Array, ArrayBuffer, TextEncoder, Map,
    GM_xmlhttpRequest(options) {
        request = options;
        return { abort() {} };
    },
});
const { directFetch, NAI } = await import("./direct.js");
const reply = text => ({ status: 200, responseHeaders: "", responseText: text });
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const progress of [false, true]) {
    test(`userscript preserves binary response and closes stream, progress=${progress}`, { timeout: 1000 }, async () => {
        const result = directFetch(`${NAI}/ai/generate-image-stream`, { stream: true });
        await tick();
        assert.equal(request.url, `${NAI}/ai/generate-image-stream`);
        const binary = "\x00\x80\xffPNG";
        if (progress) {
            request.onprogress(reply(binary.slice(0, 2)));
            await tick();
        }
        request.onload(reply(binary));
        const response = await result;
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([0, 128, 255, 80, 78, 71]));
    });
}

test("duplicate headers from older scripts do not replace the readable stream", { timeout: 1000 }, async () => {
    const result = directFetch(`${NAI}/ai/generate-image-stream`, { stream: true });
    await tick();
    request.onprogress(reply("first"));
    await tick();
    // Older userscripts announce the same headers again at completion.
    window.postMessage({ tag: "prombot-nai", type: "head", id: requestId, status: 200, headers: {} });
    await tick();
    request.onload(reply("first last"));
    assert.equal(await (await result).text(), "first last");
});

test("userscript rejects messages from another window or origin", () => {
    const previous = request;
    const data = { tag: "prombot-nai", type: "request", id: 999, url: `${NAI}/user/subscription` };
    for (const fn of listeners) {
        fn({ source: {}, origin: window.location.origin, data });
        fn({ source: window, origin: "https://unrelated.example", data });
    }
    assert.equal(request, previous);
});
