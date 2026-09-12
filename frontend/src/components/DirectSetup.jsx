import { CheckCircle2, Download, Monitor, ShieldCheck, Smartphone, Apple } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/* Installing the userscript, explained.

   The ask is unusual — install a browser extension, then a script inside it —
   so the sheet leads with why it is worth doing, then gives one numbered path
   per platform rather than a single set of steps hedged three ways. */

const SCRIPT_URL = "/prombot-nai.user.js";

const PLATFORMS = [
    {
        key: "desktop",
        label: "Computer",
        icon: Monitor,
        store: "https://www.tampermonkey.net/",
        storeLabel: "tampermonkey.net",
        steps: [
            "Open tampermonkey.net and click the icon for your browser — Chrome, Edge, Firefox, Safari or Opera. It takes you to that browser's add-on page.",
            "Click Add to Chrome / Add to Firefox and confirm. A small black-and-white monkey icon appears near your address bar.",
            "Come back to this page and press Install the script below. Tampermonkey opens a page showing what the script does.",
            "Click Install on that page. That is it — this tab will notice within a second or two.",
        ],
    },
    {
        key: "android",
        label: "Android",
        icon: Smartphone,
        store: "https://play.google.com/store/apps/details?id=com.kiwibrowser.browser",
        storeLabel: "a browser that takes extensions",
        steps: [
            "Chrome on Android cannot run extensions, so use one that can: Firefox for Android, Kiwi Browser or Edge. Firefox is the easiest.",
            "In that browser, open the add-ons menu (⋮ → Add-ons, or Extensions) and search for Tampermonkey, then add it.",
            "Still in that browser, open prombot.net again — the script only works in the browser the extension lives in.",
            "Press Install the script below and confirm on the page Tampermonkey shows you.",
        ],
    },
    {
        key: "ios",
        label: "iPhone / iPad",
        icon: Apple,
        store: "https://apps.apple.com/app/stay-for-safari/id1591620171",
        storeLabel: "Stay for Safari",
        steps: [
            "Tampermonkey is not on iOS, so install Stay for Safari from the App Store instead. It does the same job.",
            "Open Settings → Apps → Safari → Extensions → Stay, turn it on, and set it to Allow for prombot.net. Choose Always Allow when Safari asks.",
            "Open Stay once so it finishes setting itself up, then come back to Safari.",
            "Press Install the script below. Stay shows the script and an Install button — tap it, then reload this page.",
        ],
    },
];

