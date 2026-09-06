/* The one assumption promptIndex.js's range() rests on: that Hugging Face's
   /resolve/ URL redirects to a CDN that fetch will expose in res.url, and that
   the CDN answers Range with CORS. If HF ever stops doing either, range() is
   back to one rate-limited resolver hit per read and this fails.

       node test-resolve.mjs                         (needs the network)
*/
import assert from "node:assert";

const RESOLVE = "https://huggingface.co/Jio7/Prombot/resolve/main/postings.bin";

const probe = await fetch(RESOLVE, { headers: { Range: "bytes=0-0" } });
probe.body?.cancel();
assert.ok(probe.ok, `probe: ${probe.status}`);
assert.notStrictEqual(probe.url, RESOLVE, "no redirect — res.url still points at the resolver");

const res = await fetch(probe.url, { headers: { Range: "bytes=1024-2047" } });
assert.strictEqual(res.status, 206, `cdn range: ${res.status}`);
assert.strictEqual((await res.arrayBuffer()).byteLength, 1024);
assert.strictEqual(res.headers.get("access-control-allow-origin"), "*", "cdn sends no CORS");

console.log("ok —", new URL(probe.url).host);
