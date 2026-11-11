// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCli } from "../skills/web/lib/args.mjs";
import { UsageError } from "../skills/web/lib/errors.mjs";
import { KEYS, run, reply, exaSearchOk, tfSearchPage, TF_SEARCH, EXA, callsTo } from "./helpers.mjs";

/** Assert that argv is rejected with a message matching `re`. */
const bad = (/** @type {string[]} */ argv, /** @type {RegExp} */ re) => assert.throws(() => parseCli(argv), (e) => e instanceof UsageError && re.test(e.message));

describe("argument validation (no network)", () => {
  it("--type must be a documented value", () => {
    bad(["search", "x", "--type", "banana"], /bad --type "banana" \(auto \| lite \| deep-lite \| deep\)/);
    for (const t of ["auto", "lite", "deep-lite", "deep", "fast", "instant", "deep-reasoning"]) {
      assert.equal(parseCli(["search", "x", "--type", t]).opts.type, t);
    }
  });

  it("Exa category constraints are rejected locally", async () => {
    for (const cat of ["company", "people"]) {
      for (const f of [["--recent", "30d"], ["--since", "2025-01-01"], ["--until", "2025-01-01"]]) {
        const r = await run(["search", "x", "--cat", cat, ...f]); // no handlers: any request would fail the test
        assert.equal(r.code, 2, `${cat} ${f[0]}`);
        assert.equal(r.calls.length, 0);
        assert.match(r.err, new RegExp(`--cat ${cat} cannot be combined with --recent/--since/--until`));
      }
    }
    const r = await run(["search", "x", "--cat", "people", "--exclude", "a.com"]);
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.err, /--cat people cannot be combined with --exclude/);
  });

  it("allowed category combinations still work", async () => {
    // company/people without dates; company with --exclude; other categories with dates
    for (const argv of [["--cat", "company"], ["--cat", "company", "--exclude", "a.com"], ["--cat", "people", "--site", "linkedin.com"], ["--cat", "news", "--recent", "7d"]]) {
      const r = await run(["search", "x", ...argv], { "POST https://api.exa.ai/search": exaSearchOk });
      assert.equal(r.code, 0, argv.join(" "));
    }
  });

  it("the Exa constraint does not block a forced TinyFish search", async () => {
    const r = await run(["search", "x", "--cat", "company", "--recent", "30d", "-p", "tinyfish"], { [`GET ${TF_SEARCH}`]: () => tfSearchPage(["https://tf.example/1"]) });
    assert.equal(r.code, 0);
    assert.match(r.err, /tinyfish: --cat company not supported, searching the plain web/);
  });

  it("dates: real calendar dates only, since <= until", () => {
    bad(["search", "x", "--since", "2025-13-01"], /bad --since/);
    bad(["search", "x", "--until", "2025-02-30"], /bad --until/);
    bad(["search", "x", "--since", "25-01-01"], /bad --since/);
    bad(["search", "x", "--since", "2025-03-01", "--until", "2025-02-01"], /after --until/);
    assert.equal(parseCli(["search", "x", "--since", "2024-02-29"]).opts.since, "2024-02-29");
  });

  it("--recent: format and conflicts", () => {
    bad(["search", "x", "--recent", "7"], /bad --recent/);
    bad(["search", "x", "--recent", "0d"], /bad --recent/);
    bad(["search", "x", "--recent", "7d", "--since", "2025-01-01"], /--recent cannot be combined/);
    assert.equal(parseCli(["search", "x", "--recent", "2w"]).opts.recentMin, 20160);
  });

  it("numeric ranges", () => {
    bad(["search", "x", "-n", "0"], /bad -n/);
    bad(["search", "x", "-n", "51"], /bad -n/);
    bad(["search", "x", "-n", "abc"], /bad -n/);
    bad(["search", "x", "--chars", "99"], /bad --chars/);
    bad(["fetch", "http://a.example", "--max", "100"], /bad --max/);
    assert.equal(parseCli(["search", "x"]).opts.n, 8);
  });

  it("--cat must be known", () => bad(["search", "x", "--cat", "bogus"], /bad --cat "bogus"/));

  it("unknown flags show usage", () => bad(["search", "x", "--nope"], /Unknown option '--nope'[\s\S]*USAGE/));
});

describe("exit codes and messages", () => {
  it("no arguments: help on stdout, exit 2; --help: exit 0", async () => {
    const none = await run([]);
    assert.equal(none.code, 2);
    assert.match(none.out, /USAGE/);
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /web search <query>/);
    assert.equal((await run(["search", "--help"])).code, 0);
  });

  it("missing query / URL", async () => {
    assert.equal((await run(["search"])).code, 2);
    assert.match((await run(["answer"])).err, /usage: web answer <question>/);
    assert.match((await run(["fetch"])).err, /usage: web fetch <url...>/);
  });

  it("unknown command", async () => {
    const r = await run(["frobnicate"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown command "frobnicate"/);
  });

  it("fetch: URL checks", async () => {
    assert.match((await run(["fetch", "ftp://x.example/"])).err, /not an http\(s\) URL: ftp:\/\/x\.example\//);
    assert.match((await run(["fetch", "https://"])).err, /not an http\(s\) URL/);
    const many = Array.from({ length: 11 }, (_, i) => `https://x.example/${i}`);
    const r = await run(["fetch", ...many]);
    assert.equal(r.code, 2);
    assert.match(r.err, /max 10 URLs per call/);
  });

  it("flags that do nothing for a command are reported", async () => {
    const r = await run(["fetch", "https://a.example/", "--site", "x.com"], { "POST https://api.exa.ai/contents": () => reply(200, { results: [{ id: "https://a.example/", url: "https://a.example/", text: "t" }], statuses: [] }) });
    assert.match(r.err, /--site has no effect on "web fetch"/);
    assert.equal(r.code, 0);
  });

  it("WEB_TIMEOUT_MS that is not a number is reported and ignored", async () => {
    const r = await run(["search", "q"], { "POST https://api.exa.ai/search": exaSearchOk }, { env: { ...KEYS, WEB_TIMEOUT_MS: "soon" } });
    assert.equal(r.code, 0);
    assert.match(r.err, /ignoring WEB_TIMEOUT_MS="soon"/);
    assert.equal(callsTo(r, EXA).length, 1);
  });
});
