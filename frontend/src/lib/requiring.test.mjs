import assert from "node:assert/strict";
import { unmetRequirement } from "./requiring.js";

const requires = new Map([
    ["skirt_lift", ["skirt"]],
    ["open_clothes", ["clothes"]],
    ["bra_lift", ["bra"]],
    ["bikini_pull", ["bikini"]],
]);
const groups = new Map([
    ["skirt", ["attire"]],
    ["red_dress", ["attire"]],
    ["bra_lift", ["attire"]],
    ["blue_eyes", ["feature"]],
]);
const unmet = (tags) => unmetRequirement(new Set(tags), requires, groups);

// The named garment is there, in plain form or as a compound.
assert.equal(unmet(["skirt", "skirt_lift"])("skirt_lift"), false);
assert.equal(unmet(["pleated_skirt", "skirt_lift"])("skirt_lift"), false);
assert.equal(unmet(["skirt_lift"])("skirt_lift"), true);
assert.equal(unmet(["red_dress", "skirt_lift"])("skirt_lift"), true);

// "clothes" is any garment at all.
assert.equal(unmet(["red_dress", "open_clothes"])("open_clothes"), false);
assert.equal(unmet(["blue_eyes", "open_clothes"])("open_clothes"), true);

// Nude beats every garment, generic or named.
assert.equal(unmet(["red_dress", "nude", "open_clothes"])("open_clothes"), true);
assert.equal(unmet(["skirt", "completely_nude", "skirt_lift"])("skirt_lift"), true);

// A requiring tag is not the garment it needs, even when filed under attire.
assert.equal(unmet(["bra_lift", "open_clothes"])("open_clothes"), true);

// Tags with no requirement are never touched.
assert.equal(unmet(["blue_eyes"])("blue_eyes"), false);

console.log("ok");
