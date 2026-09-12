import assert from "node:assert/strict";
import { test } from "node:test";
let response;
let status = 200;
const listeners = [];
globalThis.window = {
    location: { origin: "http://localhost:8092" },
    addEventListener: (_, fn) => listeners.push(fn),
    postMessage(data) {
        queueMicrotask(() => {
            const deliver = msg => listeners.forEach(fn => fn({ source: window, origin: window.location.origin, data: { tag: "prombot-nai", id: data.id, ...msg } }));
            if (data.type === "hello") deliver({ type: "ready", version: "1.3.1", stream: true });
            if (data.type === "request") {
                assert.equal(data.url, "https://image.novelai.net/user/subscription");
                assert.equal(data.headers.Authorization, "Bearer test-key");
                deliver({ type: "head", status });
                deliver({ type: "done", body: new TextEncoder().encode(JSON.stringify(response ?? {})).buffer });
            }
        });
    },
};
const { REJECTED, verifyToken } = await import("./nai.js");

const active = { tier: 3, expiresAt: Date.now() / 1000 + 3600 };
test("subscription balances and optional Opus usage", async () => {
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
test("only unauthorized checks reject the stored key", async () => {
    status = 401;
    await assert.rejects(verifyToken("test-key"), { message: REJECTED });
    status = 503;
    await assert.rejects(verifyToken("test-key"), { message: "Check failed (503)" });
});
