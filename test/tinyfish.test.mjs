// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paperYears } from "../skills/web/lib/providers/tinyfish.mjs";
import { T0, TF_SEARCH, callsTo, reply, run, tfSearchPage, urls } from "./helpers.mjs";

const pageOf = (/** @type {import("./helpers.mjs").Call} */ c) => Number(c.u.searchParams.get("page") ?? 0);

describe("TinyFish search pagination", () => {
  it("one page when it already has -n results", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "8", "--json"], { [`GET ${TF_SEARCH}`]: (c) => tfSearchPage(urls(10, pageOf(c) * 10), pageOf(c)) });
    assert.equal(callsTo(r, TF_SEARCH).length, 1);
    assert.equal(JSON.parse(r.out).results.length, 8);
    assert.equal(callsTo(r, TF_SEARCH)[0].u.searchParams.get("page"), null);
  });

  it("walks pages until -n results (25 -> 3 pages), sequentially, in order", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "25", "--json"], { [`GET ${TF_SEARCH}`]: (c) => tfSearchPage(urls(10, pageOf(c) * 10), pageOf(c)) });
    assert.deepEqual(callsTo(r, TF_SEARCH).map(pageOf), [0, 1, 2]);
    const res = JSON.parse(r.out).results;
    assert.equal(res.length, 25);
    assert.equal(res[0].url, "https://r.example/0");
    assert.equal(res[24].url, "https://r.example/24");
  });

  it("a short first page is not the end (TinyFish may return 9)", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "15", "--json"], {
      [`GET ${TF_SEARCH}`]: (c) => (pageOf(c) === 0 ? tfSearchPage(urls(9)) : tfSearchPage(urls(10, 9), 1)),
    });
    assert.equal(JSON.parse(r.out).results.length, 15);
    assert.equal(callsTo(r, TF_SEARCH).length, 2);
  });

  it("stops on an empty page", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "30", "--json"], {
      [`GET ${TF_SEARCH}`]: (c) => (pageOf(c) === 0 ? tfSearchPage(urls(10)) : tfSearchPage([], pageOf(c))),
    });
    assert.equal(JSON.parse(r.out).results.length, 10);
    assert.equal(callsTo(r, TF_SEARCH).length, 2);
  });

  it("dedupes by URL across pages (ignoring fragments and trailing slashes) and stops when a page adds nothing", async () => {
    const dup = ["https://r.example/0", "https://r.example/1/", "https://r.example/2#top"];
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "20", "--json"], {
      [`GET ${TF_SEARCH}`]: (c) => (pageOf(c) === 0 ? tfSearchPage(["https://r.example/0", "https://r.example/1", "https://r.example/2"]) : tfSearchPage(dup, pageOf(c))),
    });
    assert.deepEqual(JSON.parse(r.out).results.map((/** @type {any} */ x) => x.url), ["https://r.example/0", "https://r.example/1", "https://r.example/2"]);
    assert.equal(callsTo(r, TF_SEARCH).length, 2);
  });

  it("request count stays bounded even if pages keep returning duplicates-free singles", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "50", "--json"], { [`GET ${TF_SEARCH}`]: (c) => tfSearchPage(urls(1, pageOf(c)), pageOf(c)) });
    assert.ok(callsTo(r, TF_SEARCH).length <= 7, `${callsTo(r, TF_SEARCH).length} requests`); // ceil(50/10)+2
  });

  it("a failing later page returns what was collected, with a warning", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "20", "--json"], {
      [`GET ${TF_SEARCH}`]: (c) => (pageOf(c) === 0 ? tfSearchPage(urls(10)) : reply(500, { error: "boom" })),
    });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).results.length, 10);
    assert.match(r.err, /tinyfish: page 1 failed \(HTTP 500: boom\), returning 10 result\(s\)/);
  });

  it("a rate limit on a later page is retried once after Retry-After", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "-n", "20", "--json"], {
      [`GET ${TF_SEARCH}`]: (c, n) => {
        if (pageOf(c) === 0) return tfSearchPage(urls(10));
        return n === 2 ? reply(429, { error: "slow down" }, { "retry-after": "3" }) : tfSearchPage(urls(10, 10), 1);
      },
    });
    assert.equal(JSON.parse(r.out).results.length, 20);
    assert.deepEqual(r.sleeps, [3000]);
  });

  it("an error on the first page is a provider failure (fallback / exit 1)", async () => {
    const r = await run(["search", "q", "-p", "tinyfish"], { [`GET ${TF_SEARCH}`]: () => reply(429, { error: "rate" }) });
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, TF_SEARCH).length, 1);
  });
});

