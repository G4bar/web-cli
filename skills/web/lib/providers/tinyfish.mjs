// @ts-check
import { call, timeoutFor } from "../http.mjs";
import { ProviderError } from "../errors.mjs";
import { clean, envVar, focusText, ignoredFlags, log, urlKey } from "../util.mjs";

/** @typedef {import("../types.mjs").Ctx} Ctx */
/** @typedef {import("../types.mjs").Opts} Opts */
/** @typedef {import("../types.mjs").Provider} Provider */
/** @typedef {import("../types.mjs").ResearchRun} ResearchRun */
/** @typedef {import("../types.mjs").SearchResult} SearchResult */

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
const AGENT_URL = "https://agent.tinyfish.ai";

const TF_DOMAIN = /** @type {Record<string, string>} */ ({ news: "news", papers: "research_paper" });
/** Exa-only categories: TinyFish searches the plain web instead. */
const EXA_ONLY_CATS = ["company", "people", "personal", "financial"];

/** Results per search page (API maximum), highest page index, and recency maximum. */
const PAGE_SIZE = 10;
const MAX_PAGE = 10;
const MAX_RECENCY_MIN = 5_256_000;

/** Published research prices (USD per completed run). */
export const RESEARCH_PRICE = /** @type {Record<string, number>} */ ({ deep: 2, max: 3 });

/** Per-URL timeout sent to the Fetch API: below the client timeout, within the API's 1..110000 ms. */
export function perUrlTimeout(/** @type {number} */ clientTimeout) {
  return Math.max(1, Math.min(110_000, Math.floor(clientTimeout * 0.85)));
}

/**
 * `--cat papers` filters by publication year on TinyFish (date filters are
 * rejected there), so --since / --until / --recent are mapped to years.
 *
 * @param {Opts} o
 * @param {number} now epoch ms
 * @returns {{ min?: number, max?: number }}
 */
export function paperYears(o, now) {
  /** @type {{ min?: number, max?: number }} */
  const y = {};
  if (o.recentMin) y.min = new Date(now - o.recentMin * 60_000).getUTCFullYear();
  else if (o.since) y.min = Number(o.since.slice(0, 4));
  if (o.until) y.max = Number(o.until.slice(0, 4));
  return y;
}

/** @param {Ctx} ctx */
const headers = (ctx) => ({ "X-API-Key": envVar(ctx, "TINYFISH_API_KEY") });

/**
 * One page of search results.
 * @param {Ctx} ctx
 * @param {string} q
 * @param {Opts} o
 * @param {number} page
 */
async function searchPage(ctx, q, o, page) {
  const p = new URLSearchParams({ query: q });
  if (o.site) p.set("include_domains", o.site.join(","));
  if (o.exclude) p.set("exclude_domains", o.exclude.join(","));
  if (o.cat && TF_DOMAIN[o.cat]) p.set("domain_type", TF_DOMAIN[o.cat]);
  if (o.cat === "papers") {
    const { min, max } = paperYears(o, ctx.now());
    if (min !== undefined) p.set("pub_year_min", String(min));
    if (max !== undefined) p.set("pub_year_max", String(max));
  } else if (o.recentMin) p.set("recency_minutes", String(Math.min(o.recentMin, MAX_RECENCY_MIN)));
  else {
    if (o.since) p.set("after_date", o.since);
    if (o.until) p.set("before_date", o.until);
  }
  if (o.goal) p.set("purpose", o.goal);
  if (o.country) p.set("location", o.country);
  if (o.lang) p.set("language", o.lang);
  if (page > 0) p.set("page", String(page));
  return call(`${SEARCH_URL}?${p}`, { headers: headers(ctx), timeout: timeoutFor(ctx, 30_000) });
}

/** @param {any} j  TinyFish research run */
function normalizeRun(j) {
  /** @type {Record<string, ResearchRun["status"]>} */
  const statuses = { QUEUED: "queued", RUNNING: "running", COMPLETED: "completed", FAILED: "failed", CANCELLED: "cancelled", TIMED_OUT: "timed_out" };
  const status = statuses[j.status] ?? "running"; // unknown states: keep polling
  const deep = j.deep_result ?? {};
  /** @type {string[]} */
  const cites = Array.isArray(deep.citations) ? deep.citations : [];
  return /** @type {ResearchRun} */ ({
    id: `tinyfish:${j.research_run_id}`,
    provider: "tinyfish",
    status,
    text: typeof deep.result === "string" && deep.result.trim() ? deep.result : undefined,
    sources: cites.filter((u) => typeof u === "string").map((url) => ({ title: "", url })),
    // The API reports no cost. Failed, cancelled and timed-out runs are not charged; a
    // completed run costs the mode's list price, which the command fills in when it knows the mode.
    cost: status === "failed" || status === "cancelled" || status === "timed_out" ? 0 : undefined,
    costEstimated: true,
    reason: deep.termination_reason ?? undefined,
    error: j.error ? `${j.error.code ?? "error"}: ${j.error.message ?? ""}`.trim() : undefined,
  });
}

