import { useRef, useState } from "react";
import useMediaQuery from "../hooks/useMediaQuery.js";

/* A landscape phone is ~844px across and only ~390px tall, so a sheet holding
   90% of the height leaves nothing to look at. Past this width the settings
   move to a permanent left sidebar instead. Desktop lands here too, which is
   the same fix for the same reason. */
const WIDE = "(min-width: 768px)";

/**
 * Settings: a sheet that drags up from the bottom on a portrait phone, a fixed
 * sidebar when there is width for one. The sidebar never closes — there is room
 * for it and the picture at once, so hiding it would only add a click. The
 * open/close props are ignored in that mode.
 *
 * Its width is --sidebar, which the stage and dock also read so they clear it.
 */
export default function BottomSheet({ open, onOpenChange, children }) {
    const wide = useMediaQuery(WIDE);
    const [drag, setDrag] = useState(0);
    const start = useRef(null);

    function onPointerDown(e) {
        start.current = e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e) {
        if (start.current === null) return;
        const dy = e.clientY - start.current;
        setDrag(open ? Math.max(0, dy) : Math.min(0, dy));
    }
    function onPointerUp() {
        if (start.current === null) return;
        if (Math.abs(drag) > 60) onOpenChange(!open);
        start.current = null;
        setDrag(0);
    }

    if (wide) {
        return (
            <aside
                aria-label="Settings"
                className="fixed inset-y-0 left-0 z-30 flex w-[var(--sidebar)] flex-col
                           border-r border-hair bg-[#33333a]/72 pt-4 backdrop-blur-2xl
                           shadow-[inset_-1px_0_0_0_rgb(255_255_255/0.16)]"
            >
                {children}
            </aside>
        );
    }

    return (
        <>
            {/* Tap-out scrim. Sits under the sheet (z-30) and under the dock (z-40),
                so only the exposed preview above the sheet dismisses it. */}
            {open ? (
                <div
                    onPointerDown={() => onOpenChange(false)}
                    aria-hidden="true"
                    className="fixed inset-0 z-20"
                />
            ) : null}

            <div
                className="fixed inset-x-0 bottom-0 z-30 h-[90svh] touch-none"
                style={{
                    transform: `translateY(calc(${open ? "0px" : "100%"} + ${drag}px))`,
                    transition:
                        start.current === null
                            ? "transform 380ms cubic-bezier(.22,1,.36,1)"
                            : "none",
                }}
            >
                <button
                    type="button"
                    aria-expanded={open}
                    aria-label={open ? "Hide settings" : "Show settings"}
                    onClick={() => onOpenChange(!open)}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    style={{
                        top: open ? 0 : -126,
                        transition: "top 380ms cubic-bezier(.22,1,.36,1)",
                    }}
                    className="absolute left-1/2 z-10 flex h-10 w-20 -translate-x-1/2 items-center
                               justify-center"
                >
                    {/* Closed, the grip is a lozenge floating over the picture, so
                        it reads as something to pull. Open, it is the sheet's own
                        grab bar and the glass behind it does the work. */}
                    <span
                        className={`h-1 w-9 rounded-full bg-white/45 transition-all ${
                            open ? "" : "shadow-[0_2px_10px_rgb(0_0_0/0.55)]"
                        }`}
                    />
                </button>

                {/* pt clears the grabber's 40px tap target; any less and the tab
                    row underneath eats mis-aimed taps meant for a tab. */}
                <div
                    className="flex h-full flex-col overflow-hidden rounded-t-[26px] border-t border-hair bg-[#33333a]/72 pt-9 backdrop-blur-2xl
                               shadow-[inset_0_1px_0_0_rgb(255_255_255/0.16),0_-24px_60px_-20px_rgb(0_0_0/0.6)]"
                >
                    {children}
                </div>
            </div>
        </>
    );
}
