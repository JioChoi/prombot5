import { Check, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { deletePreset, listPresets, renamePreset, savePreset } from "../lib/presets.js";
import { useSettingsIO } from "../state/settings.jsx";

/** "8 Aug" — a preset is placed by when you made it, not by the minute. */
const madeOn = (iso) =>
    new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

const ROW_ACTION = `flex h-7 w-7 shrink-0 items-center justify-center rounded-full
                    text-dim transition-colors active:bg-panel-3 active:text-fg`;

/**
 * Everything the console holds, saved under a name and brought back on demand.
 *
 * The list is the backend's copy, kept in state and re-read after every write —
 * presets follow the key, so the same key on another device shows the same list
 * and a stale local copy would be a lie.
 */
export default function PresetsDrawer({ open, onClose, token, current, onCurrent }) {
    const { snapshot, apply } = useSettingsIO();
    const [items, setItems] = useState(null); // null until the first load lands
    const [error, setError] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    // One row at a time is being renamed or asked about, never two.
    const [editing, setEditing] = useState(null);
    const [draft, setDraft] = useState("");
    const [confirming, setConfirming] = useState(null);
    // What the console held before the last load, so one press puts it back.
    const [undo, setUndo] = useState(null);
    const nameField = useRef(null);

    async function refresh() {
        try {
            setItems(await listPresets(token));
            setError("");
        } catch (e) {
            setError(e.message);
        }
    }

    // Re-read on every open: another device may have saved since.
    useEffect(() => {
        if (!open || !token) return;
        setUndo(null);
        setEditing(null);
        setConfirming(null);
        refresh();
        // The name field starts on the preset you are working in, so Save
        // overwrites it and does not quietly make a second copy.
        setName(current ?? "");
    }, [open, token]); // eslint-disable-line react-hooks/exhaustive-deps

    /** Every write goes through here: same busy state, same error line, same reload. */
    async function write(fn) {
        setBusy(true);
        try {
            await fn();
            setError("");
            await refresh();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    function save() {
        const wanted = name.trim();
        if (!wanted) {
            nameField.current?.focus();
            return;
        }
        write(async () => {
            await savePreset(token, wanted, JSON.stringify(snapshot()));
            onCurrent(wanted);
        });
    }

    function load(item) {
        setUndo({ name: current, settings: snapshot() });
        apply(JSON.parse(item.config));
        onCurrent(item.name);
        setName(item.name);
    }

    const exists = items?.some((it) => it.name === name.trim());

    return (
        <>
            <div
                onClick={onClose}
                aria-hidden="true"
                className={`fixed inset-0 z-40 bg-[#0e0e10]/65 backdrop-blur-[3px] transition-opacity duration-300 ${
                    open ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
            />
            <aside
                aria-label="Presets"
                aria-hidden={!open}
                className={`fixed inset-y-0 left-0 z-50 flex w-[86vw] max-w-[330px] flex-col border-r border-hair
                            bg-[#2e2e35]/88 backdrop-blur-2xl transition-transform duration-300
                            [transition-timing-function:cubic-bezier(.22,1,.36,1)] ${
                                open ? "translate-x-0" : "-translate-x-full"
                            }`}
            >
                <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-5">
                    <h2 className="text-[15px] font-semibold">Presets</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close presets"
                        className="flex h-8 w-8 items-center justify-center rounded-md text-dim
                                   transition-colors active:text-fg"
                    >
                        <X strokeWidth={2} className="h-4 w-4" />
                    </button>
                </header>

                {!token ? (
                    <p className="px-4 py-6 text-[12.5px] leading-relaxed text-dim">
                        Log in with your NovelAI key to save presets. They follow the key,
                        so the same key on another device opens the same list.
                    </p>
                ) : (
                    <>
                        {/* Saving is the reason the drawer is open, so it sits at the
                            top and needs no scrolling to reach. */}
                        <div className="px-3 pb-3">
                            <div className="flex items-center gap-2 rounded-[14px] border border-hair bg-panel-2 p-1.5">
                                <input
                                    ref={nameField}
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && save()}
                                    placeholder="Name this preset"
                                    spellCheck={false}
                                    maxLength={64}
                                    aria-label="Preset name"
                                    className="min-w-0 flex-1 bg-transparent px-2 text-[13.5px] text-fg
                                               placeholder:text-faint focus:outline-none"
                                />
                                <button
                                    type="button"
                                    onClick={save}
                                    disabled={busy || !name.trim()}
                                    className="shrink-0 rounded-[10px] bg-white px-3 py-1.5 text-[12.5px]
                                               font-semibold text-[#17171a] transition-transform
                                               active:scale-[0.97] disabled:bg-panel-3 disabled:text-faint"
                                >
                                    {exists ? "Overwrite" : "Save"}
                                </button>
                            </div>
                            <p className="mt-1.5 px-1 text-[11.5px] leading-snug text-faint">
                                Saves the prompt, characters, filters and image settings as
                                they are right now.
                            </p>
                        </div>

                        {error ? (
                            <p role="alert" className="px-4 pb-2 text-[12px] leading-snug text-red-400">
                                {error}
                            </p>
                        ) : null}

                        <div className="scroll-thin flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
                            {items === null ? null : items.length === 0 ? (
                                <p className="px-2 py-5 text-[12.5px] leading-relaxed text-dim">
                                    No presets yet. Set the console up the way you like it,
                                    give it a name above, and it comes back with one tap.
                                </p>
                            ) : (
                                <ul className="space-y-1.5">
                                    {items.map((it) => (
                                        <li
                                            key={it.name}
                                            className={`overflow-hidden rounded-[14px] border transition-colors ${
                                                it.name === current
                                                    ? "border-accent-lit/60 bg-accent/12"
                                                    : "border-hair bg-panel"
                                            }`}
                                        >
                                            {confirming === it.name ? (
                                                <div className="flex items-center gap-2 px-3 py-2">
                                                    <span className="min-w-0 flex-1 truncate text-[13px] text-mut">
                                                        Delete “{it.name}”?
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => setConfirming(null)}
                                                        className="rounded-full px-2 py-1 text-[12px] text-dim
                                                                   transition-colors active:text-fg"
                                                    >
                                                        Keep
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            write(async () => {
                                                                await deletePreset(token, it.name);
                                                                setConfirming(null);
                                                                if (current === it.name) onCurrent("");
                                                            })
                                                        }
                                                        className="rounded-full bg-live/20 px-2.5 py-1 text-[12px]
                                                                   font-medium text-live transition-colors
                                                                   active:bg-live/30 disabled:opacity-40"
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
                                            ) : editing === it.name ? (
                                                <div className="flex items-center gap-1.5 px-3 py-1.5">
                                                    <input
                                                        autoFocus
                                                        value={draft}
                                                        maxLength={64}
                                                        aria-label={`Rename ${it.name}`}
                                                        onChange={(e) => setDraft(e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === "Escape") setEditing(null);
                                                            if (e.key === "Enter") e.currentTarget.blur();
                                                        }}
                                                        onBlur={() => {
                                                            const to = draft.trim();
                                                            setEditing(null);
                                                            if (!to || to === it.name) return;
                                                            write(async () => {
                                                                await renamePreset(token, it.name, to);
                                                                if (current === it.name) {
                                                                    onCurrent(to);
                                                                    setName(to);
                                                                }
                                                            });
                                                        }}
                                                        className="min-w-0 flex-1 bg-transparent py-1 text-[13.5px]
                                                                   text-fg focus:outline-none"
                                                    />
                                                    <Check
                                                        aria-hidden
                                                        strokeWidth={2}
                                                        className="h-4 w-4 shrink-0 text-dim"
                                                    />
                                                </div>
                                            ) : (
                                                <div className="flex items-center">
                                                    <button
                                                        type="button"
                                                        onClick={() => load(it)}
                                                        aria-current={it.name === current}
                                                        className="flex min-w-0 flex-1 items-baseline gap-2 px-3 py-2.5 text-left
                                                                   transition-colors active:bg-panel-2"
                                                    >
                                                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">
                                                            {it.name}
                                                        </span>
                                                        <span className="num shrink-0 text-[11px] text-faint">
                                                            {madeOn(it.created_at)}
                                                        </span>
                                                    </button>
                                                    <div className="flex shrink-0 items-center gap-0.5 pr-2">
                                                        <button
                                                            type="button"
                                                            aria-label={`Rename ${it.name}`}
                                                            onClick={() => {
                                                                setDraft(it.name);
                                                                setEditing(it.name);
                                                            }}
                                                            className={ROW_ACTION}
                                                        >
                                                            <Pencil strokeWidth={1.75} className="h-[15px] w-[15px]" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            aria-label={`Delete ${it.name}`}
                                                            onClick={() => setConfirming(it.name)}
                                                            className={ROW_ACTION}
                                                        >
                                                            <Trash2 strokeWidth={1.75} className="h-[15px] w-[15px]" />
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        {/* Loading replaces every field at once. This is the way back,
                            and it stays until the next load or the drawer closes. */}
                        {undo ? (
                            <div className="flex items-center gap-3 border-t border-hair px-4 py-3">
                                <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">
                                    Loaded “{current}”
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        apply(undo.settings);
                                        onCurrent(undo.name ?? "");
                                        setName(undo.name ?? "");
                                        setUndo(null);
                                    }}
                                    className="shrink-0 rounded-full border border-hair px-3 py-1 text-[12px]
                                               text-fg transition-colors active:bg-panel-2"
                                >
                                    Undo
                                </button>
                            </div>
                        ) : null}
                    </>
                )}
            </aside>
        </>
    );
}
