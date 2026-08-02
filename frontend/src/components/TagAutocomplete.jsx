import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
    CATEGORIES,
    activeToken,
    completionPrefix,
    loadTagIndex,
    searchTags,
} from "../lib/tagIndex.js";

const LIMIT = 5;
/** Must match the row height in Popup, or the list mis-sizes itself. */
const ROW = 34;

function short(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return `${n}`;
}

const CLOSED = { open: false, items: [], sel: 0, flip: false, maxHeight: 0 };

/**
 * Tag autocomplete for a textarea. Returns props to spread on the element and
 * the popup to render. The list is driven straight off the DOM (caret + value)
 * rather than off render state, so it stays in sync with fast typing.
 */
export function useTagAutocomplete({ value, onChange, enabled = true }) {
    const ref = useRef(null);
    const caretTo = useRef(null);
    const [ac, setAc] = useState(CLOSED);

    const close = useCallback(() => setAc(CLOSED), []);

    const refresh = useCallback(() => {
        const el = ref.current;
        if (!el || !enabled) return;
        const caret = el.selectionStart;
        if (caret !== el.selectionEnd) return close();

        const token = activeToken(el.value, caret);
        if (token.text.length < 1) return close();

        const items = searchTags(token.text, LIMIT);
        if (!items.length) return close();

        // The list is a sibling of the field, pinned to its bottom-left edge in
        // CSS. It used to be portalled to <body> and placed at fixed viewport
        // coordinates, which cannot be made correct: getBoundingClientRect
        // reports layout-viewport coordinates, but once the on-screen keyboard
        // pans the page, iOS re-anchors position:fixed to the *visual* viewport.
        // The two disagree by however far the keyboard pushed the page, so the
        // list drifted off its field. Laying it out relative to the field
        // instead means neither viewport is ever named.
        //
        // Room is still measured, but only to choose a side and a scroll height
        // — comparisons and sizes, never a coordinate to paint at.
        const box = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const top = vv ? vv.offsetTop + 8 : 8;
        const bottom =
            (vv ? vv.offsetTop + vv.height : document.documentElement.clientHeight) - 8;
        const roomBelow = bottom - (box.bottom + 4);
        const roomAbove = box.top - 4 - top;
        const flip = roomBelow < ROW * 2 && roomAbove > roomBelow;
        const height = Math.min(
            items.length * ROW,
            Math.max(ROW, flip ? roomAbove : roomBelow),
        );

        setAc((s) => ({
            open: true,
            items,
            // A reposition (keyboard opening, viewport pan) must not reset which
            // row is highlighted; a new search must.
            sel:
                s.open && s.items[0]?.id === items[0]?.id
                    ? Math.min(s.sel, items.length - 1)
                    : 0,
            flip,
            maxHeight: height,
        }));
    }, [close, enabled]);

    // Index is ~1.7MB gzipped; fetch it the moment a field is touched, then
    // re-run the search that was typed while it was still loading.
    const warm = useCallback(() => {
        loadTagIndex().then(refresh, () => {});
    }, [refresh]);

    const accept = useCallback(
        (item) => {
            const el = ref.current;
            if (!el) return;
            const token = activeToken(el.value, el.selectionStart);
            const insert = `${completionPrefix(token.text, item.label)}${item.label}, `;
            const next =
                el.value.slice(0, token.start) + insert + el.value.slice(token.end);
            caretTo.current = token.start + insert.length;
            onChange(next);
            close();
        },
        [close, onChange],
    );

    // Restore the caret after React writes the new value back into the DOM.
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && caretTo.current !== null) {
            el.setSelectionRange(caretTo.current, caretTo.current);
            caretTo.current = null;
        }
    }, [value]);

    useEffect(() => {
        if (!ac.open) return;
        // Scrolling the sheet moves the field out from under the popup: drop it.
        // Viewport changes (keyboard opening/closing, pan, rotate) only move the
        // caret, so re-place the popup instead of closing it.
        const onScroll = (e) => (e.target === window.visualViewport ? refresh() : close());
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", refresh);
        window.visualViewport?.addEventListener("resize", refresh);
        window.visualViewport?.addEventListener("scroll", refresh);
        return () => {
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", refresh);
            window.visualViewport?.removeEventListener("resize", refresh);
            window.visualViewport?.removeEventListener("scroll", refresh);
        };
    }, [ac.open, close, refresh]);

    const onKeyDown = (e) => {
        if (!ac.open) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const d = e.key === "ArrowDown" ? 1 : -1;
            setAc((s) => ({ ...s, sel: (s.sel + d + s.items.length) % s.items.length }));
        } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            accept(ac.items[ac.sel] ?? ac.items[0]);
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    };

    const bind = {
        ref,
        onChange: (v) => {
            onChange(v);
            // value lands in the DOM synchronously with React 19's flush, but
            // the caret is only correct after the change is applied
            queueMicrotask(refresh);
        },
        onKeyDown,
        onFocus: warm,
        onClick: refresh,
        onSelect: refresh,
        onBlur: close,
        autoComplete: "off",
        autoCorrect: "off",
        autoCapitalize: "off",
    };

    return { bind, popup: <Popup ac={ac} onPick={accept} onHover={setAc} /> };
}

function Popup({ ac, onPick, onHover }) {
    if (!ac.open) return null;
    return (
        <ul
            className={`scroll-thin absolute left-0 z-50 w-full overflow-y-auto overscroll-contain
                        rounded-[14px] border border-hair bg-[#3a3a42]/95 backdrop-blur-xl
                        shadow-[0_16px_40px_-10px_rgba(0,0,0,0.7)] ${
                            ac.flip ? "bottom-full mb-1" : "top-full mt-1"
                        }`}
            style={{ maxHeight: ac.maxHeight }}
            // Keep focus (and the mobile keyboard) on the textarea.
            onPointerDown={(e) => e.preventDefault()}
        >
            {ac.items.map((item, i) => {
                const cat = CATEGORIES[item.cat] ?? CATEGORIES[0];
                return (
                    <li key={item.id}>
                        <button
                            type="button"
                            onPointerUp={() => onPick(item)}
                            onPointerEnter={() => onHover((s) => ({ ...s, sel: i }))}
                            className={`flex h-[34px] w-full items-center gap-2.5 px-2.5 text-left
                                        ${i === ac.sel ? "bg-panel-3" : ""}`}
                        >
                            <span className="w-9 shrink-0 text-right text-[11.5px] tabular-nums text-faint">
                                {short(item.count)}
                            </span>
                            <span className="flex-1 truncate text-[13px] text-fg">
                                {item.label}
                            </span>
                            <span
                                className="shrink-0 text-[10.5px] font-medium uppercase tracking-[0.06em]"
                                style={{ color: cat.color }}
                            >
                                {cat.name.slice(0, 4)}
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
