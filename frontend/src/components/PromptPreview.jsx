import { useEffect, useRef, useState } from "react";

/* Where a tag came from, as the sheet says it. `typed` is the only origin the
   user wrote themselves, so it is the only one shown unhighlighted. */
const WHY = {
    drawn: () => "Drawn from the random post",
    series: (who) => `Source series of ${who}`,
    feature: (who) => `Character features of ${who}`,
    attire: (who) => `Character attire of ${who}`,
};

const TINT = {
    drawn: "bg-sky-400/18 text-sky-100",
    series: "bg-amber-400/18 text-amber-100",
    feature: "bg-violet-400/18 text-violet-100",
    attire: "bg-emerald-400/18 text-emerald-100",
};

/** One tag: plain text when typed, a tappable chip when something added it. */
function Part({ part, picked, onPick }) {
    const why = WHY[part.origin];
    const text = (part.weight > 0 ? "{".repeat(part.weight) : "[".repeat(-part.weight)) +
        part.tag +
        (part.weight > 0 ? "}".repeat(part.weight) : "]".repeat(-part.weight));
    if (!why) return <span className="text-fg">{text}</span>;
    return (
        <button
            type="button"
            aria-pressed={picked}
            onClick={() => onPick(picked ? null : part.id)}
            className={`rounded-[7px] px-1 ${TINT[part.origin] ?? "bg-white/10"} ${
                picked ? "ring-1 ring-white/60" : ""
            }`}
        >
            {text}
        </button>
    );
}

function Block({ label, parts, picked, onPick }) {
    if (!parts.length) return null;
    return (
        <section className="mt-3">
            <h3 className="px-0.5 text-[11.5px] uppercase tracking-wide text-dim">{label}</h3>
            <p className="mt-1 rounded-[17px] bg-panel-2 p-3 text-[13px] leading-relaxed">
                {parts.map((p, i) => (
                    <span key={p.id}>
                        <Part part={p} picked={picked === p.id} onPick={onPick} />
                        {i < parts.length - 1 ? <span className="text-mut">, </span> : null}
                    </span>
                ))}
            </p>
        </section>
    );
}

/**
 * What the generator would send, before sending it: the base prompt and every
 * character caption, with each tag the app added marked by what added it.
 * Tapping one says so in words.
 *
 * `trace` is { parts, cast } from tracePrompt/traceCharacters, or null while a
 * draw is still running.
 */
export default function PromptPreview({ open, trace, error, onClose }) {
    const ref = useRef(null);
    const [picked, setPicked] = useState(null);

    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
    }, [open]);

    useEffect(() => setPicked(null), [trace]);

    // ids are positional, so a redraw drops the selection with the useEffect above
    const blocks = (trace
        ? [
              { label: "Prompt", parts: trace.parts },
              ...trace.cast.map((c, i) => ({ label: `Character ${i + 1}`, parts: c.parts })),
          ]
        : []
    ).map((b, bi) => ({ ...b, parts: b.parts.map((p, i) => ({ ...p, id: `${bi}:${i}` })) }));
    const chosen = blocks.flatMap((b) => b.parts).find((p) => p.id === picked);

    return (
        <dialog
            ref={ref}
            onClose={onClose}
            onClick={(e) => e.target === ref.current && onClose()}
            className="m-auto max-h-[80svh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto
                       rounded-[22px] border border-hair bg-[#33333a]/90 p-0 text-fg
                       backdrop-blur-2xl backdrop:bg-black/60"
        >
            <div className="p-4">
                <h2 className="text-[15px] font-semibold">Generated prompt</h2>
                <p className="mt-1 text-[12px] leading-snug text-dim">
                    A sample draw with the current settings. Highlighted tags were added by
                    the app — tap one to see what put it there.
                </p>

                {error ? (
                    <p role="alert" className="mt-3 text-[12.5px] text-red-400">{error}</p>
                ) : !trace ? (
                    <p className="mt-3 text-[12.5px] text-dim">Drawing…</p>
                ) : (
                    <>
                        {blocks.map((b) => (
                            <Block
                                key={b.label}
                                label={b.label}
                                parts={b.parts}
                                picked={picked}
                                onPick={setPicked}
                            />
                        ))}
                        <p
                            aria-live="polite"
                            className="mt-3 min-h-[1.25rem] px-0.5 text-[12.5px] text-mut"
                        >
                            {chosen
                                ? WHY[chosen.origin]?.(chosen.from)
                                : "Nothing selected."}
                        </p>
                    </>
                )}

                <button
                    type="button"
                    onClick={onClose}
                    className="mt-4 h-11 w-full rounded-[15px] border border-hair bg-panel-2
                               text-[14px] text-mut transition-colors active:text-fg"
                >
                    Close
                </button>
            </div>
        </dialog>
    );
}