/** @type {Provider} */
export const tinyfish = {
  name: "tinyfish",
  keyName: "TINYFISH_API_KEY",
  ready: (ctx) => !!envVar(ctx, "TINYFISH_API_KEY"),

  validate() {},

  ignored(op, o) {
    const no = (/** @type {string[]} */ flags, /** @type {string} */ why) => ignoredFlags(o.given, flags, why);
    /** @type {string[]} */
    const out = [];
    if (op === "search" || op === "answer") {
      out.push(...no(["type", "chars"], "has no effect (Exa only)"));
      if (o.cat && EXA_ONLY_CATS.includes(o.cat)) out.push(`--cat ${o.cat} not supported, searching the plain web`);
      if (o.cat === "papers" && (o.recentMin || o.since || o.until)) {
        out.push("--recent/--since/--until apply to papers by publication year only (pub_year_min/pub_year_max)");
      }
      if (o.recentMin && o.recentMin > MAX_RECENCY_MIN && o.cat !== "papers") out.push("--recent capped at 10 years");
      if (op === "answer") out.push(...no(["deep", "fast", "schema"], "has no effect (TinyFish has no answer endpoint; returning search results)"));
    } else if (op === "research") {
      out.push(...no(["effort"], "has no effect (Exa only)"));
    }
    return out;
  },

  /**
   * Fetches pages (10 results each) until `-n` unique results are collected or a page
   * brings nothing new. That is at most ceil(n/10)+2 requests, i.e. <= 7 for n <= 50,
   * well inside the 30 requests/minute limit. A failure after the first page returns
   * what was collected so far.
   */
  async search(ctx, q, o) {
    const maxPages = Math.min(MAX_PAGE + 1, Math.ceil(o.n / PAGE_SIZE) + 2);
    /** @type {SearchResult[]} */
    const results = [];
    const seen = new Set();
    for (let page = 0; page < maxPages && results.length < o.n; page++) {
      /** @type {any} */
      let j;
      try {
        j = await searchPage(ctx, q, o, page).catch(async (/** @type {unknown} */ e) => {
          // One polite retry on rate limiting, but only once some results are in hand.
          if (page > 0 && e instanceof ProviderError && e.status === 429) {
            await ctx.sleep(Math.min(e.retryAfterMs ?? 2000, 10_000));
            return searchPage(ctx, q, o, page);
          }
          throw e;
        });
      } catch (e) {
        if (!results.length) throw e;
        log(ctx, `tinyfish: page ${page} failed (${e instanceof Error ? e.message : e}), returning ${results.length} result(s)`);
        break;
      }
      let added = 0;
      for (const r of j.results ?? []) {
        const k = urlKey(r.url ?? "");
        if (!r.url || seen.has(k)) continue;
        seen.add(k);
        results.push({ title: clean(r.title), url: r.url, date: r.date, text: clean(r.snippet) });
        added++;
      }
      if (!added) break; // empty page, or nothing new: no more results
    }
    return { results: results.slice(0, o.n) };
  },

  async fetch(ctx, urls, o) {
    const timeout = timeoutFor(ctx, 90_000);
    /** @type {Record<string, any>} */
    const body = { urls, format: "markdown", per_url_timeout_ms: perUrlTimeout(timeout) };
    if (o.fresh) body.ttl = 0;
    if (o.links) body.links = true;
    if (o.goal) body.purpose = o.goal;
    const j = await call(FETCH_URL, { method: "POST", headers: headers(ctx), body, timeout });
    /** @type {Map<string, import("../types.mjs").Page>} */
    const pages = new Map();
    for (const r of j.results ?? []) {
      const u = urls.find((x) => x === r.url || x === r.final_url) ?? r.url;
      if (!r.text || typeof r.text !== "string") continue;
      let text = r.text;
      if (o.focus) text = focusText(text, o.focus, o.max);
      /** @type {import("../types.mjs").Page} */
      const page = { url: u, title: clean(r.title), text, truncated: false };
      if (o.links) page.links = Array.isArray(r.links) ? r.links : [];
      pages.set(u, page);
    }
    for (const e of j.errors ?? []) log(ctx, `tinyfish: ${e.url}: ${clean(e.error)}${e.status ? ` (HTTP ${e.status})` : ""}`);
    return { pages };
  },

  research: {
    check(o) {
      const mode = o.mode ?? "deep";
      const price = RESEARCH_PRICE[mode];
      if (o.schema) return { ok: false, reason: "TinyFish Research has no structured output (--schema)" };
      if (price > (o.maxCost ?? 0)) return { ok: false, reason: `TinyFish Research "${mode}" costs $${price} per run, above --max-cost $${o.maxCost}` };
      return { ok: true, price: `$${price} list price, charged on completion` };
    },

    async start(ctx, q, o) {
      const mode = o.mode ?? "deep";
      const j = await call(`${AGENT_URL}/v1/automation/run-research-async`, {
        method: "POST",
        headers: headers(ctx),
        body: { query: q, mode },
        timeout: timeoutFor(ctx, 30_000),
      });
      // A 200 can still carry a creation error; no run exists in that case.
      if (j.error || !j.research_run_id) {
        throw new ProviderError("bad_response", `run not created${j.error ? `: ${j.error.code ?? ""} ${j.error.message ?? ""}`.trimEnd() : ""}`, { code: "not_created" });
      }
      const run = normalizeRun({ research_run_id: j.research_run_id, status: "QUEUED" });
      run.cost = RESEARCH_PRICE[mode]; // expected, charged on completion
      return run;
    },

    async get(ctx, rawId) {
      return normalizeRun(await call(`${AGENT_URL}/v1/research-run/${encodeURIComponent(rawId)}`, { headers: headers(ctx), timeout: timeoutFor(ctx, 30_000) }));
    },

    async cancel(ctx, rawId) {
      const j = await call(`${AGENT_URL}/v1/research-run/${encodeURIComponent(rawId)}/cancel`, {
        method: "POST",
        headers: headers(ctx),
        timeout: timeoutFor(ctx, 30_000),
      });
      // The cancel response carries only the status; fetch the full run for a uniform result.
      try {
        return await tinyfish.research.get(ctx, rawId);
      } catch {
        return normalizeRun({ research_run_id: rawId, status: j.status });
      }
    },
  },
};
