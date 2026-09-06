import assert from "node:assert/strict";
import { test } from "node:test";
import { REJECTED, verifyToken } from "./nai.js";

const active = { tier: 3, expiresAt: Date.now() / 1000 + 3600 };
test("subscription balances and optional Opus usage", async (t) => {
    let response;
    t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(url, "/api/subscription");
        assert.equal(init.headers.Authorization, "Bearer test-key");
        assert.equal(init.cache, "no-store");
        return Response.json(response);
    });
    for (const [extra, expected] of [
        [{ usage: { percent: 73, isNegative: false } }, 73],
        [{ usage: { percent: 125 } }, 125],
        [{ usage: { percent: 0 } }, 0],
        [{ usage: { percent: 8, isNegative: true } }, 0],
        [{ usage: { percent: -2 } }, 0],
        [{}, null],
        [{ usage: {} }, null],
        [{ usage: { percent: "73" } }, null],
        [{ tier: 2, usage: { percent: 73 } }, null],
        [{ expiresAt: 1, usage: { percent: 73 } }, null],
    ]) {
        response = { ...active, trainingStepsLeft: { fixedTrainingStepsLeft: 2000, purchasedTrainingSteps: 500 }, ...extra };
        assert.deepEqual(await verifyToken("test-key"), { anlas: 2500, opus: expected });
    }
});
test("only unauthorized checks reject the stored key", async (t) => {
    let status = 401;
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
    await assert.rejects(verifyToken("test-key"), { message: REJECTED });
    status = 503;
    await assert.rejects(verifyToken("test-key"), { message: "Check failed (503)" });
});
