// @ts-check
// Phase 2: --goal, --country/--lang, fetch --fresh/--links, answer --deep/--fast/--schema.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanLinks } from "../skills/web/lib/util.mjs";
import { checkExaSearchSchema, loadSchema } from "../skills/web/lib/schema.mjs";
import { EXA, TF_FETCH, TF_SEARCH, callsTo, exaFetchOk, exaSearchOk, reply, run, tfFetchOk, tfSearchPage } from "./helpers.mjs";

const A = "https://a.example/";

describe("--goal", () => {
  it("search: Exa objective, TinyFish purpose", async () => {
    const exa = await run(["search", "q", "--goal", "find the changelog, not blog posts"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(callsTo(exa, EXA)[0].body.objective, "find the changelog, not blog posts");
    const tf = await run(["search", "q", "-p", "tinyfish", "--goal", "find the changelog"], { [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]) });
    assert.equal(callsTo(tf, TF_SEARCH)[0].u.searchParams.get("purpose"), "find the changelog");
  });

  it("fetch: TinyFish purpose; Exa has no equivalent and says so", async () => {
    const tf = await run(["fetch", A, "-p", "tinyfish", "--goal", "compare pricing"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A]) });
    assert.equal(callsTo(tf, TF_FETCH)[0].body.purpose, "compare pricing");
    const exa = await run(["fetch", A, "--goal", "compare pricing"], { "POST https://api.exa.ai/contents": () => exaFetchOk([A]) });
    assert.match(exa.err, /exa: --goal has no effect/);
    assert.equal(callsTo(exa, EXA)[0].body.purpose, undefined);
    assert.equal(callsTo(exa, EXA)[0].body.objective, undefined);
  });

  it("is limited to 2000 characters and cannot be empty", async () => {
    assert.equal((await run(["search", "q", "--goal", "x".repeat(2001)])).code, 2);
    assert.equal((await run(["search", "q", "--goal", "  "])).code, 2);
  });
});

describe("--country / --lang", () => {
  it("Exa: userLocation; --lang is reported as ignored", async () => {
    const r = await run(["search", "q", "--country", "fr", "--lang", "fr"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(callsTo(r, EXA)[0].body.userLocation, "FR");
    assert.match(r.err, /exa: --lang has no effect \(Exa has no language filter\)/);
  });

  it("TinyFish: location and language", async () => {
    const r = await run(["search", "q", "-p", "tinyfish", "--country", "de", "--lang", "DE"], { [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]) });
    const p = callsTo(r, TF_SEARCH)[0].u.searchParams;
    assert.equal(p.get("location"), "DE");
    assert.equal(p.get("language"), "de");
    assert.doesNotMatch(r.err, /has no effect/);
  });

  it("validates the codes", async () => {
    assert.equal((await run(["search", "q", "--country", "USA"])).code, 2);
    assert.equal((await run(["search", "q", "--lang", "english"])).code, 2);
  });

  it("answer: Exa /answer and --deep take userLocation", async () => {
    const a = await run(["answer", "q", "--country", "gb"], { "POST https://api.exa.ai/answer": () => reply(200, { answer: "x", citations: [] }) });
    assert.equal(callsTo(a, EXA)[0].body.userLocation, "GB");
    const d = await run(["answer", "q", "--deep", "--country", "gb"], { "POST https://api.exa.ai/search": () => reply(200, { results: [], output: { content: "x", grounding: [] } }) });
    assert.equal(callsTo(d, EXA)[0].body.userLocation, "GB");
  });
});

describe("fetch --fresh", () => {
  it("Exa: maxAgeHours 0; TinyFish: ttl 0; absent otherwise", async () => {
    const exa = await run(["fetch", A, "--fresh"], { "POST https://api.exa.ai/contents": () => exaFetchOk([A]) });
    assert.equal(callsTo(exa, EXA)[0].body.maxAgeHours, 0);
    const tf = await run(["fetch", A, "-p", "tinyfish", "--fresh"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A]) });
    assert.equal(callsTo(tf, TF_FETCH)[0].body.ttl, 0);
    const plain = await run(["fetch", A], { "POST https://api.exa.ai/contents": () => exaFetchOk([A]) });
    assert.equal("maxAgeHours" in callsTo(plain, EXA)[0].body, false);
  });
});

