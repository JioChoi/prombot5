import { decode } from "@msgpack/msgpack";

// Points at the backend (frontend/.env). Optional chaining because a plain-node
// test importing this file has no import.meta.env.
const API = import.meta.env?.VITE_API ?? "";

/* A dead backend surfaces as "Load failed" (Safari) or "Failed to fetch" (Chrome),
   which says nothing about what to go fix. Name the actual cause instead. */
async function call(path, init) {
    try {
        return await fetch(`${API}${path}`, init);
    } catch (e) {
        // An abort is the caller's own doing, and callers tell it apart by name.
        // Renaming it here would report a deliberate stop as a dead backend.
        if (e.name === "AbortError") throw e;
        throw new Error("Can't reach the server — is the backend running on :8090?");
    }
}

/** The key itself is bad, as opposed to the check merely not completing. Callers
    match on this to decide whether discarding a stored key is justified. */
export const REJECTED = "That key was rejected";

/** Confirms a token works before we store it (so a typo fails here and not later in
    the middle of a generation) and again on load, in case it was revoked since.
    Returns the Anlas balance, which the same response already carries. */
export async function verifyToken(token) {
    const r = await call("/api/subscription", {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(r.status === 401 ? REJECTED : `Check failed (${r.status})`);
    // Two separate pots — the subscription's monthly allowance and bought Anlas.
    // NovelAI's own UI shows the sum.
    const left = (await r.json()).trainingStepsLeft ?? {};
    return (left.fixedTrainingStepsLeft ?? 0) + (left.purchasedTrainingSteps ?? 0);
}

/* The stream is a run of frames, each a 4-byte big-endian length followed by
   that many bytes of msgpack. Chunk boundaries fall wherever the network put
   them, so a frame is only decodable once enough chunks have been collected. */
async function* frames(stream) {
    const reader = stream.getReader();
    let buf = new Uint8Array(0);
    try {
        for (;;) {
            const { done, value } = await reader.read();
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
                yield decode(buf.subarray(4, 4 + n));
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
    const r = await call("/api/generate-image-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
    });

    if (!r.ok) {
        // Errors come back as JSON even on the msgpack endpoint.
        const said = await r.json().catch(() => ({}));
        throw new Error(said.message || said.error || `Generation failed (${r.status})`);
    }

    let final = null;
    for await (const ev of frames(r.body)) {
        if (!ev?.image) continue;
        if (ev.event_type === "final") {
            final = new Blob([ev.image], { type: "image/png" });
        } else {
            onPreview?.(new Blob([ev.image], { type: "image/jpeg" }));
        }
    }
    if (!final) throw new Error("Stream ended without a finished image");
    return final;
}
