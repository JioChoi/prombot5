/* NovelAI places characters on a 5x5 grid, sent as a center point in 0..1 with
   cells at 0.1/0.3/0.5/0.7/0.9. Stored in those units so nothing has to be
   converted at send time. */
export const CELLS = [0.1, 0.3, 0.5, 0.7, 0.9];

/* Rounded, not raw: occupancy is a string-set lookup, and 0.1 + 0.2 keying
   differently from 0.3 would let two characters share a cell. */
export const cellKey = (p) => (p ? `${p.x.toFixed(1)},${p.y.toFixed(1)}` : "");

/** Column letter + row number, the way the coordinates read in NovelAI's own UI. */
export function cellLabel(p) {
    if (!p) return "Set";
    return `${"ABCDE"[CELLS.indexOf(p.x)] ?? "?"}${CELLS.indexOf(p.y) + 1}`;
}

/** First cell no one else is standing on, so a new character never lands on top
    of an existing one. Falls back to the centre once all 25 are spoken for. */
export function freeCell(taken) {
    const used = new Set(taken.map(cellKey));
    for (const y of CELLS) {
        for (const x of CELLS) {
            if (!used.has(cellKey({ x, y }))) return { x, y };
        }
    }
    return { x: 0.5, y: 0.5 };
}