describe("fetch --links", () => {
  const raw = [
    "https://a.example/#top", // same page, fragment: dropped
    "#section", // pure fragment: dropped
    "https://a.example/docs",
    "https://a.example/docs/", // duplicate (trailing slash)
    "https://a.example/docs#intro", // duplicate (fragment)
    "https://other.example/x",
    "mailto:me@a.example",
    "javascript:void(0)",
    "https://other.example/y",
  ];

  it("cleanLinks: http(s) only, no pure fragments, deduped, capped, total reported", () => {
    assert.deepEqual(cleanLinks(raw, ["https://a.example"], 100), {
      links: ["https://a.example/docs", "https://other.example/x", "https://other.example/y"],
      total: 3,
    });
    assert.deepEqual(cleanLinks(raw, [A], 2), { links: ["https://a.example/docs", "https://other.example/x"], total: 3 });
  });

  it("Exa: asks for extras.links and prints the cleaned list", async () => {
    const r = await run(["fetch", A, "--links"], { "POST https://api.exa.ai/contents": () => exaFetchOk([A], { extras: { links: raw } }) });
    assert.ok(callsTo(r, EXA)[0].body.extras.links > 100);
    assert.match(r.out, /Links \(3\):\n- https:\/\/a\.example\/docs\n- https:\/\/other\.example\/x\n- https:\/\/other\.example\/y\n/);
  });

  it("TinyFish: links:true", async () => {
    const r = await run(["fetch", A, "-p", "tinyfish", "--links"], { [`POST ${TF_FETCH}`]: () => tfFetchOk([A], { links: raw }) });
    assert.equal(callsTo(r, TF_FETCH)[0].body.links, true);
    assert.match(r.out, /Links \(3\):/);
  });

  it("caps the list at 100 and says how many were left out", async () => {
    const many = Array.from({ length: 150 }, (_, i) => `https://l.example/${i}`);
    const r = await run(["fetch", A, "--links"], { "POST https://api.exa.ai/contents": () => exaFetchOk([A], { extras: { links: many } }) });
    assert.match(r.out, /Links \(150, first 100\):/);
    assert.equal(r.out.match(/^- https/gm)?.length, 100);
  });

  it("--json carries links and linksTotal", async () => {
    const r = await run(["fetch", A, "--links", "--json"], { "POST https://api.exa.ai/contents": () => exaFetchOk([A], { extras: { links: raw } }) });
    const p = JSON.parse(r.out).pages[0];
    assert.equal(p.links.length, 3);
    assert.equal(p.linksTotal, 3);
  });

  it("without --links nothing is requested or printed", async () => {
    const r = await run(["fetch", A], { "POST https://api.exa.ai/contents": () => exaFetchOk([A]) });
    assert.equal(callsTo(r, EXA)[0].body.extras, undefined);
    assert.doesNotMatch(r.out, /Links/);
  });

  it("a page with no links says so", async () => {
    const r = await run(["fetch", A, "--links"], { "POST https://api.exa.ai/contents": () => exaFetchOk([A], { extras: { links: [] } }) });
    assert.match(r.out, /Links: none returned by exa/);
  });
});

