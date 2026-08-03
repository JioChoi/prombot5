import { History, Infinity as InfinityIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import BottomSheet from "./components/BottomSheet.jsx";
import HistoryDrawer from "./components/HistoryDrawer.jsx";
import LoginSheet from "./components/LoginSheet.jsx";
import SettingsSheet from "./components/SettingsSheet.jsx";
import usePersistentState from "./hooks/usePersistentState.js";
import { keepAwake, releaseAwake } from "./lib/keepAwake.js";
import { REJECTED, generate, verifyToken } from "./lib/nai.js";
import { buildRequest } from "./lib/naiRequest.js";
import { buildPrompt } from "./lib/prompt.js";
import { buildQuery, randomPrompt, warmPromptIndex } from "./lib/promptIndex.js";
import { useSetting } from "./state/settings.jsx";

const ANLAS = "rgb(245, 243, 194)";

const clock = () =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** 2026-08-02_141233 — sorts chronologically in a folder listing. */
function stamp(at = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return (
        `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
        `_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
    );
}

function download(src, name) {
    const a = document.createElement("a");
    a.href = src;
    a.download = name;
    // Firefox needs the link in the document for a programmatic click to count.
    document.body.appendChild(a);
    a.click();
    a.remove();
}

/* NovelAI's own anlas.svg, inlined: one path is smaller than the request that
   would fetch it, and it takes currentColor so the badge tints icon and number
   together. */
function AnlasIcon() {
    return (
        <svg
            aria-hidden
            viewBox="0 0 10 9"
            className="h-[11px] w-[12px] shrink-0"
            fill="currentColor"
        >
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M4.48874 0H5.51107L7.14867 1.60183L5.45731 8.99994H4.54284L2.85142 1.60156L4.48874 0ZM7.47144 9L10 5.04294V4.39087L8.65736 3.07756L8.24906 3.18423L6.91946 9H7.47144ZM3.08069 9L1.7543 3.19828L1.33187 3.08792L0 4.39069V5.04271L2.52871 9H3.08069Z"
            />
        </svg>
    );
}

export default function App() {
    const [sheetOpen, setSheetOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [shots, setShots] = useState([]);
    const [activeId, setActiveId] = useState(null);
    const [autoGen, setAutoGen] = useState(false);
    const [loginOpen, setLoginOpen] = useState(false);
    const [token, setToken] = usePersistentState("naiToken", "");
    const [anlas, setAnlas] = useState(null);
    // The in-flight generation: its latest progress image, and how long is left
    // of the pause before the next one.
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [waitLeft, setWaitLeft] = useState(null);
    const [error, setError] = useState("");
    // The loop is started once and runs across many renders, so reading the
    // state directly would give it whatever `autoGen` was when it started.
    // Switching back to single has to reach a loop that is already going.
    const autoRef = useRef(autoGen);
    useEffect(() => {
        autoRef.current = autoGen;
    }, [autoGen]);

    // Generating must not wait on a download that could have happened while the
    // page was idle. Failures are ignored on purpose: each loader retries when
    // something actually needs it, and there is nothing to say here yet.
    useEffect(() => {
        warmPromptIndex().catch(() => {});
    }, []);

    // A stored key can be revoked or expire between visits. Check it once on load so
    // that shows up as the login prompt rather than as a failed generation later.
    // Only 401 clears it — a dead backend or dropped connection says nothing about
    // whether the key is still good, and logging out over that would be wrong.
    useEffect(() => {
        if (!token) {
            setAnlas(null);
            return;
        }
        verifyToken(token).then(setAnlas, (e) => {
            if (e.message === REJECTED) setToken("");
        });
    }, [token, setToken]);

    const [beginning] = useSetting("beginning");
    const [ending] = useSetting("ending");
    const [negative] = useSetting("negative");
    const [characters] = useSetting("characters");
    const [useCoords] = useSetting("useCoords");
    const [randomize] = useSetting("randomize");
    const [include] = useSetting("include");
    const [exclude] = useSetting("exclude");
    const [minScore] = useSetting("minScore");
    const [filters] = useSetting("filters");
    const [extras] = useSetting("extras");

    const [model] = useSetting("model");
    const [width] = useSetting("width");
    const [height] = useSetting("height");
    const [steps] = useSetting("steps");
    const [guidance] = useSetting("guidance");
    const [rescale] = useSetting("rescale");
    const [sampler] = useSetting("sampler");
    const [noiseSchedule] = useSetting("noiseSchedule");
    const [seed] = useSetting("seed");
    const [varietyPlus] = useSetting("varietyPlus");

    const [delay] = useSetting("delay");
    const [autoDownload] = useSetting("autoDownload");

    const active = shots.find((h) => h.id === activeId) ?? shots[0];

    /** One image, start to finish. Throws so the loop below can stop on failure. */
    async function once() {
        // With the draw switched off the prompt is only the pinned text, so no
        // post is fetched and nothing can fail to match.
        const post = randomize
            ? await randomPrompt(buildQuery({ include, exclude, minScore, filters }))
            : { tags: [], cats: [] };
        if (!post) throw new Error("No prompt matches these filters");

        const prompt = await buildPrompt({
            beginning,
            ending,
            post,
            reorder: extras.reorder,
            reformat: extras.reformat,
            dropRating: extras.dropRating,
        });

        const { body } = buildRequest({
            prompt,
            settings: {
                model, negative, characters, useCoords,
                width, height, steps, guidance, rescale, sampler, noiseSchedule, seed,
                varietyPlus,
            },
        });

        const blob = await generate(token, body, {
            // Each progress image replaces the last, and the one it replaces is
            // released — a 5-step run leaks four object URLs otherwise.
            onPreview: (jpeg) =>
                setPreview((old) => {
                    if (old) URL.revokeObjectURL(old);
                    return URL.createObjectURL(jpeg);
                }),
        });

        const at = new Date();
        const name = `nai_${stamp(at)}.png`;
        const src = URL.createObjectURL(blob);
        // The Blob is kept, not just its URL: the zip export needs the bytes
        // back, and re-fetching an object URL to get them is a round trip for
        // data already in memory.
        setShots((s) => [
            { id: at.getTime(), src, blob, name, title: prompt, time: clock() },
            ...s,
        ]);
        setActiveId(null);
        if (autoDownload) download(src, name);
    }

    /** Counts the pause down, and gives up the moment automation is switched off.
        Returns whether the loop should carry on. */
    async function pause() {
        const until = performance.now() + delay * 1000;
        for (;;) {
            const left = until - performance.now();
            if (left <= 0 || !autoRef.current) break;
            setWaitLeft(left / 1000);
            await new Promise((r) => setTimeout(r, 100));
        }
        setWaitLeft(null);
        return autoRef.current;
    }

    async function run() {
        if (busy) return;
        setBusy(true);
        setError("");
        // From the press, so the audio counts as gesture-initiated.
        keepAwake();
        try {
            for (;;) {
                try {
                    await once();
                    setError("");
                } catch (e) {
                    setError(e.message);
                    // One failed image should not end an unattended run — a
                    // dropped connection while the phone is asleep is the
                    // normal case, not a reason to stop for good.
                    if (!autoRef.current) break;
                }
                // The pause sits between images, never before the first: it
                // paces a loop, it is not a delay on pressing the button. Both
                // checks read the ref, so switching to single stops the loop
                // whether it happens mid-image or mid-countdown.
                if (!autoRef.current) break;
                if (!(await pause())) break;
            }
        } finally {
            releaseAwake();
            setWaitLeft(null);
            setBusy(false);
            setPreview((old) => {
                if (old) URL.revokeObjectURL(old);
                return null;
            });
            // Generation spends Anlas, so the badge is stale the moment one lands.
            verifyToken(token).then(setAnlas, () => {});
        }
    }

    return (
        <div className="relative h-svh w-full overflow-hidden bg-well">
            {/* Anlas balance. Hidden until logged in, since there is no number to
                show and the corner is better left empty than filled with a dash. */}
            {anlas === null ? null : (
                <div
                    className="fixed right-3 z-30 flex items-center gap-1.5 rounded-full border border-hair
                               bg-[#33333a]/60 px-2.5 py-1 backdrop-blur-2xl
                               shadow-[inset_0_1px_0_0_rgb(255_255_255/0.14)]"
                    style={{ top: "calc(0.75rem + env(safe-area-inset-top))", color: ANLAS }}
                >
                    <AnlasIcon />
                    <span className="num text-[12.5px] font-medium tabular-nums">
                        {anlas.toLocaleString()}
                    </span>
                </div>
            )}

            {/* Stage. The progress image wins while one is running — that is the
                whole point of streaming — and the last finished image otherwise. */}
            {/* md:pl clears the sidebar, which is always open at that width. */}
            <main
                className="absolute inset-0 flex flex-col items-center justify-center gap-3
                           px-2 pb-24 pt-3 md:pl-[var(--sidebar)]"
            >
                {preview || active ? (
                    <img
                        src={preview ?? active.src}
                        alt={active?.title ?? "Generating"}
                        className="max-h-[70svh] w-auto max-w-full object-contain
                                   shadow-[0_1px_0_0_rgb(255_255_255/0.16),0_30px_70px_-24px_rgb(0_0_0/0.7)]"
                    />
                ) : (
                    <p className="max-w-[22rem] text-center text-[13px] leading-relaxed text-dim">
                        {busy
                            ? "Drawing a prompt…"
                            : token
                              ? "Press Generate. Settings live in the sheet below."
                              : "Log in with a NovelAI API key to start."}
                    </p>
                )}
                {error ? (
                    <p
                        role="alert"
                        className="max-w-[22rem] text-center text-[12px] leading-snug text-red-400"
                    >
                        {error}
                    </p>
                ) : null}
            </main>

            {/* Console — floats over the sheet (z-40 > z-30), so Generate stays
                reachable while settings are open. */}
            <div
                className="fixed inset-x-0 bottom-0 z-40 px-3 md:pl-[calc(var(--sidebar)+0.75rem)]"
                style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
            >
                {/* Capped and centred once there is width: a console stretched
                    across a desktop monitor is all gap and no controls. */}
                <div
                    className="mx-auto max-w-[560px] overflow-hidden rounded-[22px] border border-hair
                               bg-[#33333a]/60 backdrop-blur-2xl
                               shadow-[inset_0_1px_0_0_rgb(255_255_255/0.14),0_18px_50px_-16px_rgb(0_0_0/0.65)]"
                >
                    <div className="flex items-center gap-2 p-2">
                        {/* How many images one press makes: a single image, or a
                            loop that keeps going until you stop it. */}
                        <button
                            type="button"
                            aria-pressed={autoGen}
                            aria-label={
                                autoGen
                                    ? "Repeating until stopped. Switch to a single image"
                                    : "Single image. Switch to repeating until stopped"
                            }
                            onClick={() => setAutoGen((v) => !v)}
                            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px]
                                        border transition-colors ${
                                            autoGen
                                                ? "border-live/50 bg-live/20 text-live"
                                                : "border-hair bg-panel-2 text-mut"
                                        }`}
                        >
                            {autoGen ? (
                                <InfinityIcon strokeWidth={2.25} className="h-5 w-5" />
                            ) : (
                                <span className="text-[15px] font-semibold">1</span>
                            )}
                        </button>

                        {/* Without a token there is nothing to generate with, so the
                            primary action becomes the thing that unblocks it. */}
                        {/* Busy the whole time a run is going, countdown included:
                            the wait is part of the run, not a gap to press into.
                            The ∞ switch beside it is what stops a loop. */}
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => (token ? run() : setLoginOpen(true))}
                            className="lit flex h-12 flex-1 items-center justify-center rounded-[15px]
                                       bg-white text-[15px] font-semibold text-[#17171a]
                                       transition-transform active:scale-[0.985]
                                       disabled:bg-panel-2 disabled:text-mut"
                        >
                            {waitLeft !== null
                                ? `${waitLeft.toFixed(1)}s`
                                : busy
                                  ? "Generating…"
                                  : token
                                    ? "Generate"
                                    : "Log in with NovelAI"}
                        </button>

                        <button
                            type="button"
                            onClick={() => setHistoryOpen(true)}
                            aria-label="Open history"
                            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px]
                                       border border-hair bg-panel-2 text-mut transition-colors active:text-fg"
                        >
                            <History strokeWidth={1.75} className="h-[18px] w-[18px]" />
                        </button>
                    </div>
                </div>
            </div>

            <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SettingsSheet />
            </BottomSheet>

            <LoginSheet
                open={loginOpen}
                onClose={() => setLoginOpen(false)}
                onToken={setToken}
            />

            <HistoryDrawer
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                items={shots}
                activeId={active?.id ?? null}
                onPick={(id) => {
                    setActiveId(id);
                    setHistoryOpen(false);
                }}
            />
        </div>
    );
}
