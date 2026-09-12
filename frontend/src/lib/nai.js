import { decode } from "@msgpack/msgpack";
import { NAI, detectDirect, directFetch, directReady, markNoStream } from "./direct.js";

// Points at the backend (frontend/.env). Optional chaining because a plain-node
// test importing this file has no import.meta.env.
const API = import.meta.env?.VITE_API ?? "";

/* A dead backend surfaces as "Load failed" (Safari) or "Failed to fetch" (Chrome),
   which says nothing about what to go fix. Name the actual cause instead. */
async function call(path, init) {
    try {
        return await fetch(`${API}${path}`, init);
    } catch (e) {
        // A header value the browser refuses — a key pasted with a newline in
        // it, say — never reaches the network, and iOS Safari reports that as
        // "The string did not match the expected pattern".
        if (e.name === "SyntaxError" || e.name === "TypeError") {
            if (/pattern|header|invalid/i.test(e.message)) {
                throw new Error("That API key has characters the browser won't send — re-paste it");
            }
        }
        // An abort is the caller's own doing, and callers tell it apart by name.
        // Renaming it here would report a deliberate stop as a dead backend.
        if (e.name === "AbortError") throw e;
        throw new Error("Can't reach the server — is the backend running on :8090?");
    }
}

/**
 * The same request, made the best way available.
 *
 * With the userscript installed it goes straight to NovelAI from the device, so
 * the account is the only one on its IP address. Without it, through the relay
 * as before — the site works either way, the difference is whose address
 * NovelAI sees.
 */
const PROXIED = {
    "/user/subscription": "/api/subscription",
    "/ai/generate-image": "/api/generate-image",
    "/ai/generate-image-stream": "/api/generate-image-stream",
};

async function nai(path, init = {}) {
    if (!(await detectDirect())) return call(PROXIED[path], init);
    return directFetch(`${NAI}${path}`, init);
}

/** Whether requests are going straight out, for the badge in the header. */
export function directMode() {
    return directReady();
}

/** The script, once, so the app can show its state before anything is asked. */
export function checkDirect() {
    return detectDirect();
}

/** The key itself is bad, as opposed to the check merely not completing. Callers
    match on this to decide whether discarding a stored key is justified. */
export const REJECTED = "That key was rejected";

/** Confirms a token works before we store it (so a typo fails here and not later in
    the middle of a generation) and again on load, in case it was revoked since.
    Returns the Anlas balance, which the same response already carries. */
export async function verifyToken(token) {
    // trimmed at every use, not only where it is stored: a key saved by an
    // older build may still carry the newline it was pasted with
    const init = { headers: { Authorization: `Bearer ${(token ?? "").trim()}` } };
    let r = await nai("/user/subscription", init);

    // A rejection is acted on — the caller discards the key over it — so the
    // userscript does not get to be the only witness. Engines differ in what
    // they pass through, and a key wrongly thrown away is a person locked out
    // of their own generator until they go and find it again.
    if (r.status === 401 && directReady()) r = await call("/api/subscription", init);

    if (!r.ok) throw new Error(r.status === 401 ? REJECTED : `Check failed (${r.status})`);
    // Two separate pots — the subscription's monthly allowance and bought Anlas.
    // NovelAI's own UI shows the sum.
    const left = (await r.json()).trainingStepsLeft ?? {};
    return (left.fixedTrainingStepsLeft ?? 0) + (left.purchasedTrainingSteps ?? 0);
}

/* Longer than any gap between progress images, short enough that a stuck engine
   is not the whole wait. The queue is on the far side of the response headers,
   so this is only ever timing bytes against bytes.
   ponytail: one flat number, per-engine tuning if some engine turns out slower. */
const STALL = 45000;

/* The stream is a run of frames, each a 4-byte big-endian length followed by
   that many bytes of msgpack. Chunk boundaries fall wherever the network put
   them, so a frame is only decodable once enough chunks have been collected. */