describe("answer --deep", () => {
  const deepReply = (/** @type {any} */ output) => () => reply(200, { results: [{ title: "r", url: "https://r.example/" }], costDollars: { total: 0.012 }, output });
  const grounding = [
    { field: "content", confidence: "high", citations: [{ url: "https://s.example/1", title: "One" }, { url: "https://s.example/2", title: "Two" }] },
    { field: "content", confidence: "low", citations: [{ url: "https://s.example/2", title: "Two again" }, { url: "https://s.example/3", title: "Three" }] },
  ];

  it("deep search with a text outputSchema; prints content then deduped sources", async () => {
    const r = await run(["answer", "why is the sky blue", "--deep"], { "POST https://api.exa.ai/search": deepReply({ content: " Rayleigh scattering. ", grounding }) });
    assert.equal(r.code, 0);
    const b = callsTo(r, EXA)[0].body;
    assert.equal(b.type, "deep");
    assert.deepEqual(b.outputSchema, { type: "text" });
    assert.equal(callsTo(r, "https://api.exa.ai/answer").length, 0);
    assert.equal(
      r.out,
      [
        "# why is the sky blue — exa (deep), $0.012",
        "",
        "Rayleigh scattering.",
        "",
        "Sources:",
        "1. One",
        "   https://s.example/1",
        "2. Two",
        "   https://s.example/2",
        "3. Three",
        "   https://s.example/3",
      ].join("\n"),
    );
  });

  it("--fast uses deep-lite", async () => {
    const r = await run(["answer", "q", "--deep", "--fast"], { "POST https://api.exa.ai/search": deepReply({ content: "a", grounding: [] }) });
    assert.equal(callsTo(r, EXA)[0].body.type, "deep-lite");
    assert.match(r.out, /exa \(deep-lite\)/);
  });

  it("honours search filters, which /answer cannot", async () => {
    const r = await run(["answer", "q", "--deep", "--site", "a.com", "--recent", "7d"], { "POST https://api.exa.ai/search": deepReply({ content: "a", grounding: [] }) });
    const b = callsTo(r, EXA)[0].body;
    assert.deepEqual(b.includeDomains, ["a.com"]);
    assert.ok(b.startPublishedDate);
    assert.doesNotMatch(r.err, /has no effect/);
  });

  it("without --deep, search filters are reported as ignored by /answer", async () => {
    const r = await run(["answer", "q", "--site", "a.com"], { "POST https://api.exa.ai/answer": () => reply(200, { answer: "x", citations: [] }) });
    assert.match(r.err, /exa: --site has no effect on \/answer \(add --deep to search with filters\)/);
  });

  it("--json", async () => {
    const r = await run(["answer", "q", "--deep", "--json"], { "POST https://api.exa.ai/search": deepReply({ content: "a", grounding }) });
    const j = JSON.parse(r.out);
    assert.equal(j.provider, "exa");
    assert.equal(j.mode, "deep");
    assert.equal(j.answer, "a");
    assert.equal(j.cost, 0.012);
    assert.deepEqual(j.citations.map((/** @type {any} */ c) => c.url), ["https://s.example/1", "https://s.example/2", "https://s.example/3"]);
    assert.equal(j.grounding.length, 2);
  });

  it("a response without synthesized output falls back to TinyFish", async () => {
    const r = await run(["answer", "q", "--deep"], {
      "POST https://api.exa.ai/search": () => reply(200, { results: [{ title: "r", url: "https://r.example/" }] }),
      [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]),
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa failed: no synthesized output in deep response/);
    assert.match(r.err, /tinyfish: --deep has no effect/);
    assert.match(r.out, /— tinyfish, 1 result/);
  });

  it("Exa 5xx falls back, 400 does not", async () => {
    const down = await run(["answer", "q", "--deep"], { "POST https://api.exa.ai/search": () => reply(503, {}), [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]) });
    assert.equal(down.code, 0);
    const rejected = await run(["answer", "q", "--deep"], { "POST https://api.exa.ai/search": () => reply(400, { error: "bad" }) });
    assert.equal(rejected.code, 2);
  });

  it("--cat company with dates is rejected for --deep (and only then)", async () => {
    assert.equal((await run(["answer", "q", "--deep", "--cat", "company", "--recent", "7d"])).code, 2);
  });
});

