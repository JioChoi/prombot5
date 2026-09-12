/* node --test src/lib/direct.test.mjs — the page half of the userscript bridge,
   against a stand-in for the script itself. No DOM here, so window is faked:
   postMessage delivers to the same listeners the real one would. */
import assert from "node:assert/strict";
import test from "node:test";

const listeners = new Set();
globalThis.window = {
    location: { origin: "https://prombot.net" },
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    postMessage(data) {
        // async, like the real thing: a handler must never see its own send
        // before the current turn is over
        queueMicrotask(() => {
            for (const fn of [...listeners]) {
                fn({ source: globalThis.window, origin: "https://prombot.net", data });
            }
        });
    },
};

const { detectDirect, directFetch, directReady, NAI } = await import("./direct.js");

let installed = null; // only one pretend script at a time, like a real browser

/** A pretend userscript. `answer` decides what a request gets back. */
function script(answer) {
    if (installed) listeners.delete(installed);
    const seen = [];
    const fn = (e) => {
        const m = e.data;
        if (m.tag !== "prombot-nai") return;
        if (m.type === "hello") {
            window.postMessage({ tag: "prombot-nai", type: "ready", version: "1.0.0", stream: true });
        } else if (m.type === "request") {
            seen.push(m);
            answer(m, (msg) => window.postMessage({ tag: "prombot-nai", ...msg, id: m.id }));
        }
    };
    listeners.add(fn);
    installed = fn;
    return seen;
}

const bytes = (s) => new TextEncoder().encode(s).buffer;

test("an installed script answers the handshake", async () => {
    script(() => {});
    assert.deepEqual(await detectDirect(), {
        version: "1.0.0",
        stream: true,
        handler: undefined,
    });
    assert.equal(directReady().version, "1.0.0");
});

test("a streamed body arrives as a Response that can be read", async () => {
    const seen = script((m, reply) => {
        reply({ type: "head", status: 200, headers: { "content-type": "application/x-msgpack" } });
        reply({ type: "chunk", chunk: bytes("one ") });
        reply({ type: "chunk", chunk: bytes("two") });
        reply({ type: "done" });
    });

    const res = await directFetch(`${NAI}/ai/generate-image-stream`, {
        method: "POST",
        headers: { Authorization: "Bearer pst-x" },
        body: "{}",
        stream: true,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "one two");
    // the request went out as given, and only ever to NovelAI
    const sent = seen.at(-1);
    assert.equal(sent.method, "POST");
    assert.ok(sent.url.startsWith("https://image.novelai.net/"));
    assert.equal(sent.headers.Authorization, "Bearer pst-x");
});

test("a status is an answer, not a failure", async () => {
    script((m, reply) => {
        reply({ type: "head", status: 401, statusText: "Unauthorized" });
        reply({ type: "done", body: bytes('{"message":"nope"}') });
    });
    const res = await directFetch(`${NAI}/user/subscription`, {});
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { message: "nope" });
});

test("an engine that cannot stream says so once", async () => {
    script((m, reply) => reply({ type: "error", message: "no-stream" }));
    await assert.rejects(directFetch(`${NAI}/ai/generate-image-stream`, { stream: true }), /no-stream/);
    // and the page stops claiming streaming works
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(directReady().stream, false);
});

test("a status the engine cannot give yet does not break the Response", async () => {
    // Stay reports 0 while the request is still in flight
    script((m, reply) => {
        reply({ type: "head", status: 0, statusText: null });
        reply({ type: "done", body: bytes('{"ok":true}') });
    });
    const res = await directFetch(`${NAI}/user/subscription`, {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
});

test("an engine that cannot stream says so in the handshake", async () => {
    // a fresh module, since the handshake is answered once per page
    listeners.clear();
    listeners.add((e) => {
        const m = e.data;
        if (m.tag === "prombot-nai" && m.type === "hello") {
            window.postMessage({
                tag: "prombot-nai",
                type: "ready",
                version: "1.1.0",
                stream: false,
                handler: "Stay",
            });
        }
    });
    const fresh = await import(`./direct.js?stay=${Date.now()}`);
    assert.deepEqual(await fresh.detectDirect(), {
        version: "1.1.0",
        stream: false,
        handler: "Stay",
    });
});
