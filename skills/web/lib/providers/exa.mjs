// @ts-check
import { call, timeoutFor } from "../http.mjs";
import { ProviderError, UsageError } from "../errors.mjs";
import { clean, dedupeCitations, envVar, ignoredFlags, log } from "../util.mjs";

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

/** Links requested per page; the command trims them again after cleaning. */
const LINKS_REQUESTED = 500;

/** Log the `warnings` / `notices` Exa attaches to a response. */
function logNotes(/** @type {Ctx} */ ctx, /** @type {any} */ j) {
  for (const w of j.warnings ?? []) log(ctx, `exa: warning: ${clean(w.message)}`);
  for (const n of j.notices ?? []) log(ctx, `exa: notice: ${clean(n.message)}`);
}

/** Request body shared by `search` and the `--deep` answer. */
function searchBody(/** @type {Ctx} */ ctx, /** @type {string} */ q, /** @type {Opts} */ o) {
  /** @type {Record<string, any>} */
  const body = { query: q, type: o.type ?? "auto", numResults: o.n };
  if (o.site) body.includeDomains = o.site;
  if (o.exclude) body.excludeDomains = o.exclude;
  if (o.recentMin) body.startPublishedDate = new Date(ctx.now() - o.recentMin * 60_000).toISOString();
  else if (o.since) body.startPublishedDate = `${o.since}T00:00:00.000Z`;
  if (o.until) body.endPublishedDate = `${o.until}T23:59:59.999Z`;
  if (o.cat) body.category = EXA_CAT[o.cat];
  if (o.goal) body.objective = o.goal;
  if (o.country) body.userLocation = o.country;
  return body;
}

/** @param {any} c */
const citation = (c) => ({ title: clean(c.title), url: c.url });

/** Auth header for every Exa request. */
const headers = (/** @type {Ctx} */ ctx) => ({ "x-api-key": envVar(ctx, "EXA_API_KEY") });

/** @type {Provider} */
export const exa = {
  name: "exa",
  keyName: "EXA_API_KEY",
  ready: (ctx) => !!envVar(ctx, "EXA_API_KEY"),

  /** Constraints Exa enforces with a 400; caught here before any request is sent. */
  validate(op, o) {
    const searches = op === "search" || (op === "answer" && o.deep);
    if (!searches) return;
    const dated = o.recentMin || o.since || o.until;
    if ((o.cat === "company" || o.cat === "people") && dated) {
      throw new UsageError(`--cat ${o.cat} cannot be combined with --recent/--since/--until (Exa rejects date filters for this category)`);
    }
    if (o.cat === "people" && o.exclude) {
      throw new UsageError("--cat people cannot be combined with --exclude (Exa rejects excludeDomains for this category)");
    }
  },

  ignored(op, o) {
    const no = (/** @type {string[]} */ flags, /** @type {string} */ why) => ignoredFlags(o.given, flags, why);
    if (op === "search") return no(["lang"], "has no effect (Exa has no language filter)");
    if (op === "answer" && o.deep) return no(["type", "chars", "lang"], "has no effect with --deep");
    if (op === "answer") return no(["n", "site", "exclude", "recent", "since", "until", "cat", "type", "chars", "goal", "lang"], "has no effect on /answer (add --deep to search with filters)");
    return no(["goal"], "has no effect (Exa fetch has no goal parameter)");
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
    if (o.fresh) body.maxAgeHours = 0;
    if (o.links) body.extras = { links: LINKS_REQUESTED };
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
      if (o.links) page.links = Array.isArray(r.extras?.links) ? r.extras.links : [];
      pages.set(u, page);
    }
    return { pages, cost: j.costDollars?.total };
  },

  /**
   * `/answer`, or with --deep a `/search` of type deep / deep-lite whose
   * synthesis (`outputSchema`) is the answer.
   */
  async answer(ctx, q, o) {
    if (o.deep) return deepAnswer(ctx, q, o);
    /** @type {Record<string, any>} */
    const body = { query: q, text: false };
    if (o.schema) body.outputSchema = o.schema;
    if (o.country) body.userLocation = o.country;
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

/**
 * Search-based answer. Without `outputSchema` deep search returns only results,
 * so one is always sent: `{"type":"text"}` or the user's object schema.
 * @param {Ctx} ctx
 * @param {string} q
 * @param {Opts} o
 */
async function deepAnswer(ctx, q, o) {
  const type = o.fast ? "deep-lite" : "deep";
  const body = { ...searchBody(ctx, q, { ...o, type }), outputSchema: o.schema ?? { type: "text" } };
  const j = await call(`${BASE}/search`, { method: "POST", headers: headers(ctx), body, timeout: timeoutFor(ctx, 30_000) });
  logNotes(ctx, j);
  const content = j.output?.content;
  if (content === undefined || content === null || content === "") throw new ProviderError("bad_response", `no synthesized output in ${type} response`);
  /** @type {any[]} */
  const grounding = Array.isArray(j.output.grounding) ? j.output.grounding : [];
  return {
    cost: j.costDollars?.total,
    mode: type,
    answer: typeof content === "string" ? content.trim() : content,
    citations: dedupeCitations(grounding.flatMap((g) => (g.citations ?? []).map(citation))),
    grounding,
  };
}
