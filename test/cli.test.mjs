// @ts-check
// End-to-end through the real binary: process exit codes, stdout/stderr, symlinked bin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const BIN = resolve(import.meta.dirname, "../skills/web/web.mjs");

/** Run the binary with a scrubbed environment (no keys: no request can succeed). */
function web(/** @type {string[]} */ args, /** @type {string} */ bin = BIN) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("web binary", () => {
  it("--help exits 0 and documents every command", () => {
    const r = web(["--help"]);
    assert.equal(r.code, 0);
    for (const s of ["web search", "web fetch", "web answer"]) assert.ok(r.out.includes(s), s);
  });

  it("no arguments: help and exit 2", () => {
    const r = web([]);
    assert.equal(r.code, 2);
    assert.match(r.out, /USAGE/);
  });

  it("Phase 1 repro commands exit 2 without a network call", () => {
    for (const args of [["search", "x", "--cat", "company", "--recent", "30d"], ["search", "x", "--cat", "people", "--exclude", "a.com"], ["search", "x", "--type", "banana"]]) {
      // The environment has no keys: reaching a provider would give exit 1, not 2.
      const r = web(args);
      assert.equal(r.code, 2, args.join(" "));
      assert.equal(r.out, "");
    }
  });

  it("without any API key every provider is skipped: exit 1", () => {
    const r = web(["search", "x"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /exa: skipped \(EXA_API_KEY not set\)/);
    assert.match(r.err, /all providers failed/);
  });

  it("works through a symlink (npm bin, ~/.local/bin/web)", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-cli-test-"));
    try {
      const link = join(dir, "web");
      symlinkSync(BIN, link);
      const r = web(["--help"], link);
      assert.equal(r.code, 0);
      assert.match(r.out, /USAGE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
