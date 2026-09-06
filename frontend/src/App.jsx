import { Bookmark, History, Infinity as InfinityIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import BottomSheet from "./components/BottomSheet.jsx";
import CharactersTab from "./components/CharactersTab.jsx";
import HistoryDrawer from "./components/HistoryDrawer.jsx";
import LoginSheet from "./components/LoginSheet.jsx";
import PresetsDrawer from "./components/PresetsDrawer.jsx";
import SettingsSheet from "./components/SettingsSheet.jsx";
import usePersistentState from "./hooks/usePersistentState.js";
import { keepAwake, releaseAwake } from "./lib/keepAwake.js";
import { REJECTED, generate, verifyToken } from "./lib/nai.js";
import { buildRequest } from "./lib/naiRequest.js";
import { buildPrompt, fillCharacters } from "./lib/prompt.js";
import {
    buildQuery,
    onDrawProgress,
    onWarmProgress,
    randomPrompt,
    warmPromptIndex,
} from "./lib/promptIndex.js";
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

/** The two screens. Both stay mounted — switching is a `hidden`, never an
    unmount, so a half-typed prompt, a running loop and the character list's
    scroll position all survive the trip. */
function TabBar({ tab, onTab }) {
    return (
        <div
            className="fixed left-1/2 z-50 -translate-x-1/2"
            style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
        >
            <div
                role="tablist"
                className="flex gap-1 rounded-full border border-hair bg-[#33333a]/60 p-1
                           backdrop-blur-2xl
                           shadow-[inset_0_1px_0_0_rgb(255_255_255/0.14)]"
            >
                {[
                    ["generate", "Generate"],
                    ["characters", "Characters"],
                ].map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        onClick={() => onTab(id)}
                        className={`rounded-full px-3.5 py-1 text-[12.5px] font-medium
                                    transition-colors ${
                                        tab === id
                                            ? "bg-white/16 text-fg shadow-[inset_0_1px_0_0_rgb(255_255_255/0.22)]"
                                            : "text-dim"
                                    }`}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}

export default function App() {
    const [tab, setTab] = useState("generate");
    const [sheetOpen, setSheetOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [shots, setShots] = useState([]);
    const [activeId, setActiveId] = useState(null);
    const [autoGen, setAutoGen] = useState(false);
    const [loginOpen, setLoginOpen] = useState(false);
    const [presetsOpen, setPresetsOpen] = useState(false);
    // Which preset the console is currently holding. Kept across reloads so the
    // drawer opens on the one you were working in, ready to overwrite.
    const [preset, setPreset] = usePersistentState("preset", "");
    const [token, setToken] = usePersistentState("naiToken", "");
    const [anlas, setAnlas] = useState(null);
    // The in-flight generation: its latest progress image, and how long is left
    // of the pause before the next one.
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const [waitLeft, setWaitLeft] = useState(null);
    const [error, setError] = useState("");
    // Fraction of the prompt index downloaded, 1 once there is nothing to wait
    // for. A few megabytes on a slow connection is a long silence otherwise.
    const [warm, setWarm] = useState(0);
    // The same for a draw in flight: picking a post is a chain of range
    // requests, and on a phone that is seconds of nothing happening.
    const [drawn, setDrawn] = useState(1);
    const [onDraw, setOnDraw] = useState(false);
    // Whether the finished prompt is laid over the image on the stage.
    const [showPrompt, setShowPrompt] = useState(false);
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
        onWarmProgress(setWarm);
        onDrawProgress(setDrawn);
        // Whether it worked or not the bar has nothing left to say.
        warmPromptIndex().then(
            () => setWarm(1),
            () => setWarm(1),
        );
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
    const [omit] = useSetting("omit");
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
    const [background] = useSetting("background");

    const active = shots.find((h) => h.id === activeId) ?? shots[0];

    /* The draw for the *next* image, started while the current one is still
       being painted. A draw is several round trips and an image is fifteen
       seconds, so overlapping them hides the wait completely in a loop, and
       makes the second press of Generate instant. Keyed by the query it was
       drawn for: change a filter and the held post is no longer an answer to
       the question being asked. */
    const ahead = useRef(null);

    function nextPost(query) {
        const key = JSON.stringify(query);
        const held = ahead.current;
        ahead.current = null;
        // Failures are not cached — a dropped prefetch should cost a retry,
        // not the whole run.
        return held?.key === key ? held.post.then((p) => p ?? randomPrompt(query)) : randomPrompt(query);
    }

    function prefetch(query) {
        const key = JSON.stringify(query);
        if (ahead.current?.key === key) return;
        ahead.current = { key, post: randomPrompt(query).catch(() => null) };
    }

    /** One image, start to finish. Throws so the loop below can stop on failure. */
    async function once() {
        // With the draw switched off the prompt is only the pinned text, so no
        // post is fetched and nothing can fail to match.
        const query = randomize ? buildQuery({ include, exclude, minScore, filters }) : null;
        let post;
        try {
            // Only a draw someone is waiting on gets the bar; a prefetch runs
            // behind an image nobody is watching a progress bar for.
            setOnDraw(true);
            post = query ? await nextPost(query) : { tags: [], cats: [] };
        } finally {
            setOnDraw(false);
        }
        if (!post) throw new Error("No prompt matches these filters");

        const prompt = await buildPrompt({
            beginning,
            ending,
            negative,
            characters,
            post,
            omit,
            ...extras,
        });

        // The cast is filled in separately: a name in a character's own caption
        // is where NovelAI reads who that character is, and what they bring
        // belongs in that caption rather than in the base prompt.
        const cast = await fillCharacters(characters, {
            beginning,
            ending,
            negative,
            ...extras,
        });

        const { body } = buildRequest({
            prompt,
            settings: {
                model, negative, characters: cast, useCoords,
                width, height, steps, guidance, rescale, sampler, noiseSchedule, seed,
                varietyPlus,
            },
        });

        // The request is away; the next draw rides along beside it.
        if (query) prefetch(query);

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
        // Drop the progress image here, not when the run ends: the stage prefers
        // the preview over the finished shot, so a loop that kept it would show
        // the last JPEG right through the countdown and into the next image —
        // the finished PNG would never appear at all.
        setPreview((old) => {
            if (old) URL.revokeObjectURL(old);
            return null;
        });
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
        keepAwake({ audible: background });
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
            {/* Prompt index download, then the draw that waits on it. A hairline
                across the very top edge — above the notch, since it is status,
                not something to press. One bar, because the two never overlap:
                nothing can be drawn until the index is down. */}
            {warm < 1 || (onDraw && drawn < 1) ? (
                <div
                    role="progressbar"
                    aria-label={warm < 1 ? "Downloading prompt data" : "Drawing a prompt"}
                    aria-valuenow={Math.round((warm < 1 ? warm : drawn) * 100)}
                    className="fixed inset-x-0 top-0 z-[60] h-[3px] bg-white/10"
                >
                    <div
                        className="h-full bg-accent-lit transition-[width] duration-200"
                        style={{ width: `${(warm < 1 ? warm : drawn) * 100}%` }}
                    />
                </div>
            ) : null}

            <TabBar tab={tab} onTab={setTab} />

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

            {/* Hidden, not unmounted: a loop started here keeps running while the
                character list is open, and comes back exactly as it was. */}
            <div className={tab === "generate" ? "contents" : "hidden"}>
            {/* Presets. Top-left of the stage — pushed clear of the sidebar at the
                width where the sidebar exists, the same offset the dock uses. The
                loaded preset's name rides along, so the console always says which
                setup you are in. */}
            <button
                type="button"
                onClick={() => setPresetsOpen(true)}
                aria-label={preset ? `Presets — ${preset} loaded` : "Presets"}
                className="fixed left-3 z-40 flex max-w-[45vw] items-center gap-1.5 rounded-full border
                           border-hair bg-[#33333a]/60 px-2.5 py-1.5 text-mut backdrop-blur-2xl
                           transition-colors active:text-fg
                           shadow-[inset_0_1px_0_0_rgb(255_255_255/0.14)]
                           md:left-[calc(var(--sidebar)+0.75rem)]"
                style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
            >
                <Bookmark
                    strokeWidth={1.75}
                    className={`h-[15px] w-[15px] shrink-0 ${preset ? "text-accent-lit" : ""}`}
                />
                {preset ? (
                    <span className="truncate text-[12.5px] font-medium text-fg">{preset}</span>
                ) : null}
            </button>

            {/* Stage. The progress image wins while one is running — that is the
                whole point of streaming — and the last finished image otherwise. */}
            {/* md:pl clears the sidebar, which is always open at that width. */}
            <main
                className="absolute inset-0 flex flex-col items-center justify-center gap-3
                           px-2 pb-24 pt-3 md:pl-[var(--sidebar)]"
            >
                {preview || active ? (
                    /* Tap to read what was actually sent, tap again to go back
                       to the picture. The scrim is the image's own box, not the
                       screen, so the prompt reads as belonging to it. */
                    <button
                        type="button"
                        onClick={() => setShowPrompt((v) => !v)}
                        aria-pressed={showPrompt}
                        aria-label={showPrompt ? "Hide prompt" : "Show prompt"}
                        className="relative max-h-[70svh] w-auto max-w-full"
                    >
                        <img
                            src={preview ?? active.src}
                            alt={active?.title ?? "Generating"}
                            className="max-h-[70svh] w-auto max-w-full object-contain
                                       shadow-[0_1px_0_0_rgb(255_255_255/0.16),0_30px_70px_-24px_rgb(0_0_0/0.7)]"
                        />
                        {showPrompt && active?.title ? (
                            <div
                                className="scroll-thin absolute inset-0 overflow-y-auto overscroll-contain
                                           bg-black/75 p-4 text-left backdrop-blur-[2px]"
                            >
                                <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-white">
                                    {active.title}
                                </p>
                            </div>
                        ) : null}
                    </button>
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

            {/* Inside the wrapper: settings belong to generating, so the sidebar
                and the sheet's grabber go away with the rest of it and the
                character grid gets the whole width. */}
            <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SettingsSheet />
            </BottomSheet>
            </div>

            <div className={tab === "characters" ? "contents" : "hidden"}>
                <CharactersTab
                    active={tab === "characters"}
                    onGenerate={() => setTab("generate")}
                />
            </div>

            <LoginSheet
                open={loginOpen}
                onClose={() => setLoginOpen(false)}
                onToken={setToken}
            />

            <PresetsDrawer
                open={presetsOpen}
                onClose={() => setPresetsOpen(false)}
                token={token}
                current={preset}
                onCurrent={setPreset}
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
