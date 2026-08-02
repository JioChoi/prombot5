import { useEffect, useRef, useState } from "react";
import { verifyToken } from "../lib/nai.js";

/**
 * Native <dialog> so the browser handles the backdrop, focus trap and Esc for us.
 * Persistent API key only — pasted from NovelAI's account settings.
 */
export default function LoginSheet({ open, onClose, onToken }) {
    const ref = useRef(null);
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
    }, [open]);

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await verifyToken(key.trim());
            onToken(key.trim());
            setKey("");
            onClose();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <dialog
            ref={ref}
            onClose={onClose}
            onClick={(e) => e.target === ref.current && onClose()}
            className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-[22px] border border-hair
                       bg-[#33333a]/90 p-0 text-fg backdrop-blur-2xl backdrop:bg-black/60"
        >
            <form onSubmit={submit} className="p-4">
                <h2 className="text-[15px] font-semibold">Log in with NovelAI</h2>
                <p className="mt-1 text-[12px] leading-snug text-dim">
                    Paste a persistent API key from your NovelAI account settings. It stays
                    on this device.
                </p>

                <div className="mt-3 overflow-hidden rounded-[17px] bg-panel-2">
                    <label className="flex h-11 items-center gap-2 px-3">
                        <span className="shrink-0 text-[13.5px] text-mut">Key</span>
                        <input
                            type="password"
                            autoComplete="off"
                            placeholder="pst-…"
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                            spellCheck={false}
                            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg
                                       placeholder:text-faint focus:outline-none"
                        />
                    </label>
                </div>

                {error ? (
                    <p role="alert" className="mt-2 text-[12px] leading-snug text-red-400">
                        {error}
                    </p>
                ) : null}

                <div className="mt-4 flex gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-11 flex-1 rounded-[15px] border border-hair bg-panel-2
                                   text-[14px] text-mut transition-colors active:text-fg"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!key.trim() || busy}
                        className="lit h-11 flex-[1.4] rounded-[15px] bg-white text-[14px] font-semibold
                                   text-[#17171a] transition-transform active:scale-[0.985]
                                   disabled:opacity-40"
                    >
                        {busy ? "Checking…" : "Log in"}
                    </button>
                </div>
            </form>
        </dialog>
    );
}
