/* Turning the settings into the body NovelAI's v4 endpoint expects.

   The shape is copied from what their own client sends. Two things about it are
   worth knowing before editing:

   - The cast is sent twice. `characterPrompts` is the older field and
     `v4_prompt.caption.char_captions` the one the v4 models actually read, and
     they have to agree — including their order, which is what `use_order` makes
     meaningful.
   - Positives and negatives are separate trees: a character's negative lives at
     the same index in `v4_negative_prompt`, so a character with no negative
     still needs its empty slot or the lists fall out of step. */

const BASE = 832 * 1216;

/* Variety+ stops guidance from applying while sigma is above this, which is what
   loosens the composition. The constant is what NovelAI's client uses at their
   reference resolution, scaled by the square root of the area so a larger canvas
   gets the equivalent cut.
   ponytail: empirical, taken from observed requests — if Variety+ ever stops
   matching the website, this number is the thing to re-check. */
export function skipCfgSigma(width, height) {
    return 19.343056794463642 * Math.sqrt((width * height) / BASE);
}

/** A seed NovelAI accepts: unsigned 32-bit. Blank means "surprise me". */
function seedOf(seed) {
    const n = Number(seed);
    return seed !== "" && Number.isFinite(n)
        ? Math.abs(Math.trunc(n)) % 4294967295
        : Math.floor(Math.random() * 4294967295);
}

/**
 * `prompt` is the finished base caption; the per-character text comes from
 * settings. Returns { body, seed } — the seed is resolved here rather than left
 * to NovelAI so the value can be shown and reused.
 */
export function buildRequest({ prompt, settings, stream = true }) {
    const {
        model, negative, characters, useCoords,
        width, height, steps, guidance, rescale, sampler, noiseSchedule, seed,
        varietyPlus,
    } = settings;

    // Skipped characters are dropped entirely rather than sent with
    // enabled:false, so their slots cannot shift the ones that remain.
    const cast = characters.filter((c) => !c.off && c.text.trim());
    const centers = cast.map((c) => ({ x: c.x ?? 0.5, y: c.y ?? 0.5 }));

    const resolved = seedOf(seed);

    return {
        seed: resolved,
        body: {
            input: prompt,
            model,
            action: "generate",
            parameters: {
                params_version: 3,
                width,
                height,
                scale: guidance,
                sampler,
                steps,
                seed: resolved,
                n_samples: 1,
                // 3 = "none": the negative prompt is ours, not one of their presets.
                ucPreset: 3,
                qualityToggle: false,
                autoSmea: false,
                dynamic_thresholding: false,
                controlnet_strength: 1,
                legacy: false,
                add_original_image: true,
                cfg_rescale: rescale,
                noise_schedule: noiseSchedule,
                legacy_v3_extend: false,
                skip_cfg_above_sigma: varietyPlus ? skipCfgSigma(width, height) : null,
                use_coords: useCoords,
                legacy_uc: false,
                normalize_reference_strength_multiple: true,
                inpaintImg2ImgStrength: 1,
                characterPrompts: cast.map((c, i) => ({
                    prompt: c.text,
                    uc: c.negative ?? "",
                    center: centers[i],
                    enabled: true,
                })),
                v4_prompt: {
                    caption: {
                        base_caption: prompt,
                        char_captions: cast.map((c, i) => ({
                            char_caption: c.text,
                            centers: [centers[i]],
                        })),
                    },
                    use_coords: useCoords,
                    use_order: true,
                },
                v4_negative_prompt: {
                    caption: {
                        base_caption: negative,
                        char_captions: cast.map((c, i) => ({
                            char_caption: c.negative ?? "",
                            centers: [centers[i]],
                        })),
                    },
                    legacy_uc: false,
                },
                negative_prompt: negative,
                deliberate_euler_ancestral_bug: false,
                prefer_brownian: true,
                image_format: "png",
                ...(stream ? { stream: "msgpack" } : {}),
            },
        },
    };
}