describe("--schema", () => {
  const schema = { type: "object", properties: { capital: { type: "string" }, population: { type: "number" } }, required: ["capital"] };

  it("answer: structured /answer printed as JSON", async () => {
    const r = await run(["answer", "capital of france", "--schema", JSON.stringify(schema)], {
      "POST https://api.exa.ai/answer": () => reply(200, { answer: { capital: "Paris", population: 2100000 }, citations: [{ title: "F", url: "https://f.example/" }], costDollars: { total: 0.005 } }),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(callsTo(r, EXA)[0].body.outputSchema, schema);
    assert.equal(r.out, '# capital of france — exa, $0.005\n\n{\n  "capital": "Paris",\n  "population": 2100000\n}\n\nSources:\n1. F\n   https://f.example/');
  });

  it("answer --deep: the schema replaces the text schema", async () => {
    const r = await run(["answer", "q", "--deep", "--schema", JSON.stringify(schema), "--json"], {
      "POST https://api.exa.ai/search": () => reply(200, { results: [], output: { content: { capital: "Paris" }, grounding: [{ field: "capital", confidence: "high", citations: [{ url: "https://f.example/", title: "F" }] }] } }),
    });
    assert.deepEqual(callsTo(r, EXA)[0].body.outputSchema, schema);
    assert.deepEqual(JSON.parse(r.out).answer, { capital: "Paris" });
  });

  it("reads a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-cli-schema-"));
    try {
      const f = join(dir, "s.json");
      writeFileSync(f, JSON.stringify(schema));
      assert.deepEqual(loadSchema(f), schema);
      const r = await run(["answer", "q", "--schema", f], { "POST https://api.exa.ai/answer": () => reply(200, { answer: { capital: "Paris" }, citations: [] }) });
      assert.deepEqual(callsTo(r, EXA)[0].body.outputSchema, schema);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("must be a JSON object schema", async () => {
    for (const bad of ['{"type":"string"}', '{"properties":{}}', "{not json", "/nonexistent/schema.json", "[1]"]) {
      const r = await run(["answer", "q", "--schema", bad]);
      assert.equal(r.code, 2, bad);
      assert.equal(r.calls.length, 0);
    }
    assert.match((await run(["answer", "q", "--schema", "/nonexistent/schema.json"])).err, /--schema: cannot read/);
    assert.match((await run(["answer", "q", "--schema", '{"type":"string"}'])).err, /"type": "object"/);
  });

  it("Exa's /search limits are enforced for --deep only", async () => {
    const props = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, { type: "string" }]));
    const big = JSON.stringify({ type: "object", properties: props });
    const deep = await run(["answer", "q", "--deep", "--schema", big]);
    assert.equal(deep.code, 2);
    assert.equal(deep.calls.length, 0);
    assert.match(deep.err, /more than 10 properties/);
    // /answer has no such limit (verified live with 11 properties)
    const plain = await run(["answer", "q", "--schema", big], { "POST https://api.exa.ai/answer": () => reply(200, { answer: { p0: "x" }, citations: [] }) });
    assert.equal(plain.code, 0);
  });

  it("checkExaSearchSchema: property count, nesting (arrays count) and array items", () => {
    const ok = { type: "object", properties: { companies: { type: "array", items: { type: "object", properties: { name: { type: "string" }, round: { type: "string" } } } } } };
    assert.doesNotThrow(() => checkExaSearchSchema(ok));
    assert.doesNotThrow(() => checkExaSearchSchema({ type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string" } } } } } } }));
    // verified against the live API: both are rejected with "exceeds maximum nesting depth of 2"
    const objects3 = { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } } } };
    assert.throws(() => checkExaSearchSchema(objects3), /nests deeper than 2 levels/);
    const arrayThenObject = { type: "object", properties: { arr: { type: "array", items: { type: "object", properties: { sub: { type: "object", properties: { leaf: { type: "string" } } } } } } } };
    assert.throws(() => checkExaSearchSchema(arrayThenObject), /nests deeper than 2 levels/);
    assert.throws(() => checkExaSearchSchema({ type: "object", properties: { a: { type: "array" } } }), /array without "items"/);
  });

  it("TinyFish cannot structure an answer: reported as ignored", async () => {
    const r = await run(["answer", "q", "-p", "tinyfish", "--schema", JSON.stringify(schema)], { [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]) });
    assert.equal(r.code, 0);
    assert.match(r.err, /tinyfish: --schema has no effect/);
  });

  it("is not read for commands that do not use it", async () => {
    const r = await run(["search", "q", "--schema", "/nonexistent.json"], { "POST https://api.exa.ai/search": exaSearchOk });
    assert.equal(r.code, 0);
    assert.match(r.err, /--schema has no effect on "web search"/);
  });
});
