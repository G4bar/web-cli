// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXA, KEYS, TF_FETCH, TF_SEARCH, callsTo, exaFetchOk, exaSearchOk, hang, reply, run, tfFetchOk, tfSearchPage } from "./helpers.mjs";

const tfOk = () => tfSearchPage(["https://tf.example/1", "https://tf.example/2"]);

describe("search fallback policy", () => {
  // Statuses that mean "this provider cannot serve you right now": the next one is tried.
  for (const status of [401, 402, 403, 404, 408, 429, 500, 502, 503, 504]) {
    it(`Exa HTTP ${status} falls back to TinyFish`, async () => {
      const r = await run(["search", "q"], {
        "POST https://api.exa.ai/search": () => reply(status, { error: "nope" }),
        [`GET ${TF_SEARCH}`]: tfOk,
      });
      assert.equal(r.code, 0);
      assert.match(r.out, /— tinyfish, 2 results/);
      assert.match(r.err, new RegExp(`exa failed: HTTP ${status}`));
    });
  }

  // Caller errors: retrying on another provider would hide the mistake.
  for (const status of [400, 422]) {
    it(`Exa HTTP ${status} is a caller error: no fallback, exit 2, provider message shown`, async () => {
      const r = await run(["search", "q"], {
        "POST https://api.exa.ai/search": () => reply(status, { error: "Invalid request body | bad thing" }),
      });
      assert.equal(r.code, 2);
      assert.equal(callsTo(r, TF_SEARCH).length, 0);
      assert.match(r.err, /exa rejected the request: HTTP \d+: Invalid request body \| bad thing/);
      assert.equal(r.out, "");
    });
  }

  it("a 400 from the fallback provider also exits 2", async () => {
    const r = await run(["search", "q"], {
      "POST https://api.exa.ai/search": () => reply(503, { error: "down" }),
      [`GET ${TF_SEARCH}`]: () => reply(400, { error: { code: "INVALID_INPUT", message: "bad query" } }),
    });
    assert.equal(r.code, 2);
    assert.match(r.err, /tinyfish rejected the request: HTTP 400: bad query/);
  });

  it("timeout falls back", async () => {
    const r = await run(
      ["search", "q"],
      {
        "POST https://api.exa.ai/search": hang,
        [`GET ${TF_SEARCH}`]: tfOk,
      },
      { env: { ...KEYS, WEB_TIMEOUT_MS: "20" } },
    );
    assert.equal(r.code, 0);
    assert.match(r.err, /exa failed: timeout after 20ms/);
    assert.match(r.out, /tinyfish/);
  });

  it("network error falls back", async () => {
    const r = await run(["search", "q"], {
      "POST https://api.exa.ai/search": () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      },
      [`GET ${TF_SEARCH}`]: tfOk,
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa failed: network: ECONNRESET/);
  });

  it("invalid JSON falls back", async () => {
    const r = await run(["search", "q"], {
      "POST https://api.exa.ai/search": () => reply(200, "<html>not json</html>"),
      [`GET ${TF_SEARCH}`]: tfOk,
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa failed: invalid JSON response/);
  });

  it("a missing key skips the provider", async () => {
    const r = await run(["search", "q"], { [`GET ${TF_SEARCH}`]: tfOk }, { env: { TINYFISH_API_KEY: "t" } });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa: skipped \(EXA_API_KEY not set\)/);
    assert.match(r.out, /tinyfish/);
  });

  it("an empty Exa result falls back to TinyFish", async () => {
    const r = await run(["search", "q"], {
      "POST https://api.exa.ai/search": () => reply(200, { results: [] }),
      [`GET ${TF_SEARCH}`]: tfOk,
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa: 0 results/);
    assert.match(r.out, /— tinyfish, 2 results/);
  });

  it("when every provider is empty the (empty) result is still reported, exit 0", async () => {
    const r = await run(["search", "q"], {
      "POST https://api.exa.ai/search": () => reply(200, { results: [] }),
      [`GET ${TF_SEARCH}`]: () => tfSearchPage([]),
    });
    assert.equal(r.code, 0);
    assert.equal(r.out, "# q — exa, 0 results");
  });

  it("all providers failing exits 1 and lists every error", async () => {
    const r = await run(["search", "q"], {
      "POST https://api.exa.ai/search": () => reply(503, { error: "a" }),
      [`GET ${TF_SEARCH}`]: () => reply(500, { error: "b" }),
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /all providers failed\n {2}exa: HTTP 503: a\n {2}tinyfish: HTTP 500: b/);
  });

  it("-p forces one provider and never falls back", async () => {
    const r = await run(["search", "q", "-p", "exa"], { "POST https://api.exa.ai/search": () => reply(503, { error: "x" }) });
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, TF_SEARCH).length, 0);
  });

  it("WEB_PROVIDERS changes the order", async () => {
    const r = await run(["search", "q"], { [`GET ${TF_SEARCH}`]: tfOk }, { env: { ...KEYS, WEB_PROVIDERS: "tinyfish,exa" } });
    assert.equal(r.code, 0);
    assert.equal(callsTo(r, EXA).length, 0);
  });

  it("an unknown provider name is a usage error", async () => {
    const r = await run(["search", "q", "-p", "bing"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown provider "bing"/);
  });
});

describe("fetch fallback", () => {
  const A = "https://a.example/";
  const B = "https://b.example/";

  it("retries only the URLs Exa could not read on TinyFish", async () => {
    const r = await run(["fetch", A, B], {
      "POST https://api.exa.ai/contents": () =>
        reply(200, {
          results: [{ id: A, url: A, title: "A", text: "alpha" }],
          statuses: [
            { id: A, status: "success" },
            { id: B, status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
          ],
        }),
      [`POST ${TF_FETCH}`]: (c) => tfFetchOk(c.body.urls),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(callsTo(r, TF_FETCH)[0].body.urls, [B]);
    assert.match(r.out, /## https:\/\/a\.example\/ — A {2}\[exa, 5 chars\]/);
    assert.match(r.out, /## https:\/\/b\.example\/ — TF https:\/\/b\.example\/ {2}\[tinyfish,/);
    assert.match(r.err, /exa: https:\/\/b\.example\/: CRAWL_NOT_FOUND \(HTTP 404\)/);
  });

  it("whole-request Exa failure falls back for every URL", async () => {
    const r = await run(["fetch", A, B], {
      "POST https://api.exa.ai/contents": () => reply(503, { error: "x" }),
      [`POST ${TF_FETCH}`]: (c) => tfFetchOk(c.body.urls),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(callsTo(r, TF_FETCH)[0].body.urls, [A, B]);
  });

  it("HTTP 400 from a fetch provider is a caller error", async () => {
    const r = await run(["fetch", A], { "POST https://api.exa.ai/contents": () => reply(400, { error: "bad urls" }) });
    assert.equal(r.code, 2);
    assert.equal(callsTo(r, TF_FETCH).length, 0);
    assert.match(r.err, /exa rejected the request: HTTP 400: bad urls/);
  });

  it("exit 3 when some URLs fail everywhere, 1 when all do", async () => {
    const partial = await run(["fetch", A, B], {
      "POST https://api.exa.ai/contents": () => exaFetchOk([A]),
      [`POST ${TF_FETCH}`]: () => reply(200, { results: [], errors: [{ url: B, error: "timeout" }] }),
    });
    assert.equal(partial.code, 3);
    assert.match(partial.err, /tinyfish: https:\/\/b\.example\/: timeout/);
    assert.match(partial.err, /FAILED https:\/\/b\.example\//);
    assert.match(partial.out, /## https:\/\/a\.example\//);

    const none = await run(["fetch", A], {
      "POST https://api.exa.ai/contents": () => reply(503, {}),
      [`POST ${TF_FETCH}`]: () => reply(503, {}),
    });
    assert.equal(none.code, 1);
  });
});

describe("answer fallback", () => {
  it("Exa 5xx falls back to TinyFish search results", async () => {
    const r = await run(["answer", "q"], {
      "POST https://api.exa.ai/answer": () => reply(503, { error: "x" }),
      [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]),
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /tinyfish: no answer endpoint, returning search results instead/);
    assert.match(r.out, /# q — tinyfish, 1 result\n/);
  });

  it("HTTP 400 on /answer is a caller error", async () => {
    const r = await run(["answer", "q"], { "POST https://api.exa.ai/answer": () => reply(400, { error: "bad" }) });
    assert.equal(r.code, 2);
    assert.equal(callsTo(r, TF_SEARCH).length, 0);
  });

  it("an empty answer falls back", async () => {
    const r = await run(["answer", "q"], {
      "POST https://api.exa.ai/answer": () => reply(200, { answer: "  ", citations: [] }),
      [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]),
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa failed: empty answer/);
  });
});

describe("sanity: Exa is used when healthy", () => {
  it("search goes to Exa only", async () => {
    const r = await run(["search", "q"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(r.code, 0);
    assert.equal(callsTo(r, TF_SEARCH).length, 0);
  });
});
