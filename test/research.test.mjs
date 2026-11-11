// @ts-check
// Phase 3: `web research` (paid, asynchronous). Everything is mocked: no run is ever started for real.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLL_MAX_MS, POLL_START_MS, parseRunId, safeToFallBack } from "../skills/web/lib/commands/research.mjs";
import { ProviderError } from "../skills/web/lib/errors.mjs";
import { EXA, KEYS, TF_AGENT, callsTo, hang, reply, run } from "./helpers.mjs";

const EXA_RUNS = `${EXA}/agent/runs`;
const TF_START = `${TF_AGENT}/v1/automation/run-research-async`;
const TF_RUN = `${TF_AGENT}/v1/research-run`;
const Q = "how do the major vector databases compare";

// ---------- fixtures ----------
const exaRun = (/** @type {string} */ status, /** @type {Record<string, any>} */ extra = {}) =>
  reply(200, {
    id: "agent_run_abc",
    object: "agent_run",
    status,
    stopReason: null,
    createdAt: "2026-01-15T12:00:00Z",
    completedAt: null,
    request: null,
    error: null,
    output: { text: "", structured: null, grounding: [] },
    usage: { agentComputeUnits: 0, searches: 0, emails: 0, phoneNumbers: 0 },
    costDollars: { total: 0, agentCompute: 0, search: 0, emails: 0, phoneNumbers: 0 },
    ...extra,
  });

const exaDone = () =>
  exaRun("completed", {
    stopReason: "schema_satisfied",
    completedAt: "2026-01-15T12:01:00Z",
    output: {
      text: "Qdrant and Milvus lead on filtering; pgvector wins on simplicity.",
      structured: null,
      grounding: [
        { field: "text", confidence: "high", citations: [{ url: "https://q.example/", title: "Qdrant" }, { url: "https://m.example/", title: "Milvus" }] },
        { field: "text", confidence: "medium", citations: [{ url: "https://q.example/", title: "Qdrant again" }] },
      ],
    },
    costDollars: { total: 0.025, agentCompute: 0.02, search: 0.005, emails: 0, phoneNumbers: 0 },
  });

const tfStart = () => reply(200, { research_run_id: "11111111-2222-3333-4444-555555555555", error: null });
const tfRun = (/** @type {string} */ status, /** @type {Record<string, any>} */ extra = {}) =>
  reply(200, { research_run_id: "11111111-2222-3333-4444-555555555555", status, query: Q, quick_result: null, deep_result: null, error: null, ...extra });
const tfDone = () =>
  tfRun("COMPLETED", { deep_result: { result: "TinyFish report body.", citations: ["https://s1.example/", "https://s2.example/"], termination_reason: "planner_done" } });

/** Scripted GET responses: the n-th call gets states[n-1], the last one repeats. */
const script = (/** @type {Array<() => Response>} */ states) => (/** @type {any} */ _c, /** @type {number} */ n) => states[Math.min(n, states.length) - 1]();

// ---------- unit ----------
describe("run ids and the start-fallback decision", () => {
  it("parseRunId routes by prefix", () => {
    assert.equal(parseRunId("exa:agent_run_abc").p.name, "exa");
    assert.equal(parseRunId("exa:agent_run_abc").raw, "agent_run_abc");
    assert.equal(parseRunId("tinyfish:1111-2222").p.name, "tinyfish");
    for (const bad of ["agent_run_abc", "bing:1", "exa:", ":x", ""]) assert.throws(() => parseRunId(bad), /bad run id/);
  });

  it("safeToFallBack: only when no run can exist", () => {
    const http = (/** @type {number} */ s) => new ProviderError("http", `HTTP ${s}`, { status: s });
    for (const s of [401, 402, 403, 404, 429, 500, 502, 503]) assert.equal(safeToFallBack(http(s)), true, String(s));
    assert.equal(safeToFallBack(new ProviderError("network", "network: ECONNREFUSED", { code: "ECONNREFUSED" })), true);
    assert.equal(safeToFallBack(new ProviderError("network", "network: ENOTFOUND", { code: "ENOTFOUND" })), true);
    assert.equal(safeToFallBack(new ProviderError("network", "network: ECONNRESET", { code: "ECONNRESET" })), false);
    assert.equal(safeToFallBack(new ProviderError("network", "network: fetch failed")), false);
    assert.equal(safeToFallBack(new ProviderError("timeout", "timeout after 30000ms")), false);
    assert.equal(safeToFallBack(new ProviderError("invalid_json", "invalid JSON response")), false);
    assert.equal(safeToFallBack(new ProviderError("bad_response", "no run id")), false);
    assert.equal(safeToFallBack(new ProviderError("bad_response", "run not created", { code: "not_created" })), true);
    assert.equal(safeToFallBack(new Error("boom")), false);
  });
});