function Tab({ active, onClick, icon: Icon, children }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[13px] px-2 py-2
                        text-[12.5px] font-medium transition-colors ${
                            active ? "bg-panel-3 text-fg" : "text-dim active:text-fg"
                        }`}
        >
            <Icon strokeWidth={1.75} className="h-[15px] w-[15px] shrink-0" />
            {children}
        </button>
    );
}

/**
 * The setup sheet. Shown on load while the script is missing, and openable from
 * the header chip at any time.
 *
 * `onSnooze` is given the number of days to stay quiet for; the caller owns
 * that memory, since it has to outlive this component.
 */
export default function DirectSetup({ open, installed, onClose, onSnooze }) {
    const ref = useRef(null);
    const [os, setOs] = useState(guess);
    const [snooze, setSnooze] = useState(false);

    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
    }, [open]);

    function close() {
        if (snooze) onSnooze(7);
        onClose();
    }

    const plat = PLATFORMS.find((p) => p.key === os) ?? PLATFORMS[0];

    return (
        <dialog
            ref={ref}
            onClose={close}
            onClick={(e) => e.target === ref.current && close()}
            className="m-auto max-h-[86svh] w-[min(30rem,calc(100vw-1.5rem))] overflow-y-auto
                       rounded-[24px] border border-hair bg-[#33333a]/92 p-0 text-fg
                       backdrop-blur-2xl backdrop:bg-black/65"
        >
            <div className="p-5">
                {installed ? (
                    <div className="mb-3 flex items-center gap-2 rounded-[15px] bg-emerald-400/12 px-3 py-2.5">
                        <CheckCircle2 strokeWidth={2} className="h-[18px] w-[18px] text-emerald-300" />
                        <p className="text-[13px] text-emerald-100">
                            The script is installed. Your generations go straight to NovelAI from
                            this device.
                        </p>
                    </div>
                ) : null}

                <div className="flex items-start gap-2.5">
                    <ShieldCheck strokeWidth={1.75} className="mt-0.5 h-5 w-5 shrink-0 text-accent-lit" />
                    <div>
                        <h2 className="font-display text-[17px] font-semibold leading-tight">
                            Protect your NovelAI account
                        </h2>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-mut">
                            NovelAI has started banning accounts that share an IP address with
                            others. Right now Prombot sends your generations through its own relay
                            servers, so NovelAI sees the relay's address — the same address as
                            everyone else using Prombot. That is a risk to your account, and it is
                            not one you can do anything about from this side.
                        </p>
                        <p className="mt-2 text-[13px] leading-relaxed text-mut">
                            A small browser script fixes it completely. With it installed, your
                            device talks to NovelAI directly: no relay, no shared address, nothing
                            in between. Your API key never goes anywhere it was not already going,
                            and Prombot never sees it.
                        </p>
                    </div>
                </div>

                <div className="mt-4 flex gap-1 rounded-[15px] bg-panel p-1">
                    {PLATFORMS.map((p) => (
                        <Tab key={p.key} active={p.key === os} icon={p.icon} onClick={() => setOs(p.key)}>
                            {p.label}
                        </Tab>
                    ))}
                </div>

                <ol className="mt-3 space-y-2.5">
                    {plat.steps.map((step, i) => (
                        <li key={i} className="flex gap-2.5">
                            <span
                                className="mt-px flex h-[21px] w-[21px] shrink-0 items-center justify-center
                                           rounded-full bg-panel-2 text-[11.5px] font-semibold tabular-nums text-mut"
                            >
                                {i + 1}
                            </span>
                            <p className="text-[13px] leading-relaxed text-mut">{step}</p>
                        </li>
                    ))}
                </ol>

                <a
                    href={plat.store}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-3 inline-block text-[12.5px] text-accent-lit underline underline-offset-2"
                >
                    Open {plat.storeLabel} →
                </a>

                <a
                    href={SCRIPT_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="lit mt-4 flex h-12 items-center justify-center gap-2 rounded-[16px] bg-white
                               text-[14.5px] font-semibold text-[#17171a] transition-transform
                               active:scale-[0.985]"
                >
                    <Download strokeWidth={2.25} className="h-[17px] w-[17px]" />
                    Install the script
                </a>
                <p className="mt-2 text-center text-[11.5px] leading-snug text-dim">
                    Nothing happens unless the extension above is installed first. Reload this page
                    after installing.
                </p>

                <div className="mt-4 flex items-center justify-between gap-3 border-t border-hair pt-3">
                    <label className="flex items-center gap-2 text-[12.5px] text-dim">
                        <input
                            type="checkbox"
                            checked={snooze}
                            onChange={(e) => setSnooze(e.target.checked)}
                            className="h-4 w-4 accent-[#4d8dff]"
                        />
                        Don't show this for 7 days
                    </label>
                    <button
                        type="button"
                        onClick={close}
                        className="h-10 rounded-[14px] border border-hair bg-panel-2 px-4 text-[13.5px]
                                   text-mut transition-colors active:text-fg"
                    >
                        {installed ? "Done" : "Not now"}
                    </button>
                </div>
            </div>
        </dialog>
    );
}

/** Which set of steps to open on, from what the browser admits to being. */
function guess() {
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
        return "ios";
    }
    return /Android/.test(ua) ? "android" : "desktop";
}
