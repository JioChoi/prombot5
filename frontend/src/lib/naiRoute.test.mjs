/* node --test src/lib/naiRoute.test.mjs — which way a NovelAI call leaves:
   straight out when the userscript is installed, through the relay when it is
   not. Same fake window as direct.test.mjs. */
import assert from "node:assert/strict";
import test from "node:test";

const listeners = new Set();
globalThis.window = {
    location: { origin: "https://prombot.net" },
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    postMessage(data) {
        queueMicrotask(() => {
            for (const fn of [...listeners]) {
                fn({ source: globalThis.window, origin: "https://prombot.net", data });
            }
        });
    },
};

// No script installed for this import: nothing answers the handshake.
const asked = [];
globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), init });
    return new Response(JSON.stringify({ trainingStepsLeft: { fixedTrainingStepsLeft: 7 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
};

const { verifyToken, unzipFirst, frames, generate } = await import("./nai.js");

test("with no script installed the relay is used", async () => {
    assert.equal(await verifyToken(" pst-x\n"), 7);
    assert.equal(asked.at(-1).url, "/api/subscription");
    assert.equal(asked.at(-1).init.headers.Authorization, "Bearer pst-x");
});

let installed = null; // one pretend script at a time, like a real browser

function script(handle) {
    if (installed) listeners.delete(installed);
    installed = handle;
    listeners.add(handle);
}

test("with the script installed the call goes straight to NovelAI", async () => {
    script((e) => {
        const m = e.data;
        if (m.tag !== "prombot-nai") return;
        const reply = (msg) => window.postMessage({ tag: "prombot-nai", ...msg, id: m.id });
        if (m.type === "hello") {
            window.postMessage({ tag: "prombot-nai", type: "ready", version: "1.0.0", stream: true });
        } else if (m.type === "request") {
            reply({ type: "head", status: 200, headers: { "content-type": "application/json" } });
            reply({
                type: "done",
                body: new TextEncoder().encode(
                    JSON.stringify({ trainingStepsLeft: { purchasedTrainingSteps: 12 } }),
                ).buffer,
            });
        }
    });

    const before = asked.length;
    assert.equal(await verifyToken("pst-x"), 12);
    assert.equal(asked.length, before, "nothing should have gone to the relay");
});

test("a stored zip is unpacked without a library", async () => {
    // one entry, stored (method 0), named "a"
    const name = new TextEncoder().encode("a");
    const body = new TextEncoder().encode("hello");
    const zip = new Uint8Array(30 + name.length + body.length);
    const view = new DataView(zip.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 0, true); // stored
    view.setUint32(18, body.length, true);
    view.setUint16(26, name.length, true);
    zip.set(name, 30);
    zip.set(body, 30 + name.length);
    assert.equal(new TextDecoder().decode(await unzipFirst(zip)), "hello");
});

test("a rejection from the script is confirmed with the relay first", async () => {
    // the script says 401; the relay says the key is fine
    let checked = 0;
    globalThis.fetch = async (url) => {
        checked++;
        assert.equal(String(url), "/api/subscription");
        return new Response(JSON.stringify({ trainingStepsLeft: { purchasedTrainingSteps: 5 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    script((e) => {
        const m = e.data;
        if (m.tag !== "prombot-nai") return;
        const reply = (msg) => window.postMessage({ tag: "prombot-nai", ...msg, id: m.id });
        if (m.type === "request") {
            reply({ type: "head", status: 401 });
            reply({ type: "done", body: new ArrayBuffer(0) });
        }
    });

    assert.equal(await verifyToken("pst-x"), 5);
    assert.equal(checked, 1, "the relay should have been asked to confirm");
});

test("a stream that ends without the final frame still yields the image", async () => {
    const { generate } = await import("./nai.js");
    const png = new TextEncoder().encode("FINAL-PNG");
    const name = new TextEncoder().encode("i.png");
    const zip = new Uint8Array(30 + name.length + png.length);
    const view = new DataView(zip.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint32(18, png.length, true);
    view.setUint16(26, name.length, true);
    zip.set(name, 30);
    zip.set(png, 30 + name.length);

    const urls = [];
    script((e) => {
        const m = e.data;
        if (m.tag !== "prombot-nai" || m.type !== "request") return;
        const reply = (msg) => window.postMessage({ tag: "prombot-nai", ...msg, id: m.id });
        urls.push(m.url.split("/").pop());
        reply({ type: "head", status: 200 });
        // a stream carrying no frames at all: previews and final both lost
        reply({ type: "done", body: m.stream ? undefined : zip.buffer });
    });

    const before = asked.length;
    const blob = await generate("pst-x", { model: "m" });
    assert.equal(await blob.text(), "FINAL-PNG");
    assert.deepEqual(urls, ["generate-image-stream", "generate-image"]);
    assert.equal(asked.length, before, "nothing should have gone to the relay");
});

test("an engine with no streaming still generates, without the relay", async () => {
    const { generate } = await import("./nai.js");
    // a zip holding one stored PNG, which is what /ai/generate-image answers
    const png = new TextEncoder().encode("PNG-BYTES");
    const name = new TextEncoder().encode("i.png");
    const zip = new Uint8Array(30 + name.length + png.length);
    const view = new DataView(zip.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint32(18, png.length, true);
    view.setUint16(26, name.length, true);
    zip.set(name, 30);
    zip.set(png, 30 + name.length);

    const urls = [];
    script((e) => {
        const m = e.data;
        if (m.tag !== "prombot-nai" || m.type !== "request") return;
        const reply = (msg) => window.postMessage({ tag: "prombot-nai", ...msg, id: m.id });
        urls.push(m.url);
        if (m.stream) {
            reply({ type: "error", message: "no-stream" }); // before any head
        } else {
            reply({ type: "head", status: 200 });
            reply({ type: "done", body: zip.buffer });
        }
    });

    const before = asked.length;
    const blob = await generate("pst-x", { model: "m" });
    assert.equal(await blob.text(), "PNG-BYTES");
    // streaming was already written off by the test above, so this one goes
    // straight for the whole image — either way it is one endpoint, not the relay
    assert.equal(urls.at(-1).split("/").pop(), "generate-image");
    assert.equal(asked.length, before, "nothing should have gone to the relay");
});


test("a stream that stops mid-body is given up on rather than waited out", async () => {
    const { encode } = await import("@msgpack/msgpack");
    const one = encode({ event_type: "intermediate", image: new Uint8Array([1, 2, 3]) });
    const framed = new Uint8Array(4 + one.length);
    new DataView(framed.buffer).setUint32(0, one.length);
    framed.set(one, 4);

    // Enqueued, then nothing — the shape an engine leaves behind when it hands
    // over part of a body and forgets the rest.
    const stream = new ReadableStream({ start: (c) => c.enqueue(framed) });

    const seen = [];
    await assert.rejects(async () => {
        for await (const ev of frames(stream, 50)) seen.push(ev.event_type);
    }, /no-stream/);
    assert.deepEqual(seen, ["intermediate"]);
});

test("a final frame finishes the run even if the stream never closes", async () => {
    const { encode } = await import("@msgpack/msgpack");
    const framed = (ev) => {
        const one = encode(ev);
        const out = new Uint8Array(4 + one.length);
        new DataView(out.buffer).setUint32(0, one.length);
        out.set(one, 4);
        return out.buffer;
    };

    // Tampermonkey on iOS to the life: every frame arrives, "done" never does.
    script((e) => {
        const m = e.data;
        if (m.tag !== "prombot-nai") return;
        const reply = (msg, t) => window.postMessage({ tag: "prombot-nai", ...msg, id: m.id });
        if (m.type === "hello") {
            window.postMessage({ tag: "prombot-nai", type: "ready", version: "1.3.0", stream: true });
        } else if (m.type === "request") {
            reply({ type: "head", status: 200, headers: {} });
            reply({ type: "chunk", chunk: framed({ event_type: "intermediate", image: new Uint8Array([1]) }) });
            reply({ type: "chunk", chunk: framed({ event_type: "final", image: new Uint8Array([2, 3]) }) });
        }
    });

    // An earlier test left streaming marked dead for this page; the script
    // announcing itself again is what a reload looks like.
    window.postMessage({ tag: "prombot-nai", type: "ready", version: "1.3.0", stream: true });
    await new Promise((r) => setTimeout(r, 0));

    const previews = [];
    const blob = await generate("pst-x", { model: "nai-diffusion-4-5-full" }, {
        onPreview: (p) => previews.push(p),
    });
    assert.equal(blob.type, "image/png");
    assert.equal(blob.size, 2);
    assert.equal(previews.length, 1);
});
