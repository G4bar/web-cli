// @ts-check
// Test harness: runs the CLI in-process against a mocked `globalThis.fetch`.
// No network, no real timers (sleep() only advances a fake clock), no process state.
import { main, parseTimeout } from "../skills/web/lib/cli.mjs";

/** @typedef {import("../skills/web/lib/types.mjs").Ctx} Ctx */

/**
 * @typedef {Object} Call
 * @property {string} url
 * @property {string} method
 * @property {any} body            parsed JSON request body (undefined for GET)
 * @property {Record<string, string>} headers
 * @property {AbortSignal | null | undefined} signal
 * @property {URL} u
 */

/** A JSON Response. */
export const reply = (/** @type {number} */ status, /** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const KEYS = { EXA_API_KEY: "exa-key", TINYFISH_API_KEY: "tf-key" };
export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

/**
 * Run the CLI with a fetch router.
 *
 * `handlers` maps "METHOD url-prefix" to a function returning a Response (or throwing,
 * which the provider sees as a network error). A request nobody handles fails the test.
 *
 * @param {string[]} argv
 * @param {Record<string, (c: Call, n: number) => Response | Promise<Response>>} [handlers]
 * @param {{ env?: Record<string, string | undefined>, startMs?: number }} [opts]
 */
export async function run(argv, handlers = {}, opts = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  /** @type {Call[]} */
  const calls = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {string[]} */
  const unmocked = [];
  const hits = new Map();
  let clock = opts.startMs ?? T0;

  /** @type {Ctx} */
  const ctx = {
    env: opts.env ?? { ...KEYS },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    timeout: undefined,
  };
  ctx.timeout = parseTimeout(ctx);

  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input);
      const u = new URL(url);
      /** @type {Call} */
      const call = {
        url,
        u,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: /** @type {Record<string, string>} */ (init?.headers ?? {}),
        signal: init?.signal,
      };
      calls.push(call);
      // Longest matching prefix wins: "POST /agent/runs" must not shadow "POST /agent/runs/{id}/cancel".
      const key = Object.keys(handlers)
        .filter((k) => {
          const [m, prefix] = k.split(" ");
          return m === call.method && url.startsWith(prefix);
        })
        .sort((a, b) => b.length - a.length)[0];
      if (!key) {
        unmocked.push(`${call.method} ${url}`);
        throw new TypeError("unmocked request");
      }
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return handlers[key](call, n);
    }
  );
  try {
    const code = await main(argv, ctx);
    if (unmocked.length) throw new Error(`unmocked requests: ${unmocked.join(", ")}`);
    return { code, out: out.join("\n"), err: err.join("\n"), calls, sleeps, ctx };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Calls whose URL starts with `prefix`. */
export const callsTo = (/** @type {{ calls: Call[] }} */ r, /** @type {string} */ prefix) => r.calls.filter((c) => c.url.startsWith(prefix));

// ---------- provider fixtures ----------

export const EXA = "https://api.exa.ai";
export const TF_SEARCH = "https://api.search.tinyfish.ai";
export const TF_FETCH = "https://api.fetch.tinyfish.ai";
export const TF_AGENT = "https://agent.tinyfish.ai";

export const exaSearchOk = () =>
  reply(200, {
    costDollars: { total: 0.007 },
    results: [
      { title: "Node  Test\nRunner", url: "https://nodejs.org/api/test.html", publishedDate: "2025-03-04T00:00:00.000Z", highlights: ["first  hit", "second hit"] },
      { title: "", url: "https://example.org/a", highlights: [] },
    ],
  });

export const tfSearchPage = (/** @type {string[]} */ urls, /** @type {number} */ page = 0) =>
  reply(200, { query: "q", page, total_results: urls.length, results: urls.map((url, i) => ({ title: `T ${url}`, url, snippet: `snippet  ${i}`, date: "9 hours ago" })) });

/** `count` distinct URLs starting at `from`. */
export const urls = (/** @type {number} */ count, /** @type {number} */ from = 0) => Array.from({ length: count }, (_, i) => `https://r.example/${from + i}`);

export const exaFetchOk = (/** @type {string[]} */ list, /** @type {Record<string, any>} */ extra = {}) =>
  reply(200, {
    results: list.map((u) => ({ id: u, url: u, title: `Exa ${u}`, text: `exa text of ${u}`, ...extra })),
    statuses: list.map((u) => ({ id: u, status: "success", source: "cached" })),
    costDollars: { total: 0.001 * list.length },
  });

export const tfFetchOk = (/** @type {string[]} */ list, /** @type {Record<string, any>} */ extra = {}) =>
  reply(200, { results: list.map((u) => ({ url: u, final_url: u, title: `TF ${u}`, text: `tinyfish text of ${u}`, ...extra })), errors: [] });

/**
 * A request that never answers until its AbortSignal fires, like a stalled connection.
 * The extra timer plays the role of the open socket: a real fetch keeps the event loop
 * alive, while AbortSignal.timeout() alone does not (it is unref'd, notably on Node 22).
 */
export const hang = (/** @type {Call} */ c) =>
  new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 60_000);
    c.signal?.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(c.signal?.reason);
    });
  });