// ---------- --max-cost rules ----------
describe("--max-cost", () => {
  it("is mandatory (exit 2, no request)", async () => {
    const r = await run(["research", Q]);
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.err, /--max-cost <usd> is required/);
  });

  it("must be a positive number", async () => {
    for (const v of ["0", "-1", "abc", "", "101"]) assert.equal((await run(["research", Q, "--max-cost", v])).code, 2, v);
  });

  it("TinyFish deep ($2) and max ($3) are refused below their price, with the reason", async () => {
    for (const [mode, cost, ok] of [["deep", "1.99", false], ["deep", "2", true], ["max", "2.5", false], ["max", "3", true]]) {
      const r = await run(["research", Q, "-p", "tinyfish", "--mode", String(mode), "--max-cost", String(cost), "--detach"], { [`POST ${TF_START}`]: tfStart });
      if (ok) assert.equal(r.code, 0, `${mode} ${cost}`);
      else {
        assert.equal(r.code, 2, `${mode} ${cost}`);
        assert.equal(r.calls.length, 0);
        assert.match(r.err, new RegExp(`TinyFish Research "${mode}" costs \\$${mode === "deep" ? 2 : 3} per run, above --max-cost \\$${cost}`));
      }
    }
  });

  it("Exa needs at least $1 (budget.maxCostDollars minimum)", async () => {
    const r = await run(["research", Q, "--max-cost", "0.5"]);
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.err, /Exa Agent needs --max-cost >= \$1/);
    assert.match(r.err, /TinyFish Research "deep" costs \$2/); // both refusals are listed
  });

  it("with no provider forced, a too-small budget for one provider just skips it", async () => {
    // $1: Exa fits, TinyFish ($2) does not. Exa fails to start -> TinyFish is skipped, not tried.
    const r = await run(["research", Q, "--max-cost", "1", "--detach"], { [`POST ${EXA_RUNS}`]: () => reply(503, { error: { message: "down" } }) });
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, TF_START).length, 0);
    assert.match(r.err, /tinyfish: skipped \(TinyFish Research "deep" costs \$2 per run, above --max-cost \$1\)/);
  });
});

