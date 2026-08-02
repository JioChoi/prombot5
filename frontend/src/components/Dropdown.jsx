import { ChevronsUpDown } from "lucide-react";
import useAnchoredPopover from "./Popover.jsx";

/**
 * Grouped select. `groups` is [{ header, options: [{ value, label, note }] }].
 * Native <select> can group but cannot be styled on mobile, so this is hand-built.
 */
export default function Dropdown({ value, onChange, groups, align = "left" }) {
    const { open, close, toggle, triggerRef, panel } = useAnchoredPopover({ align });

    const current = groups.flatMap((g) => g.options).find((o) => o.value === value);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={toggle}
                className={`flex w-full items-center justify-end gap-1 rounded-md px-1.5 py-1
                            text-[13.5px] transition-colors ${
                                open ? "bg-panel-2 text-fg" : "text-fg"
                            }`}
            >
                <span className="truncate">{current?.label ?? "Select"}</span>
                <ChevronsUpDown strokeWidth={2} className="h-3.5 w-3.5 shrink-0 text-dim" />
            </button>

            {panel(
                groups.map((g, gi) => (
                    <div
                        key={g.header}
                        className={gi > 0 ? "mt-1 border-t border-hair pt-1" : ""}
                    >
                        {/* Optional: an ungrouped list would otherwise get an empty
                            strip where the caption belongs. */}
                        {g.header ? (
                            <div
                                className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase
                                           tracking-[0.08em] text-faint"
                            >
                                {g.header}
                            </div>
                        ) : null}
                        {g.options.map((o) => {
                            const active = o.value === value;
                            return (
                                <button
                                    key={o.value}
                                    type="button"
                                    role="option"
                                    aria-selected={active}
                                    onClick={() => {
                                        onChange(o.value);
                                        close();
                                    }}
                                    className={`flex w-full items-center justify-between gap-5
                                                rounded-md px-2 py-1.5 text-left text-[13.5px]
                                                transition-colors ${
                                                    active
                                                        ? "bg-accent-lit/15 text-accent-lit"
                                                        : "text-mut active:bg-panel-3"
                                                }`}
                                >
                                    <span className="whitespace-nowrap">{o.label}</span>
                                    {o.note ? (
                                        <span className="num text-[11px] text-faint">{o.note}</span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                )),
                { className: "min-w-[168px]", role: "listbox" },
            )}
        </>
    );
}
