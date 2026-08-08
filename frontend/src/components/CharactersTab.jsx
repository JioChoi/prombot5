import { ChevronLeft, Search, Star, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import usePersistentState from "../hooks/usePersistentState.js";
import {
    SORTS,
    applySort,
    loadCharacters,
    portrait,
    searchCharacters,
    searchSeries,
    withTags,
} from "../lib/characters.js";
import { freeCell } from "../lib/position.js";
import { useSetting } from "../state/settings.jsx";
import Dropdown from "./Dropdown.jsx";

const SORT_GROUPS = [{ header: "", options: SORTS }];

/* One series can hold thousands of characters and the catch-all group holds
   every one-off in the dump, so the grid grows as it is scrolled rather than
   laying out 19k cards nobody will reach. */
const PAGE = 120;

/** Two across on a phone, and as many as the full width will carry. */
const GRID = "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-7";

function StarButton({ on, onClick, label }) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={on}
            onClick={onClick}
            // Over artwork, so it carries its own dark disc rather than trusting
            // whatever pixel it lands on to be dark enough.
            className={`absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center
                        rounded-full bg-black/45 backdrop-blur-sm transition-colors ${
                            on ? "text-[#f5d76e]" : "text-white/55 active:text-white"
                        }`}
        >
            <Star
                strokeWidth={2}
                fill={on ? "currentColor" : "none"}
                className="h-[15px] w-[15px]"
            />
        </button>
    );
}

/** The reference picture, or a plate carrying the initial when there is none.
    Whether one exists is only knowable from the 404, so the fallback is a
    load failure rather than a lookup. */
