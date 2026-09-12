/* node --test src/lib/draw.test.mjs — the client half of a draw now that the
   server does the drawing: the request it sends, and the tag types it cuts out
   of what comes back. */
import assert from "node:assert/strict";
import test from "node:test";

const { randomPrompt } = await import("./promptIndex.js");

const post = {
    post: 7,
    id: 42,
    fav: 300,
    tags: ["1girl", "hatsune_miku", "skirt", "outdoors"],
    cats: [0, 4, 0, 0],
};

/** Answers /api/prompt with `reply`, and the group file off disk. */
function serve(reply) {
    const seen = {};
    globalThis.fetch = async (url, opts) => {
        if (String(url).includes("/api/prompt")) {
            seen.url = String(url);
            seen.auth = opts?.headers?.Authorization;
            return reply();
        }
        const { readFileSync } = await import("node:fs");
        return new Response(readFileSync(new URL("../../public/", import.meta.url).pathname + String(url).slice(1)));
    };
    return seen;
}

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ok = () => json(post);

test("the query and the key travel to the server", async () => {
    const seen = serve(ok);
    await randomPrompt({ include: ["1girl"], exclude: ["text"], minScore: 100 }, "pst-x");
    assert.match(seen.url, /include=1girl/);
    assert.match(seen.url, /exclude=text/);
    assert.match(seen.url, /minScore=100/);
    assert.equal(seen.auth, "Bearer pst-x");
});

test("an empty pool is an answer, a missing route is not", async () => {
    serve(() => new Response(null, { status: 204 }));
    assert.equal(await randomPrompt({ include: ["a"] }, "k"), null);

    // a route the server does not have is not an empty pool
    serve(() => json({ detail: "No such endpoint: /api/prompt" }, 404));
    await assert.rejects(randomPrompt({ include: ["a"] }, "k"), /No such endpoint/);

    serve(() => json({ detail: "One prompt every 10s." }, 429));
    await assert.rejects(randomPrompt({ include: ["a"] }, "k"), /every 10s/);

    // a contradiction is settled here, without asking
    globalThis.fetch = async () => assert.fail("should not have asked the server");
    assert.equal(await randomPrompt({ include: ["1girl"], exclude: ["1girl"] }, "k"), null);
});

test("switched-off tag types are cut from what comes back", async () => {
    serve(ok);
    const cut = await randomPrompt(
        { include: [], exclude: [], drop: ["attire"], dropCats: [4] },
        "k",
    );
    assert.deepEqual(cut.tags, ["1girl", "outdoors"]); // no skirt, no character
    assert.equal(cut.id, 42);

    serve(ok);
    const whole = await randomPrompt({ include: [] }, "k");
    assert.deepEqual(whole.tags, post.tags);
});

test("counting asks the server too, and passes its answer through", async () => {
    const seen = serve(() => json({ n: 1234, exact: false }));
    const { promptCount } = await import("./promptIndex.js");
    assert.deepEqual(await promptCount({ include: ["rain"], minScore: 50 }, "pst-x"), {
        n: 1234,
        exact: false,
    });
    assert.match(seen.url, /\/api\/prompt-count\?/);
    assert.match(seen.url, /include=rain/);
    assert.equal(seen.auth, "Bearer pst-x");
});

test("a key with a pasted newline is trimmed, not sent as is", async () => {
    const seen = serve(ok);
    await randomPrompt({ include: [] }, " pst-x\n");
    assert.equal(seen.auth, "Bearer pst-x");

    globalThis.fetch = async () => assert.fail("should not have asked without a key");
    await assert.rejects(randomPrompt({ include: [] }, "  "), /Log in with your NovelAI key/);
});

test("HTML where JSON was expected names the real problem", async () => {
    // what a backend without this endpoint answers: the SPA's own index.html
    serve(() => new Response("<!doctype html><title>app</title>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
    }));
    await assert.rejects(randomPrompt({ include: [] }, "k"), /backend up to date/);
});

test("a rate limit is waited out once, not thrown at the user", async () => {
    let calls = 0;
    serve(() => {
        calls++;
        return calls === 1
            ? new Response(JSON.stringify({ detail: "One prompt every 5s." }), {
                  status: 429,
                  headers: { "Content-Type": "application/json", "Retry-After": "1" },
              })
            : json(post);
    });
    const drawn = await randomPrompt({ include: [] }, "k");
    assert.equal(drawn.id, 42);
    assert.equal(calls, 2);

    // but only once: a second refusal is the server meaning it
    calls = 0;
    serve(() => {
        calls++;
        return new Response(JSON.stringify({ detail: "Banned for 5 minutes." }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "1" },
        });
    });
    await assert.rejects(randomPrompt({ include: [] }, "k"), /Banned/);
    assert.equal(calls, 2);
});
