import { createContext, useContext } from "react";
import usePersistentState from "../hooks/usePersistentState.js";

/**
 * Every console field lives here so the dock can read out what the sheet is
 * holding. Keys match the original localStorage keys, so saved settings survive.
 */
const SettingsContext = createContext(null);

/* Tag types the generator may use. These are stored inverted — true means the
   type is switched *off* — so this lists the ones left out: everything except
   attire and expressions. */
const FILTERS_OFF = {
    character: true,
    artist: true,
    copyright: true,
    characteristic: true,
    nsfw: true,
};

const EXTRAS = {
    reorder: true,
    reformat: true,
    dropRating: true,
    autoCopyright: true,
    strengthenCharacteristic: true,
    strengthenAttire: false,
};

const BEGINNING = "1girl, kirisame marisa, [[artist:maccha (mochancc)]]";

const ENDING =
    "no text, best quality, very aesthetic, absurdres, skindentation, " +
    "depth of field, volumetric lighting";

const NEGATIVE =
    "blurry, lowres, error, film grain, scan artifacts, worst quality, " +
    "bad quality, jpeg artifacts, very displeasing, chromatic aberration, " +
    "multiple views, logo, too many watermarks, blank page, white blank page";

export function SettingsProvider({ children }) {
    const value = {
        beginning: usePersistentState("beginning", BEGINNING),
        ending: usePersistentState("ending", ENDING),
        negative: usePersistentState("negative", NEGATIVE),
        // None to start: a character is something you add, and an image without
        // one is the normal case.
        characters: usePersistentState("characters", []),
        // false = let the model decide where everyone stands (NovelAI's use_coords off).
        useCoords: usePersistentState("useCoords", false),
        // Off means the prompt is only what you typed — nothing is drawn.
        randomize: usePersistentState("randomize", true),
        include: usePersistentState("include", "1girl, outdoors"),
        exclude: usePersistentState("exclude", "speech bubble"),
        minScore: usePersistentState("minScore", 0),
        filters: usePersistentState("filters", FILTERS_OFF),
        extras: usePersistentState("extras", EXTRAS),

        model: usePersistentState("model", "nai-diffusion-5-full"),
        size: usePersistentState("size", "832x1216"),
        width: usePersistentState("width", 832),
        height: usePersistentState("height", 1216),
        steps: usePersistentState("steps", 28),
        guidance: usePersistentState("guidance", 5),
        seed: usePersistentState("seed", ""),
        sampler: usePersistentState("sampler", "k_euler_ancestral"),
        // NovelAI payload names: variety+ is skip_cfg_above_sigma, rescale is
        // cfg_rescale. Stored under their UI names; the mapping happens at send time.
        varietyPlus: usePersistentState("varietyPlus", false),
        rescale: usePersistentState("rescale", 0),
        noiseSchedule: usePersistentState("noiseSchedule", "karras"),

        delay: usePersistentState("delay", 3),
        autoDownload: usePersistentState("autoDownload", false),
    };

    return (
        <SettingsContext value={value}>{children}</SettingsContext>
    );
}

/**
 * The whole console as one plain object, and the way back. This is what a preset
 * is: everything the sheet holds, nothing else.
 */
export function useSettingsIO() {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error("useSettingsIO must be used inside SettingsProvider");
    return {
        snapshot: () =>
            Object.fromEntries(Object.entries(ctx).map(([key, [value]]) => [key, value])),
        // Keys this build doesn't know are skipped rather than thrown on, so a
        // preset saved by a newer or older version still loads what it can.
        apply: (saved) => {
            for (const [key, value] of Object.entries(saved ?? {})) ctx[key]?.[1](value);
        },
    };
}

/** `const [steps, setSteps] = useSetting("steps")` */
export function useSetting(key) {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error("useSetting must be used inside SettingsProvider");
    return ctx[key];
}