function Portrait({ name, title }) {
    const [broken, setBroken] = useState(false);
    if (!name || broken) {
        return (
            <div className="flex h-full w-full items-center justify-center bg-panel-2">
                <span className="font-display text-[30px] font-medium uppercase text-white/15">
                    {title.slice(0, 1)}
                </span>
            </div>
        );
    }
    return (
        <img
            src={portrait(name)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            // Anchored to the top, centred across: these are full-body reference
            // pictures in a 3:4 crop, and centring vertically is what cuts the
            // face off. The head is the part that identifies the character.
            className="h-full w-full object-cover object-top"
        />
    );
}

/** A poster tile: the picture is the card, and the label sits in the scrim over
    its foot. The star cannot be nested inside the tile's own button, so the two
    are siblings in a relative box. */
function Tile({ image, title, note, count, fav, onFav, onOpen, favLabel }) {
    return (
        <div className="relative">
            <button
                type="button"
                onClick={onOpen}
                className="block w-full overflow-hidden rounded-[16px] border border-hair
                           bg-panel text-left transition-transform active:scale-[0.985]"
            >
                <div className="relative aspect-[3/4] w-full">
                    <Portrait name={image} title={title} />
                    {/* Tall enough to carry three lines of text and still fade
                        out over the picture rather than cutting across it. */}
                    <div
                        className="absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-10"
                        style={{
                            background:
                                "linear-gradient(180deg, transparent, rgb(0 0 0/0.55) 42%, rgb(0 0 0/0.88))",
                        }}
                    >
                        <p className="line-clamp-2 text-[12.5px] font-medium capitalize leading-snug text-white">
                            {title}
                        </p>
                        {note ? (
                            <p className="line-clamp-1 text-[11px] capitalize text-white/60">
                                {note}
                            </p>
                        ) : null}
                        <p className="num text-[10.5px] text-white/55">{count}</p>
                    </div>
                </div>
            </button>
            <StarButton on={fav} onClick={onFav} label={favLabel} />
        </div>
    );
}

/** What clicking a character offers: the two clipboard forms and the one that
    puts them straight into the prompt. */
function CharacterSheet({ character, onClose, onAppend }) {
    const [done, setDone] = useState("");
    useEffect(() => {
        if (!done) return;
        const t = setTimeout(() => setDone(""), 1200);
        return () => clearTimeout(t);
    }, [done]);

    async function copy(text, what) {
        try {
            await navigator.clipboard.writeText(text);
            setDone(what);
        } catch {
            setDone("failed");
        }
    }

    const tags = withTags(character);

    return (
        <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center">
            <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="absolute inset-0 bg-black/45"
            />
            <div
                role="dialog"
                aria-label={character.label}
                className="relative m-3 w-full max-w-[420px] rounded-[22px] border border-hair
                           bg-[#3a3a42]/92 p-3 backdrop-blur-2xl
                           shadow-[inset_0_1px_0_0_rgb(255_255_255/0.14),0_24px_60px_-18px_rgb(0_0_0/0.7)]"
                style={{ marginBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
            >
                <div className="mb-2 flex items-start gap-2.5">
                    {/* The same picture the tile carried, so the sheet reads as
                        that tile opening rather than as a menu about a name. */}
                    <div className="h-14 w-[42px] shrink-0 overflow-hidden rounded-[10px] border border-hair">
                        <Portrait name={character.name} title={character.label} />
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                        <h2 className="truncate text-[15px] font-semibold capitalize text-fg">
                            {character.label}
                        </h2>
                        <p className="truncate text-[12px] text-dim">
                            <span className="capitalize">
                                {character.series || "no series"}
                            </span>{" "}
                            ·{" "}
                            <span className="num">{character.posts.toLocaleString()}</span> posts
                        </p>
                    </div>
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={onClose}
                        className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full
                                   text-dim active:bg-panel-2"
                    >
                        <X strokeWidth={2} className="h-4 w-4" />
                    </button>
                </div>

                {/* The traits, so "copy with tags" is not a blind press. */}
                {tags !== character.label ? (
                    <p className="mb-2 px-1 text-[11.5px] leading-relaxed text-faint">{tags}</p>
                ) : null}

                <div className="overflow-hidden rounded-[16px] border border-hair [&>*]:hair-top">
                    <SheetAction onClick={() => copy(character.label, "name")}>
                        Copy name
                    </SheetAction>
                    <SheetAction onClick={() => copy(tags, "tags")}>Copy name with tags</SheetAction>
                    <SheetAction onClick={onAppend}>Append to characters</SheetAction>
                </div>

                {/* Fixed height: the row appearing would otherwise shove the
                    buttons the moment one is pressed. */}
                <p className="h-4 pt-1 text-center text-[11px] text-accent-lit" aria-live="polite">
                    {done === "name"
                        ? "Name copied"
                        : done === "tags"
                          ? "Name and tags copied"
                          : done === "failed"
                            ? "Clipboard unavailable"
                            : ""}
                </p>
            </div>
        </div>
    );
}

function SheetAction({ onClick, children }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full px-3 py-3 text-left text-[13.5px] text-fg transition-colors
                       active:bg-panel-2"
        >
            {children}
        </button>
    );
}

export default function CharactersTab({ active, onGenerate }) {
    const [index, setIndex] = useState(null);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState("popular");
    // Which series is open. Null is the series list; the query overrides both.
    const [openKey, setOpenKey] = useState(null);
    const [picked, setPicked] = useState(null);
    const [shown, setShown] = useState(PAGE);
    const [favorites, setFavorites] = usePersistentState("charFavorites", []);
    const [, setCharacters] = useSetting("characters");

    const scrollRef = useRef(null);
    /* Where each list was last left, keyed by the view showing it. Three lists
       nest here — the series list, one series' cast, and the search results —
       and going back to any of them should land where you were, not at the top
       of a 900-entry grid. One map rather than a ref per list, because the
       series' own key is what distinguishes its members from anyone else's. */
    const scrolls = useRef(new Map());
    // Where *this* list was left. The tab is hidden with display:none, which
    // takes the scroll box away and zeroes scrollTop, so it has to be put back
    // by hand every time the tab comes round again.
    const liveScroll = useRef(0);

    useEffect(() => {
        loadCharacters().then(setIndex, () => setFailed(true));
    }, []);

    const favSet = useMemo(() => new Set(favorites), [favorites]);
    const searching = query.trim() !== "";

    /* One memo for what the grid shows, because every input to it — the query,
       the sort, the open series, the favourites — changes the same list. */
    const items = useMemo(() => {
        if (!index) return [];
        if (searching) {
            // Matching series lead, then the characters. Typing a series name
            // has to be able to reach the series itself and not only its cast,
            // and putting the groups first reads as "did you mean this one?"
            // without needing a heading — a tile counting characters already
            // looks nothing like a tile counting posts.
            return [
                ...applySort(searchSeries(index, query), sort, favSet),
                ...applySort(searchCharacters(index, query), sort, favSet),
            ];
        }
        if (openKey !== null) {
            const g = index.series.find((s) => s.key === openKey);
            return g ? applySort(g.members, sort, favSet) : [];
        }
        return applySort(index.series, sort, favSet);
    }, [index, query, searching, sort, openKey, favSet]);

    // A new list starts from the top of the page again, or scrolling one long
    // list would leave the next one already unrolled.
    useEffect(() => setShown(PAGE), [items]);

    // Which list is on screen. The \0 keeps these apart from a series key.
    const viewKey = searching ? "\0search" : (openKey ?? "\0root");

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = scrolls.current.get(viewKey) ?? 0;
        liveScroll.current = el.scrollTop;
    }, [viewKey]);

    /* Every keystroke is a different result set, so the offset carried over from
       the last one means nothing. Declared after the restore above so that on
       the first keystroke — when both fire — this one wins. Clearing the box
       leaves the query empty and the restore has the view to itself. */
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (query.trim() && el) {
            el.scrollTop = 0;
            scrolls.current.set("\0search", 0);
            liveScroll.current = 0;
        }
    }, [query]);

    useLayoutEffect(() => {
        if (active && scrollRef.current) scrollRef.current.scrollTop = liveScroll.current;
    }, [active]);

    const inSeries = !searching && openKey !== null;
    const groupLabel = inSeries
        ? (index?.series.find((s) => s.key === openKey)?.label ?? "")
        : "";

    // The scroll is handled by the view effect above: leaving records where this
    // list was, arriving restores wherever that series was last left. The query
    // goes with it, since searching outranks the open series and the cast would
    // otherwise never show.
    const enter = (g) => {
        setQuery("");
        setOpenKey(g.key);
    };

    function toggleFav(name) {
        setFavorites((f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name]));
    }

    /* A new slot rather than an overwrite: "append" is how you build a cast,
       and the position picker needs a free cell like any other added character. */
    function append(c) {
        setCharacters((cs) => [
            ...cs,
            {
                id: Math.max(0, ...cs.map((x) => x.id)) + 1,
                text: c.label,
                negative: "",
                ...freeCell(cs.filter((x) => x.x !== undefined && !x.off)),
            },
        ]);
        setPicked(null);
        onGenerate();
    }

    // Cards are uniform, so "near the bottom" is enough to unroll the next page.
    function onScroll(e) {
        const el = e.currentTarget;
        liveScroll.current = el.scrollTop;
        scrolls.current.set(viewKey, el.scrollTop);
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
            setShown((n) => (n < items.length ? n + PAGE : n));
        }
    }

    return (
        <div className="absolute inset-0 flex flex-col">
            <div
                className="shrink-0 space-y-2 px-3 pb-2"
                style={{ paddingTop: "calc(3.5rem + env(safe-area-inset-top))" }}
            >
                <div className="flex items-center gap-2">
                    {/* Back sits with the search field, not above it: on a phone
                        it has to be reachable without moving the thumb. */}
                    {inSeries ? (
                        <button
                            type="button"
                            onClick={() => setOpenKey(null)}
                            aria-label="Back to series"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px]
                                       border border-hair bg-panel text-mut active:text-fg"
                        >
                            <ChevronLeft strokeWidth={2} className="h-[18px] w-[18px]" />
                        </button>
                    ) : null}

                    <div
                        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-panel
                                   px-2.5 ring-1 ring-hair focus-within:ring-accent-lit/60"
                    >
                        <Search strokeWidth={2} className="h-4 w-4 shrink-0 text-faint" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search name, series, attire, features"
                            aria-label="Search characters"
                            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none
                                       placeholder:text-faint"
                        />
                        {query ? (
                            <button
                                type="button"
                                aria-label="Clear search"
                                onClick={() => setQuery("")}
                                className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center
                                           rounded-full text-dim active:bg-panel-2"
                            >
                                <X strokeWidth={2} className="h-3.5 w-3.5" />
                            </button>
                        ) : null}
                    </div>
                </div>

                <div className="flex items-center justify-between gap-3 px-0.5">
                    <span className="truncate text-[11.5px] capitalize text-dim">
                        {searching
                            ? `${items.length.toLocaleString()} results`
                            : inSeries
                              ? groupLabel
                              : `${items.length.toLocaleString()} series`}
                    </span>
                    <div className="w-[150px] shrink-0">
                        <SortMenu value={sort} onChange={setSort} />
                    </div>
                </div>
            </div>

            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="scroll-thin flex-1 overflow-y-auto overscroll-contain px-3 pb-28"
            >
                {failed ? (
                    <p className="pt-10 text-center text-[13px] text-dim">
                        Character list unavailable
                    </p>
                ) : !index ? (
                    <p className="pt-10 text-center text-[13px] text-dim">Loading characters…</p>
                ) : items.length === 0 ? (
                    <p className="pt-10 text-center text-[13px] text-dim">
                        {sort === "favorites" ? "No favorites yet" : "Nothing matches"}
                    </p>
                ) : (
                    <>
                        <div className={GRID}>
                            {items.slice(0, shown).map((it) =>
                                it.members ? (
                                    <Tile
                                        key={it.key}
                                        image={it.cover}
                                        title={it.label}
                                        count={`${it.count.toLocaleString()} characters`}
                                        fav={it.members.some((m) => favSet.has(m.name))}
                                        favLabel={`Favorite everyone in ${it.label}`}
                                        onFav={() => toggleSeriesFav(it, favSet, setFavorites)}
                                        onOpen={() => enter(it)}
                                    />
                                ) : (
                                    <Tile
                                        key={it.name}
                                        image={it.name}
                                        title={it.label}
                                        // Inside a series every tile would repeat it.
                                        note={inSeries ? "" : it.series}
                                        count={`${it.posts.toLocaleString()} posts`}
                                        fav={favSet.has(it.name)}
                                        favLabel={`Favorite ${it.label}`}
                                        onFav={() => toggleFav(it.name)}
                                        onOpen={() => setPicked(it)}
                                    />
                                ),
                            )}
                        </div>
                        {shown < items.length ? (
                            <p className="py-4 text-center text-[11.5px] text-faint">
                                {(items.length - shown).toLocaleString()} more…
                            </p>
                        ) : null}
                    </>
                )}
            </div>

            {picked ? (
                <CharacterSheet
                    character={picked}
                    onClose={() => setPicked(null)}
                    onAppend={() => append(picked)}
                />
            ) : null}
        </div>
    );
}

/* Starring a series stars its whole cast — the alternative is a star that means
   something different on the two screens. Pressing it again clears them. */
function toggleSeriesFav(group, favSet, setFavorites) {
    const names = group.members.map((m) => m.name);
    const any = names.some((n) => favSet.has(n));
    setFavorites((f) =>
        any ? f.filter((n) => !names.includes(n)) : [...new Set([...f, ...names])],
    );
}

/* Dropdown lives in the settings sheet, where the label is the row beside it.
   Here it needs its own, so the menu is not a bare word in a corner. */
function SortMenu({ value, onChange }) {
    return (
        <div className="flex items-center justify-end gap-1 rounded-[10px] bg-panel px-1.5 py-0.5">
            <span className="shrink-0 text-[11.5px] text-faint">Sort</span>
            <Dropdown value={value} onChange={onChange} groups={SORT_GROUPS} align="right" />
        </div>
    );
}
