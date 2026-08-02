import { useRef, useState } from "react";
import useMediaQuery from "../hooks/useMediaQuery.js";

/* A landscape phone is ~844px across and only ~390px tall, so a sheet holding
   90% of the height leaves nothing to look at. Past this width the panel goes
   to the left edge instead and uses the height it has. Desktop lands here too,
   which is the same fix for the same reason. */
const WIDE = "(min-width: 768px)";

/**
 * Settings panel: a sheet from the bottom on a portrait phone, a sidebar from
 * the left when there is width to spare. Same open/close semantics either way,
 * and it drags along whichever axis it travels on.
 */
export default function BottomSheet({ open, onOpenChange, children }) {
    const wide = useMediaQuery(WIDE);
    const [drag, setDrag] = useState(0);
    const start = useRef(null);

    function onPointerDown(e) {
        // The axis the panel moves along: down closes a sheet, left closes a
        // sidebar. Both are stored as "distance toward closed" so the maths
        // below stays the same for either.
        start.current = wide ? -e.clientX : e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e) {
        if (start.current === null) return;
        const d = (wide ? -e.clientX : e.clientY) - start.current;
        setDrag(open ? Math.max(0, d) : Math.min(0, d));
    }
    function onPointerUp() {
        if (start.current === null) return;
        if (Math.abs(drag) > 60) onOpenChange(!open);
        start.current = null;
        setDrag(0);
    }

    const rest = open ? "0px" : wide ? "-100%" : "100%";
    const glide = "380ms cubic-bezier(.22,1,.36,1)";

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
                className={`fixed z-30 touch-none ${
                    wide
                        ? "inset-y-0 left-0 w-[min(360px,80vw)]"
                        : "inset-x-0 bottom-0 h-[90svh]"
                }`}
                style={{
                    transform: wide
                        ? `translateX(calc(${rest} - ${drag}px))`
                        : `translateY(calc(${rest} + ${drag}px))`,
                    transition: start.current === null ? `transform ${glide}` : "none",
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
                    // Closed, the grip has to sit outside the hidden panel to be
                    // reachable: past its trailing edge, which is the screen edge.
                    style={
                        wide
                            ? { left: open ? "calc(100% - 2.5rem)" : "100%", transition: `left ${glide}` }
                            : { top: open ? 0 : -126, transition: `top ${glide}` }
                    }
                    className={`absolute z-10 flex items-center justify-center ${
                        wide
                            ? "top-1/2 h-20 w-10 -translate-y-1/2"
                            : "left-1/2 h-10 w-20 -translate-x-1/2"
                    }`}
                >
                    {/* Closed, the grip is a lozenge floating over the picture, so
                        it reads as something to pull. Open, it is the panel's own
                        grab bar and the glass behind it does the work. */}
                    <span
                        className={`rounded-full bg-white/45 transition-all ${
                            wide ? "h-9 w-1" : "h-1 w-9"
                        } ${open ? "" : "shadow-[0_2px_10px_rgb(0_0_0/0.55)]"}`}
                    />
                </button>

                {/* pt clears the grabber's tap target; any less and the tab row
                    underneath eats mis-aimed taps meant for a tab. The sidebar
                    has its grip on the side, so it only needs normal padding. */}
                <div
                    className={`flex h-full flex-col overflow-hidden bg-[#33333a]/72 backdrop-blur-2xl ${
                        wide
                            ? "rounded-r-[26px] border-r border-hair pt-4 shadow-[inset_-1px_0_0_0_rgb(255_255_255/0.16),24px_0_60px_-20px_rgb(0_0_0/0.6)]"
                            : "rounded-t-[26px] border-t border-hair pt-9 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.16),0_-24px_60px_-20px_rgb(0_0_0/0.6)]"
                    }`}
                >
                    {children}
                </div>
            </div>
        </>
    );
}
