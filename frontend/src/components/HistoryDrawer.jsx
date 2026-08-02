import { downloadZip } from "client-zip";
import { Download, X } from "lucide-react";
import { useState } from "react";

export default function HistoryDrawer({ open, onClose, items, activeId, onPick }) {
    const [zipping, setZipping] = useState(false);

    async function saveAll() {
        setZipping(true);
        try {
            // Oldest first, so the archive reads in the order they were made.
            const blob = await downloadZip(
                [...items].reverse().map((it) => ({ name: it.name, input: it.blob })),
            ).blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `nai_${items.length}_images.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            // Revoking immediately can cancel the download on some browsers.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } finally {
            setZipping(false);
        }
    }

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
                aria-label="History"
                aria-hidden={!open}
                className={`fixed inset-y-0 right-0 z-50 flex w-[62vw] max-w-[240px] flex-col border-l border-hair bg-[#2e2e35]/88 backdrop-blur-2xl
                            transition-transform duration-300
                            [transition-timing-function:cubic-bezier(.22,1,.36,1)] ${
                                open ? "translate-x-0" : "translate-x-full"
                            }`}
            >
                <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-5">
                    <h2 className="text-[15px] font-semibold">
                        History
                    </h2>
                    <div className="flex items-center gap-1">
                        {items.length ? (
                            <button
                                type="button"
                                onClick={saveAll}
                                disabled={zipping}
                                aria-label={`Download all ${items.length} images as a zip`}
                                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px]
                                           text-dim transition-colors active:text-fg
                                           disabled:opacity-40"
                            >
                                <Download strokeWidth={2} className="h-4 w-4" />
                                {zipping ? "Zipping…" : "All"}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close history"
                            className="flex h-8 w-8 items-center justify-center rounded-md text-dim
                                       transition-colors active:text-fg"
                        >
                            <X strokeWidth={2} className="h-4 w-4" />
                        </button>
                    </div>
                </header>

                <div className="scroll-thin flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
                    {items.length === 0 ? (
                        <p className="px-2 py-6 text-[12.5px] leading-relaxed text-dim">
                            No images yet. Set a prompt and press Generate — every image
                            lands here.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {items.map((it) => (
                                <button
                                    key={it.id}
                                    type="button"
                                    onClick={() => onPick(it.id)}
                                    aria-current={it.id === activeId}
                                    aria-label={it.title}
                                    className={`block w-full border transition-colors ${
                                        it.id === activeId
                                            ? "border-accent-lit shadow-[0_0_0_3px_rgb(77_141_255/0.4)]"
                                            : "border-hair"
                                    }`}
                                >
                                    <img src={it.src} alt="" className="w-full" />
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </aside>
        </>
    );
}