describe("TinyFish --cat papers: years instead of dates", () => {
  const search = (/** @type {string[]} */ extra) => run(["search", "q", "-p", "tinyfish", "--cat", "papers", ...extra], { [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/p"]) });

  it("--since/--until map to pub_year_min/max, never to date filters", async () => {
    const r = await search(["--since", "2020-03-01", "--until", "2022-06-30"]);
    const p = callsTo(r, TF_SEARCH)[0].u.searchParams;
    assert.equal(p.get("domain_type"), "research_paper");
    assert.equal(p.get("pub_year_min"), "2020");
    assert.equal(p.get("pub_year_max"), "2022");
    for (const k of ["after_date", "before_date", "recency_minutes"]) assert.equal(p.get(k), null, k);
    assert.match(r.err, /apply to papers by publication year only/);
  });

  it("--recent maps to a minimum year", async () => {
    const r = await search(["--recent", "52w"]); // T0 = 2026-01-15, 364 days back = 2025
    const p = callsTo(r, TF_SEARCH)[0].u.searchParams;
    assert.equal(p.get("pub_year_min"), "2025");
    assert.equal(p.get("pub_year_max"), null);
    assert.equal(p.get("recency_minutes"), null);
  });

  it("no dates, no year parameters, no warning", async () => {
    const r = await search([]);
    const p = callsTo(r, TF_SEARCH)[0].u.searchParams;
    assert.equal(p.get("pub_year_min"), null);
    assert.doesNotMatch(r.err, /publication year/);
  });

  it("paperYears", () => {
    // @ts-expect-error partial Opts is enough for this unit test
    assert.deepEqual(paperYears({ since: "2019-12-31" }, T0), { min: 2019 });
    // @ts-expect-error partial Opts
    assert.deepEqual(paperYears({ until: "2021-01-01" }, T0), { max: 2021 });
    // @ts-expect-error partial Opts
    assert.deepEqual(paperYears({ recentMin: 60 * 24 * 365 * 3 }, T0), { min: 2023 });
    // @ts-expect-error partial Opts
    assert.deepEqual(paperYears({}, T0), {});
  });
});

describe("ignored flags are reported when TinyFish serves the request", () => {
  const tf = (/** @type {string[]} */ extra) => run(["search", "q", "-p", "tinyfish", ...extra], { [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]) });

  it("--type, --chars and Exa-only categories", async () => {
    const r = await tf(["--type", "deep", "--chars", "200", "--cat", "financial"]);
    assert.match(r.err, /tinyfish: --type has no effect \(Exa only\)/);
    assert.match(r.err, /tinyfish: --chars has no effect \(Exa only\)/);
    assert.match(r.err, /tinyfish: --cat financial not supported, searching the plain web/);
  });

  for (const cat of ["company", "people", "personal", "financial"]) {
    it(`--cat ${cat}`, async () => {
      assert.match((await tf(["--cat", cat])).err, new RegExp(`--cat ${cat} not supported`));
    });
  }

  it("flags left at their defaults are not reported", async () => {
    assert.doesNotMatch((await tf([])).err, /has no effect/);
  });

  it("the warnings appear on fallback, not when Exa answers", async () => {
    const viaFallback = await run(["search", "q", "--type", "lite"], {
      "POST https://api.exa.ai/search": () => reply(503, { error: "x" }),
      [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]),
    });
    assert.match(viaFallback.err, /tinyfish: --type has no effect/);
    const viaExa = await run(["search", "q", "--type", "lite"], { "POST https://api.exa.ai/search": () => reply(200, { results: [{ title: "T", url: "https://x.example/" }] }) });
    assert.doesNotMatch(viaExa.err, /has no effect/);
  });
});