export async function* frames(stream, stall = STALL) {
    const reader = stream.getReader();
    let buf = new Uint8Array(0);
    // An engine can hand over most of a body and then simply stop — Tampermonkey
    // on iOS does, leaving a finished generation waiting on bytes that will
    // never come. Treated as a stream that cannot be trusted: the request is
    // dropped and the finished image asked for whole.
    const read = () => {
        let timer;
        return Promise.race([
            reader.read().finally(() => clearTimeout(timer)),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("no-stream (stalled)")), stall);
            }),
        ]);
    };
    try {
        for (;;) {
            const { done, value } = await read();
            if (value) {
                const next = new Uint8Array(buf.length + value.length);
                next.set(buf);
                next.set(value, buf.length);
                buf = next;
            }
            // Drain whole frames before asking for more bytes.
            for (;;) {
                if (buf.length < 4) break;
                const n = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
                if (buf.length < 4 + n) break;
                try {
                    yield decode(buf.subarray(4, 4 + n));
                } catch (e) {
                    // The frame lengths only make sense if the bytes arrived
                    // exactly as sent. An engine that hands the body over
                    // re-encoded produces garbage here, and the message from
                    // the decoder ("Extra bytes past the end") describes the
                    // symptom rather than the cause.
                    throw new Error(`no-stream (unreadable stream: ${e.message})`);
                }
                buf = buf.subarray(4 + n);
            }
            if (done) return;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
}

/**
 * Streams one generation. `onPreview` gets a Blob for each progress image —
 * NovelAI sends those as JPEG — and the finished PNG Blob is returned.
 *
 * `signal` aborts the request; the caller owns every Blob it is handed.
 */
export async function generate(token, body, { onPreview, signal } = {}) {
    // Counted where the request is made, so retries and aborts count too — this
    // is "generations asked for", not "images that came back". globalThis, not
    // window: the node tests import this file with no DOM.
    globalThis.gtag?.("event", "generate", { model: body?.model });

    const init = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${(token ?? "").trim()}`,
        },
        body: JSON.stringify(body),
        signal,
        stream: true,
    };
    // Some userscript engines — Stay on iOS among them — cannot hand a script a
    // stream. Those get the finished image in one piece instead: no progress
    // previews, but still no relay. Once it has said so, it is not asked again.
    if (directReady()?.stream === false) return whole(init);

    let r;
    try {
        r = await nai("/ai/generate-image-stream", init);
    } catch (e) {
        if (!e.message.startsWith("no-stream")) throw e;
        return whole(init);
    }

    if (!r.ok) {
        // Errors come back as JSON even on the msgpack endpoint.
        const said = await r.json().catch(() => ({}));
        throw new Error(said.message || said.error || `Generation failed (${r.status})`);
    }

    let final = null;
    try {
        for await (const ev of frames(r.body)) {
            if (!ev?.image) continue;
            if (ev.event_type === "final") {
                // Done here, not at the end of the stream: this frame is the
                // finished image and NovelAI sends exactly one. Waiting for the
                // body to close as well means trusting the engine to say so,
                // and Tampermonkey on iOS never does — the image was in hand
                // and the run hung anyway.
                final = new Blob([ev.image], { type: "image/png" });
                break;
            } else {
                onPreview?.(new Blob([ev.image], { type: "image/jpeg" }));
            }
        }
    } catch (e) {
        // The engine can give up on the stream after the headers, not only
        // before them; there is still a whole image to be had — and since this
        // engine's streaming has now failed once, later runs skip it rather
        // than spending the stall wait again on every image.
        // A finished image outranks whatever went wrong afterwards.
        if (final) return final;
        if (!e.message.startsWith("no-stream")) throw e;
        if (directReady()) markNoStream();
        return whole(init);
    }
    if (final) return final;
    // The stream ended and no finished image came out of it — a frame lost to
    // however the engine handed the bytes over. That request is over, so asking
    // for the whole image now is not a second concurrent generation; and since
    // this engine's streaming cannot be trusted, later runs skip it.
    if (directReady()) {
        markNoStream();
        return whole(init);
    }
    throw new Error("Stream ended without a finished image");
}

/**
 * One generation without the stream: the zip endpoint, unpacked here.
 *
 * NovelAI answers /ai/generate-image with a zip holding a single PNG. Reading
 * one is a local file header, a name and an optional deflate — twenty lines
 * against a dependency, and the browser already has the inflater.
 */
async function whole(init) {
    const r = await directFetch(`${NAI}/ai/generate-image`, { ...init, stream: false });
    if (!r.ok) {
        const said = await r.json().catch(() => ({}));
        throw new Error(said.message || said.error || `Generation failed (${r.status})`);
    }
    return new Blob([await unzipFirst(new Uint8Array(await r.arrayBuffer()))], {
        type: "image/png",
    });
}

/** The first entry of a zip, inflated if it needs to be. */
export async function unzipFirst(zip) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    if (view.getUint32(0, true) !== 0x04034b50) throw new Error("Not a zip");
    const method = view.getUint16(8, true);
    const size = view.getUint32(18, true); // compressed
    const name = view.getUint16(26, true);
    const extra = view.getUint16(28, true);
    const at = 30 + name + extra;
    const body = zip.subarray(at, size ? at + size : undefined);
    if (method === 0) return body;
    if (method !== 8) throw new Error(`Unsupported zip method ${method}`);
    const out = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(out).arrayBuffer());
}
