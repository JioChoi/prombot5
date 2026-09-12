/* Talking to the Prombot Direct userscript.

   The userscript sends NovelAI requests from this device. Callers must reject
   requests when it is unavailable instead of routing them through a relay.

   The two halves talk over window.postMessage. This side hands out something
   Response-shaped so nai.js can treat both routes the same. */

const TAG = "prombot-nai";
export const NAI = "https://image.novelai.net";

let ready = null; // { version, stream } once the script has answered
let waiting = null; // the handshake, in flight
const observers = new Set();
const calls = new Map(); // request id -> handlers
let nextId = 1;

function listen() {
    if (typeof window === "undefined") return;
    window.addEventListener("message", (e) => {
        if (e.source !== window || e.origin !== window.location.origin) return;
        const msg = e.data;
        if (!msg || msg.tag !== TAG) return;
        if (msg.type === "ready") {
            // `stream` says whether this engine can hand the script a body as
            // it arrives. Tampermonkey can; Stay cannot, and generation asks
            // for the finished image instead.
            ready = { version: msg.version, stream: msg.stream !== false, handler: msg.handler };
            waiting?.resolve(ready);
            for (const notify of observers) notify(ready);
            return;
        }
        calls.get(msg.id)?.(msg);
    });
}
listen();

function post(msg) {
    window.postMessage({ ...msg, tag: TAG }, window.location.origin);
}

/** Ask the script for its current connection; late replies still notify observers. */
export function detectDirect(timeout = 400) {
    if (typeof window === "undefined") return Promise.resolve(null);
    if (ready) return Promise.resolve(ready);
    if (waiting) return waiting.promise;

    let resolve;
    const promise = new Promise((r) => (resolve = r));
    waiting = { promise, resolve };
    post({ type: "hello" });
    setTimeout(() => resolve(ready), timeout);
    return promise.then((v) => {
        waiting = null;
        return v ?? null;
    });
}

/** Keep the UI in sync when the userscript starts after the initial handshake. */
export function subscribeDirect(notify) {
    observers.add(notify);
    notify(ready);
    return () => observers.delete(notify);
}

/** Whether the script answered earlier in this page's life. */
export function directReady() {
    return ready;
}

/** Remember that this engine's streaming is unusable, for the rest of the page. */
export function markNoStream() {
    post({ type: "no-stream" });
    if (ready) ready = { ...ready, stream: false };
}

/**
 * One request, made by the script, answered as a Response.
 *
 * `stream` asks for the body as it arrives, which is what keeps the progress
 * images coming. An engine that cannot do that says so, and the caller is told
 * to ask again without it rather than being left with half a feature.
 */
export function directFetch(url, { method = "GET", headers = {}, body, signal, stream = false } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        let controller = null;
        let head = null;
        let opened = false; // the promise has been resolved with a Response

        const finish = () => {
            calls.delete(id);
            signal?.removeEventListener("abort", onAbort);
        };
        const fail = (err) => {
            finish();
            if (opened) controller?.error(err);
            else reject(err);
        };
        const onAbort = () => {
            post({ type: "abort", id });
            fail(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort);

        calls.set(id, (msg) => {
            if (msg.type === "head") {
                head = msg;
                if (!stream) return; // the body arrives whole, at "done"
                if (opened) return;
                opened = true;
                resolve(
                    response(
                        new ReadableStream({
                            start: (c) => (controller = c),
                            cancel: () => post({ type: "abort", id }),
                        }),
                        head,
                    ),
                );
            } else if (msg.type === "chunk") {
                controller?.enqueue(new Uint8Array(msg.chunk));
            } else if (msg.type === "done") {
                if (stream) controller?.close();
                else resolve(response(msg.body ?? new ArrayBuffer(0), head));
                finish();
            } else if (msg.type === "error") {
                if (msg.message === "no-stream") {
                    // Remembered, so the next call asks for the whole thing
                    // rather than discovering this again.
                    post({ type: "no-stream" });
                    if (ready) ready = { ...ready, stream: false };
                }
                fail(new Error(msg.message));
            }
        });

        post({ type: "request", id, method, url, headers, body, stream });
    });
}

const NO_BODY = new Set([204, 205, 304]);

/**
 * The bridge's reply as a Response.
 *
 * Not every engine has a status to give at the moment the headers arrive — Stay
 * on iOS reports 0 while the request is still in flight — and Response refuses
 * anything outside 200..599, so an unknown status is read as a plain 200 and
 * the body is left to speak for itself.
 */
function response(body, head) {
    const said = Number(head?.status);
    const status = said >= 200 && said <= 599 ? said : 200;
    return new Response(NO_BODY.has(status) ? null : body, {
        status,
        statusText: typeof head?.statusText === "string" ? head.statusText : "",
        headers: head?.headers ?? {},
    });
}
