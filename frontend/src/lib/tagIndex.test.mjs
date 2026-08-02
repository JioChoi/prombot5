import assert from "node:assert/strict";
import { completionPrefix, parseQuery, searchTags } from "./tagIndex.js";

// Full names and any unambiguous shortening of them.
assert.deepEqual(parseQuery("artist:yoneyama"), { cat: 1, term: "yoneyama" });
assert.deepEqual(parseQuery("art:yoneyama"), { cat: 1, term: "yoneyama" });
assert.deepEqual(parseQuery("char:reimu"), { cat: 4, term: "reimu" });
assert.deepEqual(parseQuery("copyright:touhou"), { cat: 3, term: "touhou" });
assert.deepEqual(parseQuery("meta:"), { cat: 5, term: "" });

// Ambiguous or unknown prefixes are ordinary text, not a filter: "c" could be
// copyright or character, and a tag may legitimately contain a colon.
assert.deepEqual(parseQuery("c:reimu"), { cat: null, term: "c:reimu" });
assert.deepEqual(parseQuery("nope:x"), { cat: null, term: "nope:x" });
assert.deepEqual(parseQuery("blue eyes"), { cat: null, term: "blue eyes" });
// A leading colon has no prefix in front of it, so there is nothing to name.
assert.deepEqual(parseQuery(":x"), { cat: null, term: ":x" });

// Case and padding come from real typing, not from clean input.
assert.deepEqual(parseQuery("Artist: yone"), { cat: 1, term: " yone" });

// The filter is kept when it is only a filter…
assert.equal(completionPrefix("artist:yone", "yoneyama mai"), "artist:");
assert.equal(completionPrefix("art:kanta", "kantaka"), "art:");
// …and dropped when the tag already carries that namespace, or the prefix
// would land twice: "rating:" + "rating:general".
assert.equal(completionPrefix("rating:gen", "rating:general"), "");
assert.equal(completionPrefix("rat:gen", "rating:general"), "");
assert.equal(completionPrefix("rating:", "rating:explicit"), "");
// No filter typed, nothing to restore.
assert.equal(completionPrefix("blue ey", "blue eyes"), "");
assert.equal(completionPrefix("c:reimu", "hakurei reimu"), "");

// No index loaded yet: search must stay quiet rather than throw.
assert.deepEqual(searchTags("artist:yone"), []);

console.log("ok");
