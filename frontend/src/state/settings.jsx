import { createContext, useContext } from "react";
import usePersistentState from "../hooks/usePersistentState.js";

/**
 * Every console field lives here so the dock can read out what the sheet is
 * holding. Keys match the original localStorage keys, so saved settings survive.
 */
const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
    const value = {
        beginning: usePersistentState("beginning", ""),
        ending: usePersistentState("ending", ""),
        negative: usePersistentState("negative", ""),
        characters: usePersistentState("characters", [
            { id: 1, text: "", negative: "", x: 0.5, y: 0.5 },
        ]),
        // false = let the model decide where everyone stands (NovelAI's use_coords off).
        useCoords: usePersistentState("useCoords", false),
        include: usePersistentState("include", ""),
        exclude: usePersistentState("exclude", ""),
        minScore: usePersistentState("minScore", 0),
        filters: usePersistentState("filters", {}),
        extras: usePersistentState("extras", { reorder: true, reformat: true }),

        model: usePersistentState("model", "nai-diffusion-4-5-full"),
        size: usePersistentState("size", "832x1216"),
        width: usePersistentState("width", 832),
        height: usePersistentState("height", 1216),
        steps: usePersistentState("steps", 28),
        guidance: usePersistentState("guidance", 5.5),
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

/** `const [steps, setSteps] = useSetting("steps")` */
export function useSetting(key) {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error("useSetting must be used inside SettingsProvider");
    return ctx[key];
}
