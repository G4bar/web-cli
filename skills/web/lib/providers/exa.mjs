// @ts-check
import { call, timeoutFor } from "../http.mjs";
import { ProviderError, UsageError } from "../errors.mjs";
import { clean, envVar, ignoredFlags, log } from "../util.mjs";

/** @typedef {import("../types.mjs").Ctx} Ctx */
/** @typedef {import("../types.mjs").Opts} Opts */
/** @typedef {import("../types.mjs").Provider} Provider */

const BASE = "https://api.exa.ai";

/** CLI category -> Exa `category`. */
export const EXA_CAT = /** @type {Record<string, string>} */ ({
  news: "news",
  papers: "publication",
  company: "company",
  people: "people",
  personal: "personal site",
  financial: "financial report",
});

/** `/search` types: current ones first, then the legacy aliases Exa still accepts. */
export const EXA_TYPES = ["auto", "lite", "deep-lite", "deep"];
export const EXA_LEGACY_TYPES = ["instant", "fast", "deep-reasoning"];

/** Log the `warnings` / `notices` Exa attaches to a response. */
function logNotes(/** @type {Ctx} */ ctx, /** @type {any} */ j) {
  for (const w of j.warnings ?? []) log(ctx, `exa: warning: ${clean(w.message)}`);
  for (const n of j.notices ?? []) log(ctx, `exa: notice: ${clean(n.message)}`);
}

/** Request body of a search. */
function searchBody(/** @type {Ctx} */ ctx, /** @type {string} */ q, /** @type {Opts} */ o) {
  /** @type {Record<string, any>} */
  const body = { query: q, type: o.type ?? "auto", numResults: o.n };
  if (o.site) body.includeDomains = o.site;
  if (o.exclude) body.excludeDomains = o.exclude;
  if (o.recentMin) body.startPublishedDate = new Date(ctx.now() - o.recentMin * 60_000).toISOString();
  else if (o.since) body.startPublishedDate = `${o.since}T00:00:00.000Z`;
  if (o.until) body.endPublishedDate = `${o.until}T23:59:59.999Z`;
  if (o.cat) body.category = EXA_CAT[o.cat];
  return body;
}

/** Auth header for every Exa request. */
const headers = (/** @type {Ctx} */ ctx) => ({ "x-api-key": envVar(ctx, "EXA_API_KEY") });

/** @type {Provider} */
export const exa = {
  name: "exa",
  keyName: "EXA_API_KEY",
  ready: (ctx) => !!envVar(ctx, "EXA_API_KEY"),

  /** Constraints Exa enforces with a 400; caught here before any request is sent. */
  validate(op, o) {
    if (op !== "search") return;
    const dated = o.recentMin || o.since || o.until;
    if ((o.cat === "company" || o.cat === "people") && dated) {
      throw new UsageError(`--cat ${o.cat} cannot be combined with --recent/--since/--until (Exa rejects date filters for this category)`);
    }
    if (o.cat === "people" && o.exclude) {
      throw new UsageError("--cat people cannot be combined with --exclude (Exa rejects excludeDomains for this category)");
    }
  },

  ignored(op, o) {
    return op === "answer" ? ignoredFlags(o.given, ["n", "site", "exclude", "recent", "since", "until", "cat", "type", "chars"], "has no effect on /answer") : [];
  },

  async search(ctx, q, o) {
    const body = { ...searchBody(ctx, q, o), contents: { highlights: { maxCharacters: o.chars } } };
    const j = await call(`${BASE}/search`, { method: "POST", headers: headers(ctx), body, timeout: timeoutFor(ctx, 30_000) });
    logNotes(ctx, j);
    return {
      cost: j.costDollars?.total,
      results: (j.results ?? []).map((/** @type {any} */ r) => ({
        title: clean(r.title),
        url: r.url,
        date: r.publishedDate?.slice(0, 10),
        text: clean((r.highlights ?? []).join(" … ")),
      })),
    };
  },

  async fetch(ctx, urls, o) {
    /** @type {Record<string, any>} */
    const body = {
      urls,
      ...(o.focus ? { highlights: { query: o.focus, maxCharacters: o.max } } : { text: { maxCharacters: o.max } }),
    };
    const j = await call(`${BASE}/contents`, { method: "POST", headers: headers(ctx), body, timeout: timeoutFor(ctx, 60_000) });
    logNotes(ctx, j);
    const byKey = new Map();
    for (const r of j.results ?? []) {
      byKey.set(r.id, r);
      byKey.set(r.url, r);
    }
    /** @type {Map<string, string>} */
    const bad = new Map();
    for (const s of j.statuses ?? []) {
      if (s.status === "success") continue;
      bad.set(s.id, `${s.error?.tag ?? s.status}${s.error?.httpStatusCode ? ` (HTTP ${s.error.httpStatusCode})` : ""}`);
    }
    /** @type {Map<string, import("../types.mjs").Page>} */
    const pages = new Map();
    for (const u of urls) {
      const r = byKey.get(u);
      const text = r && (o.focus ? (r.highlights ?? []).join("\n\n…\n\n") : r.text);
      if (!r || bad.has(u) || !text) {
        log(ctx, `exa: ${u}: ${bad.get(u) ?? (r ? "no content" : "not returned")}`);
        continue;
      }
      /** @type {import("../types.mjs").Page} */
      const page = { url: u, title: clean(r.title), text, truncated: !o.focus && text.length >= o.max };
      pages.set(u, page);
    }
    return { pages, cost: j.costDollars?.total };
  },

  /** `/answer`: a cited answer. */
  async answer(ctx, q) {
    /** @type {Record<string, any>} */
    const body = { query: q, text: false };
    const j = await call(`${BASE}/answer`, { method: "POST", headers: headers(ctx), body, timeout: timeoutFor(ctx, 30_000) });
    logNotes(ctx, j);
    const a = typeof j.answer === "string" ? j.answer.trim() : j.answer;
    if (a === undefined || a === null || a === "") throw new ProviderError("bad_response", "empty answer");
    return {
      cost: j.costDollars?.total,
      answer: a,
      citations: (j.citations ?? []).map((/** @type {any} */ c) => ({ title: clean(c.title), url: c.url, date: c.publishedDate?.slice(0, 10) })),
    };
  },
};