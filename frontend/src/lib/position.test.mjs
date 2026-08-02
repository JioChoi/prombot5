import assert from "node:assert/strict";
import { CELLS, cellKey, cellLabel, freeCell } from "./position.js";

// Two characters must never end up on the same cell, which is the whole reason
// freeCell exists — adding one always skips whatever is already occupied.
assert.deepEqual(freeCell([]), { x: 0.1, y: 0.1 });
assert.deepEqual(freeCell([{ x: 0.1, y: 0.1 }]), { x: 0.3, y: 0.1 });
assert.deepEqual(
    freeCell([
        { x: 0.1, y: 0.1 },
        { x: 0.3, y: 0.1 },
    ]),
    { x: 0.5, y: 0.1 },
);

// Rows fill after a column runs out, so the sixth character wraps down a row.
assert.deepEqual(freeCell(CELLS.map((x) => ({ x, y: 0.1 }))), { x: 0.1, y: 0.3 });

// All 25 taken: fall back rather than hand out undefined.
const all = CELLS.flatMap((y) => CELLS.map((x) => ({ x, y })));
assert.deepEqual(freeCell(all), { x: 0.5, y: 0.5 });

// Labels are what the button shows; a wrong index silently mislabels every cell.
assert.equal(cellLabel({ x: 0.1, y: 0.1 }), "A1");
assert.equal(cellLabel({ x: 0.9, y: 0.9 }), "E5");
assert.equal(cellLabel({ x: 0.5, y: 0.5 }), "C3");
assert.equal(cellLabel(null), "Set");

// Occupancy is a string-set lookup, so equal coordinates must produce equal keys
// even when one side arrived through float arithmetic.
assert.equal(cellKey({ x: 0.3, y: 0.7 }), cellKey({ x: 0.1 + 0.2, y: 0.7 }));

console.log("ok");
