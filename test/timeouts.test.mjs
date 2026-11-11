// @ts-check
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { perUrlTimeout } from "../skills/web/lib/providers/tinyfish.mjs";
import { KEYS, TF_FETCH, TF_SEARCH, callsTo, exaFetchOk, exaSearchOk, hang, reply, run, tfFetchOk, tfSearchPage, urls } from "./helpers.mjs";

/** Record the timeout every request is armed with (AbortSignal.timeout(ms)). */
/** @type {number[]} */
let armed = [];
const original = AbortSignal.timeout;
beforeEach(() => {
  armed = [];
  AbortSignal.timeout = (ms) => {
    armed.push(ms);
    return original.call(AbortSignal, ms);
  };
});
afterEach(() => {
  AbortSignal.timeout = original;
});

const env = (/** @type {string | undefined} */ ms) => ({ ...KEYS, ...(ms ? { WEB_TIMEOUT_MS: ms } : {}) });
const A = "https://a.example/";

describe("per-command default timeouts (WEB_TIMEOUT_MS unset)", () => {
  it("search: 30 s", async () => {
    await run(["search", "q"], { "POST https://api.exa.ai/search": exaSearchOk }, { env: env(undefined) });
    assert.deepEqual(armed, [30_000]);
  });
  it("answer: 30 s", async () => {
    await run(["answer", "q"], { "POST https://api.exa.ai/answer": () => reply(200, { answer: "a", citations: [] }) }, { env: env(undefined) });
    assert.deepEqual(armed, [30_000]);
  });
  it("fetch: 60 s on Exa", async () => {
    await run(["fetch", A], { "POST https://api.exa.ai/contents": () => exaFetchOk([A]) }, { env: env(undefined) });
    assert.deepEqual(armed, [60_000]);
  });
  it("fetch: 90 s on TinyFish", async () => {
    await run(["fetch", A, "-p", "tinyfish"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A]) }, { env: env(undefined) });
    assert.deepEqual(armed, [90_000]);
  });
});

describe("WEB_TIMEOUT_MS applies to every command", () => {
  it("search (Exa and TinyFish)", async () => {
    await run(["search", "q"], { "POST https://api.exa.ai/search": () => reply(503, {}), [`GET ${TF_SEARCH}`]: () => tfSearchPage(urls(10)) }, { env: env("1234") });
    assert.deepEqual(armed, [1234, 1234]);
  });
  it("fetch on Exa, no longer a hard-coded 60 s", async () => {
    await run(["fetch", A], { "POST https://api.exa.ai/contents": () => exaFetchOk([A]) }, { env: env("1500") });
    assert.deepEqual(armed, [1500]);
  });
  it("fetch on TinyFish, no longer a hard-coded 90 s", async () => {
    await run(["fetch", A, "-p", "tinyfish"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A]) }, { env: env("2500") });
    assert.deepEqual(armed, [2500]);
  });
  it("answer", async () => {
    await run(["answer", "q"], { "POST https://api.exa.ai/answer": () => reply(200, { answer: "a", citations: [] }) }, { env: env("999") });
    assert.deepEqual(armed, [999]);
  });
  it("an expired timeout is reported as such", async () => {
    const r = await run(
      ["fetch", A, "-p", "exa"],
      { "POST https://api.exa.ai/contents": hang },
      { env: env("15") },
    );
    assert.equal(r.code, 1);
    assert.match(r.err, /exa failed: timeout after 15ms/);
  });
});

describe("TinyFish per_url_timeout_ms stays below the client timeout", () => {
  it("default 90 s client timeout", async () => {
    const r = await run(["fetch", A, "-p", "tinyfish"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A]) }, { env: env(undefined) });
    const per = callsTo(r, TF_FETCH)[0].body.per_url_timeout_ms;
    assert.equal(per, 76_500);
    assert.ok(per < 90_000);
  });
  it("WEB_TIMEOUT_MS=10000", async () => {
    const r = await run(["fetch", A, "-p", "tinyfish"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A]) }, { env: env("10000") });
    assert.equal(callsTo(r, TF_FETCH)[0].body.per_url_timeout_ms, 8500);
  });
  it("capped at the API maximum of 110 s", async () => {
    const r = await run(["fetch", A, "-p", "tinyfish"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A]) }, { env: env("300000") });
    assert.equal(callsTo(r, TF_FETCH)[0].body.per_url_timeout_ms, 110_000);
  });
  it("perUrlTimeout bounds", () => {
    assert.equal(perUrlTimeout(1), 1);
    assert.equal(perUrlTimeout(1000), 850);
    assert.equal(perUrlTimeout(10_000_000), 110_000);
  });
});
