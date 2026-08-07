import { ChevronDown, ChevronUp, Dices, Eye, EyeOff, Loader2, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { freeCell } from "../lib/position.js";
import { buildQuery, promptCount } from "../lib/promptIndex.js";
import { useSetting } from "../state/settings.jsx";
import Dropdown from "./Dropdown.jsx";
import PositionGrid from "./PositionGrid.jsx";
import {
    FieldRow,
    Group,
    IconButton,
    NumberBox,
    Pill,
    Rows,
    SliderRow,
    SwitchRow,
    TextArea,
} from "./ui.jsx";

const SIZE_GROUPS = [
    {
        header: "Normal",
        options: [
            { value: "832x1216", label: "Normal Portrait", note: "832 × 1216" },
            { value: "1216x832", label: "Normal Landscape", note: "1216 × 832" },
            { value: "1024x1024", label: "Normal Square", note: "1024 × 1024" },
        ],
    },
    {
        header: "Large",
        options: [
            { value: "1024x1536", label: "Large Portrait", note: "1024 × 1536" },
            { value: "1536x1024", label: "Large Landscape", note: "1536 × 1024" },
            { value: "1472x1472", label: "Large Square", note: "1472 × 1472" },
        ],
    },
    {
        header: "Wallpaper",
        options: [
            { value: "1088x1920", label: "Wallpaper Portrait", note: "1088 × 1920" },
            { value: "1920x1088", label: "Wallpaper Landscape", note: "1920 × 1088" },
        ],
    },
    {
        header: "Small",
        options: [
            { value: "512x768", label: "Small Portrait", note: "512 × 768" },
            { value: "768x512", label: "Small Landscape", note: "768 × 512" },
            { value: "640x640", label: "Small Square", note: "640 × 640" },
        ],
    },
    {
        header: "Custom",
        options: [{ value: "custom", label: "Custom" }],
    },
];

const SAMPLER_GROUPS = [
    {
        header: "Recommended",
        options: [
            { value: "k_euler_ancestral", label: "Euler Ancestral" },
            { value: "k_euler", label: "Euler" },
            { value: "k_dpmpp_2m_sde", label: "DPM++ 2M SDE" },
        ],
    },
    {
        header: "Other",
        options: [
            { value: "k_dpmpp_2m", label: "DPM++ 2M" },
            { value: "k_dpmpp_sde", label: "DPM++ SDE" },
            { value: "k_dpmpp_2s_ancestral", label: "DPM++ 2S Ancestral" },
            { value: "ddim", label: "DDIM" },
        ],
    },
];

const MODEL_GROUPS = [
    {
        options: [
            { value: "nai-diffusion-4-5-full", label: "NAI Diffusion V4.5 Full" },
            { value: "nai-diffusion-4-5-curated", label: "NAI Diffusion V4.5 Curated" },
        ],
    },
];

const NOISE_GROUPS = [
    {
        options: [
            { value: "karras", label: "Karras" },
            { value: "exponential", label: "Exponential" },
            { value: "polyexponential", label: "Polyexponential" },
        ],
    },
];

/* Stored as "remove this category" flags, but shown the other way round: a lit
   pill is a category the generator may use. Asking someone to switch things on
   in order to lose them is a trap. */
const FILTERS = [
    ["character", "Characters"],
    ["artist", "Artists"],
    ["copyright", "Series"],
    ["attire", "Attire"],
    ["characteristic", "Features"],
    ["expression", "Expressions"],
    ["nsfw", "NSFW"],
];

const PROCESSING = [
    ["reorder", "Reorder tags", "Sort into the model's preferred order"],
    ["reformat", "Reformat tags", "Normalize spacing, underscores, and escapes"],
    ["dropRating", "Remove rating tags", "Drop rating: tags from the generated tags only"],
    ["autoCopyright", "Add source series", "Include the series when a character is named"],
    ["strengthenCharacteristic", "Emphasize features", "Weight body and feature tags up"],
    ["strengthenAttire", "Emphasize attire", "Weight clothing tags up"],
];

const TABS = [
    ["prompt", "Prompt"],
    ["generator", "Generator"],
    ["options", "Options"],
    ["automation", "Automation"],
];

export default function SettingsSheet() {
    const [tab, setTab] = useState("prompt");

    const [beginning, setBeginning] = useSetting("beginning");
    const [ending, setEnding] = useSetting("ending");
    const [negative, setNegative] = useSetting("negative");
    const [characters, setCharacters] = useSetting("characters");
    const [useCoords, setUseCoords] = useSetting("useCoords");
    // Which field each character is showing. Not persisted: it says what you are
    // looking at, not what you configured.
    const [charTab, setCharTab] = useState({});
    const fieldOf = (id) => charTab[id] ?? "text";
    const [randomize, setRandomize] = useSetting("randomize");
    const [include, setInclude] = useSetting("include");
    const [exclude, setExclude] = useSetting("exclude");
    const [minScore, setMinScore] = useSetting("minScore");
    const [filters, setFilters] = useSetting("filters");
    const [extras, setExtras] = useSetting("extras");

    const [model, setModel] = useSetting("model");
    const [size, setSize] = useSetting("size");
    const [width, setWidth] = useSetting("width");
    const [height, setHeight] = useSetting("height");
    const [steps, setSteps] = useSetting("steps");
    const [guidance, setGuidance] = useSetting("guidance");
    const [seed, setSeed] = useSetting("seed");
    const [sampler, setSampler] = useSetting("sampler");
    const [varietyPlus, setVarietyPlus] = useSetting("varietyPlus");
    const [rescale, setRescale] = useSetting("rescale");
    const [noiseSchedule, setNoiseSchedule] = useSetting("noiseSchedule");

    const [delay, setDelay] = useSetting("delay");
    const [autoDownload, setAutoDownload] = useSetting("autoDownload");

    const allowed = FILTERS.filter(([k]) => !filters[k]).length;
    const skipped = characters.filter((c) => c.off).length;

    // How many posts the generator has to draw from. The index is only fetched
    // once the tab is open, and only after typing settles.
    const [matches, setMatches] = useState("Counting matching prompts…");
    const [counting, setCounting] = useState(true);
    useEffect(() => {
        if (tab !== "generator") return;
        let live = true;
        setCounting(true);
        const timer = setTimeout(() => {
            const query = buildQuery({ include, exclude, minScore, filters });
            // One call, one answer: exact when the posting lists are small
            // enough to read, sampled when they are not. Asking for both and
            // racing them left a band of queries where neither replied and the
            // previous number stayed on screen.
            promptCount(query).then(
                ({ n, exact }) =>
                    live &&
                    setMatches(
                        exact
                            ? `${n.toLocaleString()} prompts available`
                            : `about ${n.toLocaleString()} prompts`,
                    ),
                () => live && setMatches("Prompt index unavailable"),
            ).finally(() => live && setCounting(false));
        }, 300);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [tab, include, exclude, minScore, filters]);

    // Order is meaningful — NovelAI reads the cast in the order it is sent — so
    // swapping neighbours is the whole operation.
    function moveCharacter(i, dir) {
        setCharacters((cs) => {
            const next = [...cs];
            [next[i], next[i + dir]] = [next[i + dir], next[i]];
            return next;
        });
    }

    function pickSize(v) {
        setSize(v);
        if (v !== "custom") {
            const [w, h] = v.split("x").map(Number);
            setWidth(w);
            setHeight(h);
        }
    }

    return (
        <>
            <div className="shrink-0 px-3 pb-1">
                <div
                    role="tablist"
                    className="no-bar flex gap-1 overflow-x-auto rounded-[14px] border border-hair
                               bg-panel p-1"
                >
                    {TABS.map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={tab === id}
                            onClick={() => setTab(id)}
                            className={`shrink-0 flex-1 rounded-[10px] px-3 py-1.5 text-[13px] font-medium
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

            {/* The console floats over the bottom of this list. Rather than let
                rows sit half-hidden behind it, they dissolve as they reach it. */}
            <div
                className="scroll-thin flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-28 pt-4"
                style={{
                    maskImage:
                        "linear-gradient(180deg, #000 calc(100% - 104px), transparent calc(100% - 72px))",
                }}
            >
                {tab === "prompt" ? (
                    <>
                        <Group label="Beginning Prompt">
                            <TextArea
                                rows={3}
                                value={beginning}
                                onChange={setBeginning}
                                placeholder="masterpiece, best quality, very aesthetic"
                            />
                        </Group>

                        {/* One panel for the whole cast: separate panels per character
                            read as unrelated settings rather than as a list. */}
                        <Group
                            label="Characters"
                            hint={
                                skipped
                                    ? `${characters.length - skipped} of ${characters.length}`
                                    : `${characters.length}`
                            }
                        >
                            <Rows>
                                {/* Positions only matter once they are being sent, so
                                    the per-character pickers stay hidden until this is
                                    off. */}
                                <SwitchRow
                                    active={!useCoords}
                                    note="Let the model decide where each character stands"
                                    onClick={() => setUseCoords((v) => !v)}
                                >
                                    AI's choice of position
                                </SwitchRow>

                                {characters.map((c, i) => (
                                    <div key={c.id} className="space-y-1.5 px-3 py-2.5">
                                        {/* Fixed height: the position chip appears and
                                            disappears with the switch above, and a row
                                            that resized with it would shift every
                                            character label on the screen. */}
                                        <div className="flex h-7 items-center gap-2">
                                            {/* The number is the character's handle —
                                                it is what the grid shows in taken
                                                cells, so it reads as an index. */}
                                            <span
                                                className="num flex h-5 w-5 shrink-0 items-center justify-center
                                                           rounded-full bg-panel-3 text-[10.5px] text-mut"
                                            >
                                                {i + 1}
                                            </span>
                                            {/* These replace a "Character N" label —
                                                the numbered chip already says which
                                                one this is, and the row has no width
                                                to spare next to the actions. */}
                                            <div
                                                className={`flex gap-0.5 rounded-full bg-panel-3 p-0.5
                                                            ${c.off ? "opacity-45" : ""}`}
                                            >
                                                {[
                                                    ["text", "Prompt"],
                                                    ["negative", "Negative"],
                                                ].map(([field, label]) => (
                                                    <button
                                                        key={field}
                                                        type="button"
                                                        aria-pressed={fieldOf(c.id) === field}
                                                        onClick={() =>
                                                            setCharTab((t) => ({ ...t, [c.id]: field }))
                                                        }
                                                        className={`rounded-full px-2 py-0.5 text-[11px]
                                                                    transition-colors ${
                                                                        fieldOf(c.id) === field
                                                                            ? "bg-white/16 text-fg"
                                                                            : "text-dim"
                                                                    }`}
                                                    >
                                                        {label}
                                                        {/* A filled field you are not
                                                            looking at would otherwise
                                                            be invisible. */}
                                                        {c[field]?.trim() ? (
                                                            <span className="text-accent-lit"> •</span>
                                                        ) : null}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="ml-auto flex items-center gap-0.5">
                                                {useCoords ? (
                                                    <PositionGrid
                                                        n={i + 1}
                                                        label={`character ${i + 1}`}
                                                        value={c.x === undefined ? null : c}
                                                        taken={characters
                                                            .map((x, n) => ({ ...x, n: n + 1 }))
                                                            .filter(
                                                                (x) =>
                                                                    x.id !== c.id &&
                                                                    x.x !== undefined &&
                                                                    !x.off,
                                                            )}
                                                        onChange={(p) =>
                                                            setCharacters((cs) =>
                                                                cs.map((x) =>
                                                                    x.id === c.id ? { ...x, ...p } : x,
                                                                ),
                                                            )
                                                        }
                                                    />
                                                ) : null}
                                                <IconButton
                                                    label={`Move character ${i + 1} up`}
                                                    disabled={i === 0}
                                                    onClick={() => moveCharacter(i, -1)}
                                                >
                                                    <ChevronUp strokeWidth={2} className="h-3.5 w-3.5" />
                                                </IconButton>
                                                <IconButton
                                                    label={`Move character ${i + 1} down`}
                                                    disabled={i === characters.length - 1}
                                                    onClick={() => moveCharacter(i, 1)}
                                                >
                                                    <ChevronDown strokeWidth={2} className="h-3.5 w-3.5" />
                                                </IconButton>
                                                <IconButton
                                                    label={
                                                        c.off
                                                            ? `Include character ${i + 1}`
                                                            : `Skip character ${i + 1}`
                                                    }
                                                    pressed={!!c.off}
                                                    onClick={() =>
                                                        setCharacters((cs) =>
                                                            cs.map((x) =>
                                                                x.id === c.id ? { ...x, off: !x.off } : x,
                                                            ),
                                                        )
                                                    }
                                                >
                                                    {c.off ? (
                                                        <EyeOff strokeWidth={2} className="h-3.5 w-3.5" />
                                                    ) : (
                                                        <Eye strokeWidth={2} className="h-3.5 w-3.5" />
                                                    )}
                                                </IconButton>
                                                {/* Removable down to none: zero
                                                    characters is a valid image, not
                                                    a state to be trapped out of. */}
                                                <IconButton
                                                    label={`Remove character ${i + 1}`}
                                                    onClick={() =>
                                                        setCharacters((cs) =>
                                                            cs.filter((x) => x.id !== c.id),
                                                        )
                                                    }
                                                >
                                                    <X strokeWidth={2} className="h-3.5 w-3.5" />
                                                </IconButton>
                                            </div>
                                        </div>
                                        {/* Kept editable while skipped: this is a
                                            "not this time" switch, not a lock. The
                                            negative is per character, separate from
                                            the image-wide one on this same tab. */}
                                        <div className={c.off ? "opacity-45" : ""}>
                                            <TextArea
                                                framed
                                                rows={2}
                                                aria-label={
                                                    fieldOf(c.id) === "negative"
                                                        ? `Character ${i + 1} negative prompt`
                                                        : `Character ${i + 1} prompt`
                                                }
                                                value={c[fieldOf(c.id)] ?? ""}
                                                onChange={(t) =>
                                                    setCharacters((cs) =>
                                                        cs.map((x) =>
                                                            x.id === c.id
                                                                ? { ...x, [fieldOf(c.id)]: t }
                                                                : x,
                                                        ),
                                                    )
                                                }
                                                placeholder={
                                                    fieldOf(c.id) === "negative"
                                                        ? "glasses, hat"
                                                        : "1girl, long hair, blue eyes"
                                                }
                                            />
                                        </div>
                                    </div>
                                ))}

                                <button
                                    type="button"
                                    onClick={() =>
                                        setCharacters((cs) => [
                                            ...cs,
                                            {
                                                id: Math.max(0, ...cs.map((x) => x.id)) + 1,
                                                text: "",
                                                negative: "",
                                                ...freeCell(
                                                    cs.filter((x) => x.x !== undefined && !x.off),
                                                ),
                                            },
                                        ])
                                    }
                                    className="flex w-full items-center justify-center gap-1.5 py-2.5
                                               text-[13px] text-mut transition-colors active:bg-panel-2"
                                >
                                    <Plus strokeWidth={2} className="h-4 w-4" />
                                    Add character
                                </button>
                            </Rows>
                        </Group>

                        <Group label="Ending Prompt">
                            <TextArea
                                rows={3}
                                value={ending}
                                onChange={setEnding}
                                placeholder="depth of field, soft lighting"
                            />
                        </Group>

                        <Group label="Negative Prompt">
                            <TextArea
                                rows={3}
                                value={negative}
                                onChange={setNegative}
                                placeholder="lowres, bad anatomy, text, watermark"
                            />
                        </Group>
                    </>
                ) : null}

                {tab === "generator" ? (
                    <>
                        <Group label="Random Tags">
                            <Rows>
                                <SwitchRow
                                    active={randomize}
                                    note="Draw tags from a random post and add them to your prompt"
                                    onClick={() => setRandomize((v) => !v)}
                                >
                                    Generate random tags
                                </SwitchRow>
                            </Rows>
                        </Group>

                        {/* The draw's settings say nothing when there is no draw. */}
                        {randomize ? (
                        <>
                        <Group label="Include Tags">
                            <TextArea rows={2} value={include} onChange={setInclude} placeholder="rain, city lights" />
                        </Group>

                        <Group label="Exclude Tags">
                            <TextArea rows={2} value={exclude} onChange={setExclude} placeholder="text, watermark" />
                        </Group>

                        <Group label="Minimum Favorites">
                            <Rows>
                                <SliderRow
                                    label="Minimum favorites"
                                    value={minScore}
                                    onChange={setMinScore}
                                    min={0}
                                    max={1000}
                                />
                            </Rows>
                        </Group>

                        <p className="-mt-2 flex items-center gap-1.5 px-0.5 text-[11.5px] leading-snug text-dim">
                            {counting && (
                                <Loader2
                                    aria-hidden
                                    strokeWidth={2}
                                    className="h-3 w-3 shrink-0 animate-spin"
                                />
                            )}
                            {/* the previous count stays put while a new one runs,
                                so the row doesn't flicker between keystrokes */}
                            <span aria-live="polite" aria-busy={counting}>{matches}</span>
                        </p>

                        <Group label="Tag Types To Use" hint={`${allowed} of ${FILTERS.length}`} bare>
                            <div className="flex flex-wrap gap-1.5">
                                {FILTERS.map(([key, label]) => (
                                    <Pill
                                        key={key}
                                        active={!filters[key]}
                                        onClick={() => setFilters((f) => ({ ...f, [key]: !f[key] }))}
                                    >
                                        {label}
                                    </Pill>
                                ))}
                            </div>
                        </Group>

                        <p className="-mt-2 px-0.5 text-[11.5px] leading-snug text-dim">
                            Dimmed types are left out of generated prompts.
                        </p>
                        </>
                        ) : null}

                        <Group label="Processing">
                            <Rows>
                                {PROCESSING.map(([key, label, note]) => (
                                    <SwitchRow
                                        key={key}
                                        active={!!extras[key]}
                                        note={note}
                                        onClick={() => setExtras((x) => ({ ...x, [key]: !x[key] }))}
                                    >
                                        {label}
                                    </SwitchRow>
                                ))}
                            </Rows>
                        </Group>
                    </>
                ) : null}

                {tab === "options" ? (
                    <>
                        <Group label="Model">
                            <Rows>
                                <div className="flex h-11 items-center gap-3 px-3">
                                    <span className="shrink-0 text-[13.5px] text-mut">Model</span>
                                    <div className="ml-auto min-w-0">
                                        <Dropdown
                                            value={model}
                                            onChange={setModel}
                                            groups={MODEL_GROUPS}
                                            align="right"
                                        />
                                    </div>
                                </div>
                            </Rows>
                        </Group>

                        <Group label="Size">
                            <Rows>
                                <div className="flex h-11 items-center gap-3 px-3">
                                    <span className="shrink-0 text-[13.5px] text-mut">Preset</span>
                                    <div className="ml-auto min-w-0">
                                        <Dropdown value={size} onChange={pickSize} groups={SIZE_GROUPS} align="right" />
                                    </div>
                                </div>
                                {/* Typing a dimension flips the preset to Custom. */}
                                {/* One row each: two steppers side by side would
                                    not fit a narrow phone. */}
                                {[
                                    ["Width", width, setWidth],
                                    ["Height", height, setHeight],
                                ].map(([label, value, set]) => (
                                    <div key={label} className="flex h-11 items-center gap-3 px-3">
                                        <span className="shrink-0 text-[13.5px] text-mut">{label}</span>
                                        <div className="ml-auto">
                                            <NumberBox
                                                label={label}
                                                value={value}
                                                min={64}
                                                max={2048}
                                                step={64}
                                                width="6ch"
                                                onChange={(v) => {
                                                    set(v);
                                                    setSize("custom");
                                                }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </Rows>
                        </Group>

                        <Group label="Quality">
                            <Rows>
                                <SliderRow label="Steps" value={steps} onChange={setSteps} min={1} max={50} />
                                <SliderRow
                                    label="Prompt guidance"
                                    display={guidance.toFixed(1)}
                                    value={guidance}
                                    onChange={setGuidance}
                                    min={0}
                                    max={10}
                                    step={0.1}
                                />
                                <SliderRow
                                    label="Prompt guidance rescale"
                                    display={rescale.toFixed(2)}
                                    value={rescale}
                                    onChange={setRescale}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                />
                                <SwitchRow
                                    active={varietyPlus}
                                    note="Skip guidance on the first steps, for more varied composition"
                                    onClick={() => setVarietyPlus((v) => !v)}
                                >
                                    Variety+
                                </SwitchRow>
                            </Rows>
                        </Group>

                        <Group label="Sampling">
                            <Rows>
                                <div className="flex h-11 items-center gap-3 px-3">
                                    <span className="shrink-0 text-[13.5px] text-mut">Sampler</span>
                                    <div className="ml-auto min-w-0">
                                        <Dropdown
                                            value={sampler}
                                            onChange={setSampler}
                                            groups={SAMPLER_GROUPS}
                                            align="right"
                                        />
                                    </div>
                                </div>
                                <div className="flex h-11 items-center gap-3 px-3">
                                    <span className="shrink-0 text-[13.5px] text-mut">Noise schedule</span>
                                    <div className="ml-auto min-w-0">
                                        <Dropdown
                                            value={noiseSchedule}
                                            onChange={setNoiseSchedule}
                                            groups={NOISE_GROUPS}
                                            align="right"
                                        />
                                    </div>
                                </div>
                                <FieldRow
                                    label="Seed"
                                    value={seed}
                                    onChange={setSeed}
                                    placeholder="Random"
                                    inputMode="numeric"
                                    action={
                                        <button
                                            type="button"
                                            aria-label="Use a random seed"
                                            onClick={() => setSeed("")}
                                            className={`flex h-7 w-7 shrink-0 items-center justify-center
                                                        rounded-md transition-colors ${
                                                            seed ? "text-mut active:text-fg" : "text-faint"
                                                        }`}
                                        >
                                            <Dices strokeWidth={1.75} className="h-4 w-4" />
                                        </button>
                                    }
                                />
                            </Rows>
                        </Group>
                    </>
                ) : null}

                {tab === "automation" ? (
                    <>
                        <Group label="Repeat">
                            <Rows>
                                <SliderRow
                                    label="Delay"
                                    display={`${delay}s`}
                                    value={delay}
                                    onChange={setDelay}
                                    min={1}
                                    max={30}
                                />
                            </Rows>
                        </Group>
                        <p className="-mt-2 px-0.5 text-[11.5px] leading-snug text-dim">
                            How long to wait after an image finishes before starting the next one. Switch the dock
                            counter to ∞ to start repeating.
                        </p>

                        <Group label="Results">
                            <Rows>
                                <SwitchRow
                                    active={autoDownload}
                                    note="Save every image to your device as it arrives"
                                    onClick={() => setAutoDownload((v) => !v)}
                                >
                                    Download automatically
                                </SwitchRow>
                            </Rows>
                        </Group>
                    </>
                ) : null}
            </div>
        </>
    );
}
