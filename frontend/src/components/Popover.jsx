import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Anchored floating panel, portalled and fixed-positioned: these open inside a
 * scrolling sheet and inside clipped panels, either of which would cut off an
 * absolutely-positioned child.
 *
 * Returns the trigger ref, the open state, and `panel(children)` — render that
 * last, next to the trigger.
 */
export default function useAnchoredPopover({ align = "left", maxHeight = 320 } = {}) {
    const [box, setBox] = useState(null);
    const triggerRef = useRef(null);
    const panelRef = useRef(null);
    const open = box !== null;

    function place() {
        const r = triggerRef.current?.getBoundingClientRect();
        if (!r) return;
        // The dock floats over the bottom ~80px, so that space is not usable.
        const floor = window.innerHeight - 84;
        // Flip above the trigger when the room below is too tight to be useful.
        const below = floor - r.bottom - 8;
        const above = r.top - 8;
        const flip = below < 180 && above > below;
        setBox({
            left: r.left,
            right: window.innerWidth - r.right,
            top: flip ? null : r.bottom + 6,
            bottom: flip ? window.innerHeight - r.top + 6 : null,
            maxHeight: Math.min(maxHeight, flip ? above : below),
        });
    }

    const close = () => setBox(null);
    const toggle = () => (open ? close() : place());

    useEffect(() => {
        if (!open) return;
        function onDown(e) {
            if (
                !triggerRef.current?.contains(e.target) &&
                !panelRef.current?.contains(e.target)
            ) {
                close();
            }
        }
        function onKey(e) {
            if (e.key === "Escape") close();
        }
        // Any scroll *under* the panel invalidates its position; just dismiss.
        // Scrolling the panel's own content must not close it.
        const onScroll = (e) => {
            if (!panelRef.current?.contains(e.target)) close();
        };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        window.addEventListener("resize", close);
        window.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
            window.removeEventListener("resize", close);
            window.removeEventListener("scroll", onScroll, true);
        };
    }, [open]);

    function panel(children, { className = "", role = "dialog" } = {}) {
        if (!open) return null;
        return createPortal(
            <div
                ref={panelRef}
                role={role}
                className={`scroll-thin fixed z-[100] overflow-y-auto overscroll-contain rounded-[16px]
                            border border-hair bg-[#3a3a42]/92 p-1.5 backdrop-blur-xl
                            shadow-[0_18px_44px_-12px_rgb(0_0_0/0.5)] ${className}`}
                style={{
                    top: box.top ?? undefined,
                    bottom: box.bottom ?? undefined,
                    left: align === "right" ? undefined : box.left,
                    right: align === "right" ? box.right : undefined,
                    maxHeight: box.maxHeight,
                }}
            >
                {children}
            </div>,
            document.body,
        );
    }

    return { open, close, toggle, triggerRef, panel };
}
