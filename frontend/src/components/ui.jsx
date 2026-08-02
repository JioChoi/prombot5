import { Minus, Plus } from "lucide-react";
import { useState } from "react";
import { useTagAutocomplete } from "./TagAutocomplete.jsx";

/** Small caption over a panel. `hint` carries the group's current value. */
export function Group({ label, hint, action, children, bare = false, className = "" }) {
    return (
        <section className={className}>
            {label ? (
                <div className="mb-1.5 flex items-center justify-between gap-3 px-0.5">
                    <h3 className="label">{label}</h3>
                    {/* Hint and action share the right end, so an action never
                        lands on top of the count. The negative margin keeps a
                        20px button from making this header taller than the
                        text-only ones — headings must line up group to group. */}
                    <div className="-my-1 flex items-center gap-1.5">
                        {hint ? <span className="num text-[11.5px] text-dim">{hint}</span> : null}
                        {action}
                    </div>
                </div>
            ) : null}
            {/* Not clipped: the tag list hangs out past the panel's edge. Rows
                does its own clipping, which is the only place that needed it. */}
            <div className={bare ? "" : "panel"}>{children}</div>
        </section>
    );
}

/** Rows inside a panel, divided by hairlines. */
export function Rows({ children }) {
    // Clips pressed-row backgrounds to the panel's corners. 17px is the panel's
    // 18px radius less its 1px border.
    return <div className="overflow-hidden rounded-[17px] [&>*]:hair-top">{children}</div>;
}

export function TextArea({
    rows = 3,
    value,
    onChange,
    placeholder,
    autocomplete = true,
    // A textarea that fills its own panel needs no edges — the panel is the edge.
    // Inside a shared panel it does, or it reads as loose text between rows.
    framed = false,
    ...rest
}) {
    const { bind, popup } = useTagAutocomplete({
        value,
        onChange,
        enabled: autocomplete,
    });
    const { onChange: acChange, ...acProps } = bind;

    return (
        <div
            className={`relative block ${
                framed
                    ? "rounded-[12px] bg-well/70 ring-1 ring-hair focus-within:ring-accent-lit/60"
                    : ""
            }`}
        >
            <textarea
                rows={rows}
                value={value}
                onChange={(e) => acChange(e.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                className="scroll-thin block w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px]
                           leading-[1.5] text-fg placeholder:text-faint focus:outline-none"
                {...acProps}
                {...rest}
            />
            {popup}
        </div>
    );
}

/** Row: name on the left, editable value right-aligned. */
export function FieldRow({ label, value, onChange, placeholder, action, ...rest }) {
    return (
        <label className="flex h-11 items-center gap-2 px-3">
            <span className="shrink-0 text-[13.5px] text-mut">{label}</span>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                className="num min-w-0 flex-1 bg-transparent text-right text-[13.5px] text-fg
                           placeholder:text-faint focus:outline-none"
                {...rest}
            />
            {action}
        </label>
    );
}

/* Typed values land wherever the person aimed; the control only moves in steps,
   so snap to that grid and pull anything out of range back to the nearest end.
   toFixed sheds the float noise a 0.1 step leaves behind (4.300000000000001). */
function settle(v, min, max, step) {
    const snapped = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
}

const ARROW = `flex h-7 w-7 shrink-0 items-center justify-center text-mut
               transition-colors active:bg-panel-3 active:text-fg`;

/**
 * Editable number with −/+ either side. `display` decorates the resting value
 * (units, fixed decimals); typing swaps it for the raw number.
 */
export function NumberBox({ value, onChange, min, max, step = 1, label, display, width = "5.5ch" }) {
    // Draft holds the raw text while focused; snapping mid-keystroke would eat
    // the "1" of 1024 before the rest arrives.
    const [draft, setDraft] = useState(null);

    function commit() {
        const n = Number(draft);
        if (draft.trim() && Number.isFinite(n)) onChange(settle(n, min, max, step));
        setDraft(null);
    }

    // One ringed pill with hairline dividers: three separate floating parts read
    // as clutter next to a row of plain labels.
    return (
        <div
            className="flex shrink-0 items-center divide-x divide-hair overflow-hidden rounded-[12px]
                       bg-panel-2 ring-1 ring-hair focus-within:ring-accent-lit"
        >
            <button
                type="button"
                aria-label={`Decrease ${label}`}
                onClick={() => onChange(settle(value - step, min, max, step))}
                className={ARROW}
            >
                <Minus strokeWidth={2} className="h-3.5 w-3.5" />
            </button>
            <input
                type="text"
                inputMode="decimal"
                aria-label={label}
                value={draft ?? display ?? value}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => setDraft(String(value))}
                onBlur={commit}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                style={{ width }}
                className="num shrink-0 self-stretch bg-transparent text-center text-[13px]
                           text-fg focus:outline-none"
            />
            <button
                type="button"
                aria-label={`Increase ${label}`}
                onClick={() => onChange(settle(value + step, min, max, step))}
                className={ARROW}
            >
                <Plus strokeWidth={2} className="h-3.5 w-3.5" />
            </button>
        </div>
    );
}

/** Slider row: value sits beside the name, control fills the row below it. */
export function SliderRow({ label, display, value, onChange, min, max, step = 1 }) {
    const fill = ((value - min) / (max - min)) * 100;
    return (
        <div className="px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[13.5px] text-mut">{label}</span>
                <NumberBox
                    label={label}
                    display={display}
                    value={value}
                    onChange={onChange}
                    min={min}
                    max={max}
                    step={step}
                    width="6ch"
                />
            </div>
            <input
                type="range"
                aria-label={label}
                className="slider mt-1"
                style={{ "--fill": `${fill}%` }}
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
            />
        </div>
    );
}

/** Bare icon button for row actions. `pressed` marks a toggle that is on. */
export function IconButton({ label, onClick, disabled, pressed, children }) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                        transition-colors disabled:opacity-25 ${
                            pressed ? "text-accent-lit" : "text-dim active:text-fg"
                        }`}
        >
            {children}
        </button>
    );
}

/** Wrapping toggle pill. */
export function Pill({ active, onClick, children }) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={`rounded-full border px-3 py-1.5 text-[12.5px] transition-colors ${
                active
                    ? "border-accent-lit/45 bg-accent-lit/15 text-fg"
                    : "border-dashed border-hair-2 text-faint"
            }`}
        >
            {children}
        </button>
    );
}

/** Row with a switch on the right. */
export function SwitchRow({ active, onClick, children, note }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={active}
            onClick={onClick}
            className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left
                       transition-colors active:bg-panel-2"
        >
            <span className="min-w-0">
                <span className="block text-[13.5px] text-fg">{children}</span>
                {note ? (
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">
                        {note}
                    </span>
                ) : null}
            </span>
            <span
                className={`relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors ${
                    active ? "bg-accent" : "bg-panel-3"
                }`}
            >
                <span
                    className={`absolute top-[2px] h-4 w-4 rounded-full bg-white transition-transform ${
                        active ? "translate-x-[16px]" : "translate-x-[2px]"
                    }`}
                />
            </span>
        </button>
    );
}
