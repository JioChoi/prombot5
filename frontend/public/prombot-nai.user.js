// ==UserScript==
// @name         Prombot Direct
// @namespace    https://prombot.net/
// @version      1.3.3
// @description  Sends Prombot's NovelAI requests straight from your device instead of through a shared proxy, so your account is the only one on your IP address.
// @author       Prombot
// @match        https://prombot.net/*
// @match        https://www.prombot.net/*
// @include      /^http:\/\/(localhost|127\.0\.0\.1):8092\//
// @connect      image.novelai.net
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

/* What this does, in one paragraph.

   A browser will not let prombot.net call novelai.net directly: NovelAI's
   servers do not send the CORS headers that would allow it, so the site has to
   route generation through a relay, and NovelAI sees the relay's IP address
   rather than yours. A userscript is not bound by that rule — GM_xmlhttpRequest
   is made by the extension, not by the page — so with this installed the
   request leaves your own device and carries your own address.

   The script only relays what the page asks for, and only to image.novelai.net.
   It never reads, stores or sends your API key anywhere else: the key travels
   in the request the page hands over, exactly as it would have gone to the
   relay. Nothing is written to disk, and nothing is sent to prombot.net.

   The page and the script talk over window.postMessage, both ways checked
   against the page's own origin. */

(function () {
    "use strict";

    const TAG = "prombot-nai";
    // MessageEvent.source is the page window, not Tampermonkey's sandbox wrapper.
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const ALLOWED = "https://image.novelai.net";
    const VERSION = "1.3.3";

    // GM.xmlHttpRequest is the promise-flavoured name; Stay on iOS ships that
    // one, Tampermonkey ships both.
    const xhr =
        typeof GM_xmlhttpRequest === "function"
            ? GM_xmlhttpRequest
            : typeof GM !== "undefined" && GM.xmlHttpRequest
              ? GM.xmlHttpRequest.bind(GM)
              : null;

    if (!xhr) return;

    /* Streaming keeps the progress images alive: NovelAI sends a JPEG every few
       steps down the same response, and the app shows each one as it lands.

       The body is read as text in a charset that maps one byte to one character
       — that is what x-user-defined is for, and `& 0xFF` undoes it, since some
       engines return those bytes at U+F700 instead of U+0000. So responseText
       as it grows is the bytes as they arrive, and the request ends where the
       engine says it ends.

       Tampermonkey's own responseType:"stream" is not used, though it exists:
       its reader hands over every progress chunk and then never reports the end
       of the body, and no completion callback fires either, so a generation
       that has already finished never comes back. */
    // Only reported to the page, for the badge in the header.
    const HANDLER = (() => {
        try {
            return (typeof GM_info !== "undefined" && GM_info.scriptHandler) || "";
        } catch {
            return "";
        }
    })();

    function post(msg, transfer) {
        window.postMessage({ ...msg, tag: TAG }, window.location.origin, transfer || []);
    }

    const running = new Map(); // id -> abort handle

    function send({ id, method, url, headers, body, stream }) {
        if (!url.startsWith(ALLOWED + "/")) {
            post({ type: "error", id, message: `Refused: ${url} is not NovelAI` });
            return;
        }
        let opened = false;
        const options = {
            method: method || "GET",
            url,
            headers: headers || {},
            data: body,
            // Unset while streaming: naming a type stops some engines from
            // filling responseText in as the body arrives.
            ...(stream ? {} : { responseType: "arraybuffer" }),
            // The page decides what a status means; a 401 is an answer, not a
            // transport failure.
            onerror: (e) => post({ type: "error", id, message: e?.error || "Network error" }),
            ontimeout: () => post({ type: "error", id, message: "NovelAI timed out" }),
            onabort: () => post({ type: "error", id, message: "Aborted" }),
        };

        const head = (res, again) => {
            if (opened && !again) return;
            opened = true;
            post({
                type: "head",
                id,
                status: res.status,
                statusText: res.statusText || "",
                headers: parseHeaders(res.responseHeaders || ""),
            });
        };

        if (stream) {
            // One byte per character, so the text that has arrived so far is
            // the bytes that have arrived so far. responseType is left unset on
            // purpose: naming it stops some engines from filling responseText
            // in as the body arrives, which is the whole trick.
            options.overrideMimeType = "text/plain; charset=x-user-defined";
            let sent = 0;
            const drain = (res) => {
                const text = res.responseText;
                if (typeof text !== "string" || text.length <= sent) return;
                const part = text.slice(sent);
                sent = text.length;
                const bytes = new Uint8Array(part.length);
                for (let i = 0; i < part.length; i++) bytes[i] = part.charCodeAt(i) & 0xff;
                post({ type: "chunk", id, chunk: bytes.buffer }, [bytes.buffer]);
            };
            options.onprogress = (res) => {
                head(res);
                drain(res);
            };
            options.onload = (res) => {
                head(res);
                drain(res);
                running.delete(id);
                if (sent === 0) {
                    // The engine kept the body from us entirely. This request
                    // is over, so asking again for the finished image is not a
                    // second concurrent generation.
                    post({ type: "error", id, message: "no-stream" });
                    return;
                }
                post({ type: "done", id });
            };
        } else {
            options.onload = (res) => {
                // Sent again here even if the headers were announced earlier:
                // some engines only know the real status once the whole body
                // has arrived, and report 0 until then.
                head(res, true);
                const buf = res.response instanceof ArrayBuffer
                    ? res.response
                    : new TextEncoder().encode(res.responseText || "").buffer;
                post({ type: "done", id, body: buf }, [buf]);
                running.delete(id);
            };
        }

        try {
            const handle = xhr(options);
            if (handle && typeof handle.abort === "function") {
                running.set(id, () => handle.abort());
            }
        } catch (e) {
            post({ type: "error", id, message: String(e?.message || e) });
        }
    }

    /** "a: b\r\nc: d" -> { a: "b", c: "d" } */
    function parseHeaders(raw) {
        const out = {};
        for (const line of String(raw).split(/\r?\n/)) {
            const at = line.indexOf(":");
            if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
        return out;
    }

    window.addEventListener("message", (e) => {
        if (e.source !== pageWindow || e.origin !== window.location.origin) return;
        const msg = e.data;
        if (!msg || msg.tag !== TAG) return;
        if (msg.type === "hello") {
            post({ type: "ready", version: VERSION, stream: true, handler: HANDLER });
        } else if (msg.type === "request") {
            send(msg);
        } else if (msg.type === "abort") {
            running.get(msg.id)?.();
            running.delete(msg.id);
        }
    });

    // Announce once at load: the page may be listening before it asks.
    post({ type: "ready", version: VERSION, stream: true, handler: HANDLER });
})();
