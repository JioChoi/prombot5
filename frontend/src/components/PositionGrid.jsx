import { CELLS, cellKey, cellLabel } from "../lib/position.js";
import useAnchoredPopover from "./Popover.jsx";

/**
 * Position chip that opens a 5x5 picker in a popup. Inline, the grid pushed the
 * rest of the cast down the sheet every time it opened; floating keeps the list
 * still while you aim.
 *
 * `taken` is every *other* character as { x, y, n }. Their cells show their
 * number and are not selectable, which is what keeps two characters from being
 * pinned to the same spot.
 */
export default function PositionGrid({ value, taken, onChange, label, n }) {
    const { open, close, toggle, triggerRef, panel } = useAnchoredPopover({
        align: "right",
        maxHeight: 240,
    });
    const others = new Map(taken.map((t) => [cellKey(t), t.n]));

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`Position of ${label}`}
                onClick={toggle}
                className={`num rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    open
                        ? "border-accent-lit/45 bg-accent-lit/15 text-fg"
                        : "border-hair-2 text-mut"
                }`}
            >
                {cellLabel(value)}
            </button>

            {panel(
                <div className="p-1">
                    <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
                        Position
                    </div>
                    <div className="grid w-[148px] grid-cols-5 gap-1">
                        {CELLS.map((y) =>
                            CELLS.map((x) => {
                                const here = { x, y };
                                const mine = cellKey(value) === cellKey(here);
                                const theirs = others.get(cellKey(here));
                                return (
                                    <button
                                        key={cellKey(here)}
                                        type="button"
                                        aria-label={
                                            theirs
                                                ? `${cellLabel(here)}, taken by character ${theirs}`
                                                : `Position ${cellLabel(here)}`
                                        }
                                        aria-pressed={mine}
                                        disabled={!!theirs}
                                        onClick={() => {
                                            onChange(here);
                                            close();
                                        }}
                                        className={`num flex aspect-square items-center justify-center
                                                    rounded-[6px] border text-[10px] transition-colors ${
                                                        mine
                                                            ? "border-accent-lit/50 bg-accent-lit/20 text-fg"
                                                            : theirs
                                                              ? "border-hair bg-panel-3 text-dim"
                                                              : "border-hair-2 text-faint active:bg-panel-3"
                                                    }`}
                                    >
                                        {/* Every occupied cell reads as its character's
                                            number, this one included — otherwise the
                                            selected cell is the only one you cannot
                                            name. Free cells stay blank. */}
                                        {mine ? n : (theirs ?? "")}
                                    </button>
                                );
                            }),
                        )}
                    </div>
                </div>,
                { className: "overflow-visible" },
            )}
        </>
    );
}
