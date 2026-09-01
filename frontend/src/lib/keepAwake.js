/* Keeping a long automation run alive on a phone.
 *
 * There is no API that lets a web page keep working after iOS Safari is closed
 * or swiped away — no background threads, no timers, no service worker that can
 * wake itself. Background Sync and Periodic Background Sync are not implemented
 * in Safari at all, and Web Push cannot schedule the page's own code. So the
 * honest ceiling is: the tab keeps running while Safari is alive, and stops when
 * it is not.
 *
 * Two things push that ceiling as far as it goes:
 *
 *   Wake Lock  — stops the screen locking, which is what otherwise suspends the
 *                page a minute into an unattended run. Foreground only, and iOS
 *                drops it whenever the tab is hidden, so it is re-taken on the
 *                way back.
 *   Silent audio — an <audio> element that is actually playing holds an audio
 *                session, and iOS keeps a page with an audio session running
 *                when Safari goes to the background. It must be audible to the
 *                system (muted elements do not hold a session), so this plays a
 *                near-silent tone at a very low volume, and it must be started
 *                from a user gesture — the Generate press is that gesture.
 *
 * ponytail: best-effort by construction. If a run has to survive the phone
 * being locked or the app being closed, the loop belongs on a server, not here.
 */

/** One second of near-silence as a WAV, small enough to build rather than ship.
    8-bit unsigned PCM is centred on 128, so a constant 128 is silence. */
function silentWav(seconds = 1, rate = 8000) {
    const samples = seconds * rate;
    const buf = new ArrayBuffer(44 + samples);
    const view = new DataView(buf);
    const ascii = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));

    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true); // PCM header length
    view.setUint16(20, 1, true); // format: PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true); // byte rate: rate * channels * bytes
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits per sample
    ascii(36, "data");
    view.setUint32(40, samples, true);
    new Uint8Array(buf, 44).fill(128);

    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

let audio = null;
let lock = null;
let on = false;

async function takeLock() {
    if (!on || lock || document.visibilityState !== "visible") return;
    try {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => {
            lock = null;
        });
    } catch {
        // Denied, unsupported, or the tab lost focus mid-request. The run
        // continues either way — this only buys time, it is not load-bearing.
    }
}

function onVisibility() {
    // iOS releases the lock on hide and will not restore it by itself.
    if (document.visibilityState === "visible") takeLock();
}

/** Call from a user gesture, or the audio will not be allowed to start.
    `audible` off drops the audio session — the run then stops when the tab
    goes to the background, and only the screen lock is held off. */
export function keepAwake({ audible = true } = {}) {
    if (on) return;
    on = true;

    if (audible && !audio) {
        audio = new Audio(silentWav());
        audio.loop = true;
        // Not muted: a muted element holds no audio session, which is the
        // entire point. Low enough to be inaudible in practice.
        audio.volume = 0.001;
        audio.setAttribute("playsinline", "");
    }
    if (audible) audio.play().catch(() => {});

    if (navigator.wakeLock) {
        document.addEventListener("visibilitychange", onVisibility);
        takeLock();
    }
}

export function releaseAwake() {
    on = false;
    audio?.pause();
    document.removeEventListener("visibilitychange", onVisibility);
    lock?.release().catch(() => {});
    lock = null;
}