// ---------- Exa: request mapping and state machine ----------
describe("research on Exa", () => {
  it("maps effort (default low) and --max-cost to the Agent API request", async () => {
    const r = await run(["research", Q, "--max-cost", "5", "--detach"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued") });
    assert.equal(r.code, 0);
    assert.deepEqual(callsTo(r, EXA_RUNS)[0].body, { query: Q, effort: "low", budget: { maxCostDollars: 5 } });
    assert.equal(callsTo(r, EXA_RUNS)[0].headers["x-api-key"], "exa-key");

    const r2 = await run(["research", Q, "--max-cost", "1", "--effort", "minimal", "--schema", '{"type":"object","properties":{"a":{"type":"string"}}}', "--detach"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued") });
    assert.deepEqual(callsTo(r2, EXA_RUNS)[0].body, {
      query: Q,
      effort: "minimal",
      budget: { maxCostDollars: 1 },
      outputSchema: { type: "object", properties: { a: { type: "string" } } },
    });
  });

  it("--detach prints the prefixed id and exits 0 without polling", async () => {
    const r = await run(["research", Q, "--max-cost", "1", "--detach"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued") });
    assert.equal(r.code, 0);
    assert.equal(r.out, "started: exa:agent_run_abc\nresume: web research status exa:agent_run_abc\ncancel: web research cancel exa:agent_run_abc");
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.sleeps, []);
  });

  it("queued -> running -> completed: polls with backoff, prints report, sources, cost, reason", async () => {
    const r = await run(["research", Q, "--max-cost", "1"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: script([() => exaRun("queued"), () => exaRun("running"), () => exaRun("running"), exaDone]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.sleeps, [5000, 7500, 11250, 16875]);
    assert.equal(
      r.out,
      [
        `# ${Q} — exa, completed, $0.025, schema_satisfied`,
        "id: exa:agent_run_abc",
        "",
        "Qdrant and Milvus lead on filtering; pgvector wins on simplicity.",
        "",
        "Sources:",
        "1. Qdrant",
        "   https://q.example/",
        "2. Milvus",
        "   https://m.example/",
      ].join("\n"),
    );
    assert.match(r.err, /started exa:agent_run_abc \(exa, \$0\.025 fixed\)/);
    assert.match(r.err, /resume: web research status exa:agent_run_abc; cancel: web research cancel exa:agent_run_abc/);
    assert.match(r.err, /exa:agent_run_abc running, \d+s elapsed/);
  });

  it("poll interval grows 5 s -> 30 s and stays there", async () => {
    const r = await run(["research", Q, "--max-cost", "1", "--wait", "5"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: script([...Array(9).fill(() => exaRun("running")), exaDone]),
    });
    assert.equal(r.code, 0);
    assert.equal(r.sleeps[0], POLL_START_MS);
    assert.ok(r.sleeps.every((s) => s <= POLL_MAX_MS));
    assert.deepEqual(r.sleeps.slice(-3), [POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS]);
    for (let i = 1; i < r.sleeps.length; i++) assert.ok(r.sleeps[i] >= r.sleeps[i - 1]);
  });

  it("failed: error shown, exit 1", async () => {
    const r = await run(["research", Q, "--max-cost", "1"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: script([() => exaRun("running"), () => exaRun("failed", { stopReason: "error", error: { type: "SERVER_ERROR", code: "SERVER_ERROR", message: "worker crashed" } })]),
    });
    assert.equal(r.code, 1);
    assert.match(r.out, /— exa, failed, \$0, error\n/);
    assert.match(r.out, /error: SERVER_ERROR: worker crashed/);
  });

  it("cancelled elsewhere: exit 1", async () => {
    const r = await run(["research", Q, "--max-cost", "1"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: () => exaRun("cancelled", { stopReason: "cancelled" }),
    });
    assert.equal(r.code, 1);
    assert.match(r.out, /— exa, cancelled/);
  });

  it("--wait expires while the run is still going: id + resume hint, exit 4", async () => {
    const r = await run(["research", Q, "--max-cost", "1", "--wait", "0.5"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: () => exaRun("running"),
    });
    assert.equal(r.code, 4);
    assert.equal(r.out, "still running after 0.5 min: exa:agent_run_abc\nresume: web research status exa:agent_run_abc\ncancel: web research cancel exa:agent_run_abc");
    assert.equal(r.sleeps.reduce((a, b) => a + b, 0), 30_000); // never sleeps past the deadline
    assert.equal(callsTo(r, `${EXA_RUNS}/agent_run_abc/cancel`).length, 0); // giving up does not cancel
  });

  it("--json: normalized run (also for the still-running case)", async () => {
    const done = await run(["research", Q, "--max-cost", "1", "--json"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued"), [`GET ${EXA_RUNS}/agent_run_abc`]: exaDone });
    const j = JSON.parse(done.out);
    assert.equal(j.id, "exa:agent_run_abc");
    assert.equal(j.status, "completed");
    assert.equal(j.cost, 0.025);
    assert.equal(j.reason, "schema_satisfied");
    assert.deepEqual(j.sources.map((/** @type {any} */ s) => s.url), ["https://q.example/", "https://m.example/"]);

    const running = await run(["research", Q, "--max-cost", "1", "--json", "--wait", "0.1"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued"), [`GET ${EXA_RUNS}/agent_run_abc`]: () => exaRun("running") });
    assert.equal(running.code, 4);
    assert.equal(JSON.parse(running.out).status, "running");
  });

  it("structured output is printed as JSON", async () => {
    const r = await run(["research", Q, "--max-cost", "1", "--schema", '{"type":"object","properties":{"a":{"type":"string"}}}'], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: () => exaRun("completed", { stopReason: "schema_satisfied", output: { text: "", structured: { a: "x" }, grounding: [] } }),
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /\{\n {2}"a": "x"\n\}/);
  });

  it("unknown statuses keep the poll going instead of ending the run", async () => {
    const r = await run(["research", Q, "--max-cost", "1"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: script([() => exaRun("warming_up"), exaDone]),
    });
    assert.equal(r.code, 0);
  });
});

// ---------- fallback only when STARTING fails ----------
describe("start fallback", () => {
  const tfHandlers = {
    [`POST ${TF_START}`]: tfStart,
    [`GET ${TF_RUN}/11111111-2222-3333-4444-555555555555`]: tfDone,
  };

  for (const status of [401, 402, 403, 429, 500, 503]) {
    it(`Exa start HTTP ${status} -> TinyFish`, async () => {
      const r = await run(["research", Q, "--max-cost", "3"], { [`POST ${EXA_RUNS}`]: () => reply(status, { error: { message: "no" } }), ...tfHandlers });
      assert.equal(r.code, 0);
      assert.match(r.err, new RegExp(`exa failed to start the run: HTTP ${status}`));
      assert.match(r.out, /id: tinyfish:11111111-2222-3333-4444-555555555555/);
      assert.equal(callsTo(r, `${EXA_RUNS}/`).length, 0);
    });
  }

  it("connection refused -> TinyFish", async () => {
    const r = await run(["research", Q, "--max-cost", "3"], {
      [`POST ${EXA_RUNS}`]: () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
      ...tfHandlers,
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /tinyfish:/);
  });

  it("HTTP 400 / 422 are caller errors: no fallback, exit 2", async () => {
    for (const status of [400, 422]) {
      const r = await run(["research", Q, "--max-cost", "3"], { [`POST ${EXA_RUNS}`]: () => reply(status, { error: { message: "bad budget" } }) });
      assert.equal(r.code, 2);
      assert.equal(callsTo(r, TF_START).length, 0);
      assert.match(r.err, /exa rejected the request: HTTP \d+: bad budget/);
    }
  });

  it("a start that timed out is NOT retried elsewhere (the run may exist): exit 1 with a warning", async () => {
    const r = await run(
      ["research", Q, "--max-cost", "3"],
      { [`POST ${EXA_RUNS}`]: hang },
      { env: { ...KEYS, WEB_TIMEOUT_MS: "15" } },
    );
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, TF_START).length, 0);
    assert.match(r.err, /may have reached exa and started a \(paid\) run, so it was not retried elsewhere/);
  });

  it("a dropped connection is NOT retried elsewhere either", async () => {
    const r = await run(["research", Q, "--max-cost", "3"], {
      [`POST ${EXA_RUNS}`]: () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      },
    });
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, TF_START).length, 0);
  });

  it("never after the run has started: poll failures do not start a TinyFish run", async () => {
    const r = await run(["research", Q, "--max-cost", "3"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: () => reply(500, { error: { message: "oops" } }),
      ...tfHandlers,
    });
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, TF_START).length, 0);
    assert.match(r.err, /lost track of exa:agent_run_abc/);
    assert.match(r.err, /The run may still be going\. resume: web research status exa:agent_run_abc/);
    assert.equal(callsTo(r, `${EXA_RUNS}/agent_run_abc`).length, 6); // 5 tolerated failures + the one that gives up
  });

  it("transient poll failures are retried and the run still completes", async () => {
    const r = await run(["research", Q, "--max-cost", "1"], {
      [`POST ${EXA_RUNS}`]: () => exaRun("queued"),
      [`GET ${EXA_RUNS}/agent_run_abc`]: script([() => reply(503, {}), () => reply(429, {}, { "retry-after": "20" }), exaDone]),
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa: poll failed \(HTTP 503/);
    assert.ok(r.sleeps.includes(20_000) || r.sleeps.some((s) => s >= 11_250));
  });

  it("an auth failure while polling is fatal immediately", async () => {
    const r = await run(["research", Q, "--max-cost", "1"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued"), [`GET ${EXA_RUNS}/agent_run_abc`]: () => reply(401, { error: { message: "key revoked" } }) });
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, `${EXA_RUNS}/agent_run_abc`).length, 1);
  });

  it("without an Exa key TinyFish starts directly", async () => {
    const r = await run(["research", Q, "--max-cost", "3"], tfHandlers, { env: { TINYFISH_API_KEY: "t" } });
    assert.equal(r.code, 0);
    assert.match(r.err, /exa: skipped \(EXA_API_KEY not set\)/);
  });

  it("--schema makes TinyFish ineligible (no structured output): no fallback, nothing spent", async () => {
    const schema = '{"type":"object","properties":{"a":{"type":"string"}}}';
    const r = await run(["research", Q, "--max-cost", "3", "--schema", schema], { [`POST ${EXA_RUNS}`]: () => reply(503, {}), ...tfHandlers });
    assert.equal(r.code, 1);
    assert.equal(callsTo(r, TF_START).length, 0);
    assert.match(r.err, /tinyfish: skipped \(TinyFish Research has no structured output/);
    const forced = await run(["research", Q, "--max-cost", "3", "-p", "tinyfish", "--schema", schema]);
    assert.equal(forced.code, 2);
  });

  it("TinyFish replying 200 with an error object means no run exists: usable as a fallback signal", async () => {
    const r = await run(["research", Q, "--max-cost", "3", "-p", "tinyfish"], { [`POST ${TF_START}`]: () => reply(200, { research_run_id: null, error: { code: "INTERNAL_ERROR", message: "queue down" } }) });
    assert.equal(r.code, 1);
    assert.match(r.err, /run not created: INTERNAL_ERROR queue down/);
  });

  it("both providers failing to start: exit 1 listing both", async () => {
    const r = await run(["research", Q, "--max-cost", "3"], { [`POST ${EXA_RUNS}`]: () => reply(503, { error: "a" }), [`POST ${TF_START}`]: () => reply(402, { error: { code: "INSUFFICIENT_CREDITS", message: "empty wallet" } }) });
    assert.equal(r.code, 1);
    assert.match(r.err, /could not start a research run\n {2}exa: HTTP 503: a\n {2}tinyfish: HTTP 402: empty wallet/);
  });
});

// ---------- TinyFish: state machine ----------
describe("research on TinyFish", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("starts with the mode and polls QUEUED -> RUNNING -> COMPLETED", async () => {
    const r = await run(["research", Q, "-p", "tinyfish", "--mode", "max", "--max-cost", "3"], {
      [`POST ${TF_START}`]: tfStart,
      [`GET ${TF_RUN}/${id}`]: script([() => tfRun("QUEUED"), () => tfRun("RUNNING"), tfDone]),
    });
    assert.equal(r.code, 0);
    assert.deepEqual(callsTo(r, TF_START)[0].body, { query: Q, mode: "max" });
    assert.equal(callsTo(r, TF_START)[0].headers["X-API-Key"], "tf-key");
    assert.deepEqual(r.sleeps, [5000, 7500, 11250]);
    assert.equal(
      r.out,
      [`# ${Q} — tinyfish, completed, ~$3 (list price), planner_done`, `id: tinyfish:${id}`, "", "TinyFish report body.", "", "Sources:", "1. https://s1.example/", "   https://s1.example/", "2. https://s2.example/", "   https://s2.example/"].join("\n"),
    );
  });

  it("default mode is deep", async () => {
    const r = await run(["research", Q, "-p", "tinyfish", "--max-cost", "2", "--detach"], { [`POST ${TF_START}`]: tfStart });
    assert.deepEqual(callsTo(r, TF_START)[0].body, { query: Q, mode: "deep" });
  });

  for (const [status, label] of [["FAILED", "failed"], ["CANCELLED", "cancelled"], ["TIMED_OUT", "timed_out"]]) {
    it(`${status}: exit 1, not charged`, async () => {
      const r = await run(["research", Q, "-p", "tinyfish", "--max-cost", "2", "--json"], {
        [`POST ${TF_START}`]: tfStart,
        [`GET ${TF_RUN}/${id}`]: script([() => tfRun("RUNNING"), () => tfRun(status, { error: { code: "TASK_FAILED", message: "pipeline" } })]),
      });
      assert.equal(r.code, 1);
      const j = JSON.parse(r.out);
      assert.equal(j.status, label);
      assert.equal(j.cost, 0);
      assert.equal(j.error, "TASK_FAILED: pipeline");
      const text = await run(["research", "status", `tinyfish:${id}`], { [`GET ${TF_RUN}/${id}`]: () => tfRun(status, { error: { code: "TASK_FAILED", message: "pipeline" } }) });
      assert.match(text.out, new RegExp(`— tinyfish, ${label}, not charged\n`));
    });
  }

  it("synthesis_failed completes with a warning", async () => {
    const r = await run(["research", Q, "-p", "tinyfish", "--max-cost", "2"], {
      [`POST ${TF_START}`]: tfStart,
      [`GET ${TF_RUN}/${id}`]: () => tfRun("COMPLETED", { deep_result: { result: "interim", citations: [], termination_reason: "synthesis_failed" } }),
    });
    assert.equal(r.code, 0);
    assert.match(r.err, /final synthesis failed, the report contains interim findings only/);
  });

  it("the --wait budget applies here too (deep runs take 5-20 minutes)", async () => {
    const r = await run(["research", Q, "-p", "tinyfish", "--max-cost", "2", "--wait", "1"], { [`POST ${TF_START}`]: tfStart, [`GET ${TF_RUN}/${id}`]: () => tfRun("RUNNING") });
    assert.equal(r.code, 4);
    assert.match(r.out, new RegExp(`still running after 1 min: tinyfish:${id}`));
  });

  it("--effort is reported as ignored (Exa only)", async () => {
    const r = await run(["research", Q, "-p", "tinyfish", "--max-cost", "2", "--effort", "high", "--detach"], { [`POST ${TF_START}`]: tfStart });
    assert.match(r.err, /tinyfish: --effort has no effect/);
  });

  it("--mode is reported as ignored when Exa serves the run", async () => {
    const r = await run(["research", Q, "--max-cost", "3", "--mode", "max", "--detach"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued") });
    assert.match(r.err, /exa: --mode has no effect \(TinyFish only\)/);
  });
});

// ---------- status / cancel ----------
describe("research status", () => {
  it("routes exa: ids to the Exa Agent API", async () => {
    const r = await run(["research", "status", "exa:agent_run_abc"], { [`GET ${EXA_RUNS}/agent_run_abc`]: exaDone });
    assert.equal(r.code, 0);
    assert.equal(callsTo(r, EXA)[0].url, `${EXA_RUNS}/agent_run_abc`);
    assert.match(r.out, /— exa, completed, \$0\.025/);
  });

  it("routes tinyfish: ids to TinyFish Research", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const r = await run(["research", "status", `tinyfish:${id}`], { [`GET ${TF_RUN}/${id}`]: tfDone });
    assert.equal(r.code, 0);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].url, `${TF_RUN}/${id}`);
    assert.match(r.out, /TinyFish report body\./);
    assert.equal(r.calls[0].headers["X-API-Key"], "tf-key");
  });

  it("exit codes: completed 0, running 4, failed 1", async () => {
    const running = await run(["research", "status", "exa:agent_run_abc"], { [`GET ${EXA_RUNS}/agent_run_abc`]: () => exaRun("running") });
    assert.equal(running.code, 4);
    assert.match(running.out, /# research — exa, running\nid: exa:agent_run_abc\nresume:/);
    const failed = await run(["research", "status", "exa:agent_run_abc"], { [`GET ${EXA_RUNS}/agent_run_abc`]: () => exaRun("failed", { error: { code: "SERVER_ERROR", message: "x" } }) });
    assert.equal(failed.code, 1);
  });

  it("bad id: exit 2 without a request; unknown run: exit 1; missing key: exit 1", async () => {
    const bad = await run(["research", "status", "nope"]);
    assert.equal(bad.code, 2);
    assert.equal(bad.calls.length, 0);
    const missing = await run(["research", "status", "exa:agent_run_zzz"], { [`GET ${EXA_RUNS}/agent_run_zzz`]: () => reply(404, { error: { code: "RUN_NOT_FOUND", message: "no such run" } }) });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /exa: HTTP 404: no such run/);
    const nokey = await run(["research", "status", "tinyfish:abc"], {}, { env: { EXA_API_KEY: "e" } });
    assert.equal(nokey.code, 1);
    assert.match(nokey.err, /TINYFISH_API_KEY not set/);
  });

  it("needs exactly one id", async () => {
    assert.equal((await run(["research", "status"])).code, 2);
    assert.equal((await run(["research", "status", "exa:a", "exa:b"])).code, 2);
  });

  it("a question that merely starts with the word is not a sub-command when quoted", async () => {
    const r = await run(["research", "status of vector databases", "--max-cost", "1", "--detach"], { [`POST ${EXA_RUNS}`]: () => exaRun("queued") });
    assert.equal(r.code, 0);
    assert.equal(callsTo(r, EXA_RUNS)[0].body.query, "status of vector databases");
  });
});

describe("research cancel", () => {
  it("Exa: POST .../cancel, reports the status and what was billed", async () => {
    const r = await run(["research", "cancel", "exa:agent_run_abc"], { [`POST ${EXA_RUNS}/agent_run_abc/cancel`]: () => exaRun("cancelled", { stopReason: "cancelled", costDollars: { total: 0.004 } }) });
    assert.equal(r.code, 0);
    assert.equal(r.calls[0].method, "POST");
    assert.equal(r.out, "exa:agent_run_abc: cancelled, billed $0.004");
  });

  it("TinyFish: POST .../cancel", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const r = await run(["research", "cancel", `tinyfish:${id}`], {
      [`POST ${TF_RUN}/${id}/cancel`]: () => reply(200, { research_run_id: id, status: "CANCELLED", cancelled: true }),
      [`GET ${TF_RUN}/${id}`]: () => tfRun("CANCELLED"),
    });
    assert.equal(r.code, 0);
    assert.equal(r.out, `tinyfish:${id}: cancelled`);
  });

  it("an already finished run is reported as such", async () => {
    const r = await run(["research", "cancel", "exa:agent_run_abc"], { [`POST ${EXA_RUNS}/agent_run_abc/cancel`]: exaDone });
    assert.equal(r.code, 0);
    assert.match(r.out, /not cancelled: the run is already completed/);
  });
});
