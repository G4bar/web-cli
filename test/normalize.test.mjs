// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXA, TF_FETCH, TF_SEARCH, callsTo, exaFetchOk, exaSearchOk, reply, run, tfFetchOk, tfSearchPage } from "./helpers.mjs";

describe("Exa normalization", () => {
  it("search: cleans titles, trims dates to the day, joins highlights, reports cost", async () => {
    const r = await run(["search", "node test runner", "--json"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), {
      query: "node test runner",
      provider: "exa",
      cost: 0.007,
      results: [
        { title: "Node Test Runner", url: "https://nodejs.org/api/test.html", date: "2025-03-04", text: "first hit … second hit" },
        { title: "", url: "https://example.org/a", text: "" },
      ],
    });
  });

  it("search: request body carries the filters", async () => {
    const r = await run(
      ["search", "q", "-n", "3", "--site", "a.com, b.org", "--exclude", "x.com", "--since", "2025-01-02", "--until", "2025-02-03", "--cat", "papers", "--chars", "300"],
      { "POST https://api.exa.ai/search": exaSearchOk },
    );
    assert.equal(r.code, 0);
    assert.deepEqual(callsTo(r, EXA)[0].body, {
      query: "q",
      type: "auto",
      numResults: 3,
      includeDomains: ["a.com", "b.org"],
      excludeDomains: ["x.com"],
      startPublishedDate: "2025-01-02T00:00:00.000Z",
      endPublishedDate: "2025-02-03T23:59:59.999Z",
      category: "publication",
      contents: { highlights: { maxCharacters: 300 } },
    });
  });

  it("search: --recent becomes startPublishedDate relative to now", async () => {
    const r = await run(["search", "q", "--recent", "2d"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(callsTo(r, EXA)[0].body.startPublishedDate, "2026-01-13T12:00:00.000Z");
  });

  it("search: sends the API key header", async () => {
    const r = await run(["search", "q"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(callsTo(r, EXA)[0].headers["x-api-key"], "exa-key");
  });

  it("fetch: maps results by requested URL even when the provider reports it as id", async () => {
    const u = "https://a.example/page";
    const r = await run(["fetch", u, "--json"], {
      "POST https://api.exa.ai/contents": () =>
        reply(200, { results: [{ id: u, url: "https://a.example/page?canonical=1", title: " Page  ", text: "body" }], statuses: [{ id: u, status: "success" }] }),
    });
    const j = JSON.parse(r.out);
    assert.equal(j.pages[0].url, u);
    assert.equal(j.pages[0].title, "Page");
    assert.equal(j.pages[0].provider, "exa");
  });

  it("fetch --focus asks Exa for highlights instead of text", async () => {
    const u = "https://a.example/";
    const r = await run(["fetch", u, "--focus", "pricing", "--max", "500"], {
      "POST https://api.exa.ai/contents": () => reply(200, { results: [{ id: u, url: u, title: "P", highlights: ["one", "two"] }], statuses: [{ id: u, status: "success" }] }),
    });
    assert.deepEqual(callsTo(r, EXA)[0].body, { urls: [u], highlights: { query: "pricing", maxCharacters: 500 } });
    assert.match(r.out, /one\n\n…\n\ntwo/);
  });

  it("fetch: truncation is reported in the header", async () => {
    const u = "https://a.example/";
    const r = await run(["fetch", u, "--max", "200"], {
      "POST https://api.exa.ai/contents": () => reply(200, { results: [{ id: u, url: u, title: "P", text: "x".repeat(200) }], statuses: [{ id: u, status: "success" }] }),
    });
    assert.match(r.out, /\[exa, 200\+ chars, truncated to 200 — use --max N or --focus "..."\]/);
  });

  it("answer: text answer with citations", async () => {
    const r = await run(["answer", "capital of france"], {
      "POST https://api.exa.ai/answer": () =>
        reply(200, {
          answer: " Paris. ",
          citations: [{ title: " France ", url: "https://en.wikipedia.org/wiki/France", publishedDate: "2024-01-02T00:00:00.000Z" }],
          costDollars: { total: 0.005 },
        }),
    });
    assert.equal(r.out, "# capital of france — exa, $0.005\n\nParis.\n\nSources:\n1. France\n   https://en.wikipedia.org/wiki/France  (2024-01-02)");
    assert.deepEqual(callsTo(r, EXA)[0].body, { query: "capital of france", text: false });
  });
});

describe("TinyFish normalization", () => {
  it("search: title, snippet and the free-text date pass through", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "--json"], {
      [`GET ${TF_SEARCH}`]: () =>
        reply(200, { results: [{ title: " A  b ", url: "https://tf.example/1", snippet: "snip\n one", date: "9 hours ago", site_name: "tf.example" }] }),
    });
    assert.deepEqual(JSON.parse(r.out), {
      query: "q",
      provider: "tinyfish",
      results: [{ title: "A b", url: "https://tf.example/1", date: "9 hours ago", text: "snip one" }],
    });
  });

  it("search: filters map to TinyFish parameters", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "--site", "a.com,b.org", "--exclude", "x.com", "--cat", "news", "--since", "2025-01-02", "--until", "2025-02-03"], {
      [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]),
    });
    const p = callsTo(r, TF_SEARCH)[0].u.searchParams;
    assert.equal(p.get("query"), "q");
    assert.equal(p.get("include_domains"), "a.com,b.org");
    assert.equal(p.get("exclude_domains"), "x.com");
    assert.equal(p.get("domain_type"), "news");
    assert.equal(p.get("after_date"), "2025-01-02");
    assert.equal(p.get("before_date"), "2025-02-03");
    assert.equal(p.get("recency_minutes"), null);
    assert.equal(callsTo(r, TF_SEARCH)[0].headers["X-API-Key"], "tf-key");
  });

  it("search: --recent becomes recency_minutes", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "--recent", "2d"], { [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]) });
    assert.equal(callsTo(r, TF_SEARCH)[0].u.searchParams.get("recency_minutes"), "2880");
  });

  it("fetch: matches results to requested URLs through final_url, skips empty text", async () => {
    const a = "https://a.example/";
    const b = "https://b.example/";
    const c = "https://c.example/";
    const r = await run(["fetch", a, b, c, "--json", "-p", "tinyfish"], {
      [`POST ${TF_FETCH}`]: () =>
        reply(200, {
          results: [
            { url: "https://redirect.example/", final_url: a, title: "A", text: "alpha" },
            { url: b, final_url: b, title: null, text: null },
            { url: c, final_url: c, title: "C", text: "gamma" },
          ],
          errors: [],
        }),
    });
    const j = JSON.parse(r.out);
    assert.deepEqual(j.pages.map((/** @type {any} */ p) => [p.url, p.title, p.provider]), [[a, "A", "tinyfish"], [c, "C", "tinyfish"]]);
    assert.deepEqual(j.failed, [b]);
    assert.equal(r.code, 3);
  });

  it("fetch: --focus filters passages locally", async () => {
    const u = "https://a.example/";
    const text = "intro about nothing\n\npricing starts at ten dollars\n\nfooter junk";
    const r = await run(["fetch", u, "-p", "tinyfish", "--focus", "pricing", "--max", "300"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([u], { text }) });
    assert.match(r.out, /pricing starts at ten dollars/);
    assert.doesNotMatch(r.out, /footer junk/);
    assert.equal(callsTo(r, TF_FETCH)[0].body.highlights, undefined); // beta API, 403 on some accounts
  });
});

describe("output formats", () => {
  it("search text output", async () => {
    const r = await run(["search", "node test runner", "-n", "5"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(
      r.out,
      [
        "# node test runner — exa, 2 results, $0.007",
        "",
        "1. Node Test Runner",
        "   https://nodejs.org/api/test.html  (2025-03-04)",
        "   first hit … second hit",
        "",
        "2. (untitled)",
        "   https://example.org/a",
      ].join("\n"),
    );
  });

  it("singular 'result'", async () => {
    const r = await run(["search", "q"], { "POST https://api.exa.ai/search": () => reply(200, { results: [{ title: "T", url: "https://x.example/" }] }) });
    assert.match(r.out, /^# q — exa, 1 result\n/);
  });

  it("fetch text output", async () => {
    const u = "https://a.example/";
    const r = await run(["fetch", u], { "POST https://api.exa.ai/contents": () => exaFetchOk([u]) });
    assert.equal(r.out, `## ${u} — Exa ${u}  [exa, ${`exa text of ${u}`.length} chars]\n\nexa text of ${u}\n`);
  });
});
