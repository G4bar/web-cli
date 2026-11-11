#!/usr/bin/env node
// web — search / fetch / answer with provider fallback (Exa -> TinyFish).
// Zero dependencies. Needs EXA_API_KEY and/or TINYFISH_API_KEY in the environment.
import { parseArgs } from "node:util";

const HELP = `web — web search & page fetch (Exa, falls back to TinyFish)

USAGE
  web search <query> [options]     ranked results + short excerpts
  web fetch  <url...> [options]    page content as markdown (max 10 URLs)
  web answer <question>            cited answer (Exa; falls back to search results)

SEARCH OPTIONS
  -n <num>            results (default 8)
  --site a.com,b.org  only these domains
  --exclude x.com     skip these domains
  --recent 7d         freshness window: <N>h | <N>d | <N>w
  --since YYYY-MM-DD  --until YYYY-MM-DD
  --cat <c>           news | papers | company | people | personal | financial
  --type <t>          Exa only: auto (default) | lite | deep-lite | deep
  --chars <num>       excerpt size per result (default 600)

FETCH OPTIONS
  --max <num>         max chars per page (default 8000)
  --focus "<text>"    return only the passages most relevant to this text

COMMON
  -p, --provider <p>  exa | tinyfish: force one provider, no fallback
  --json              normalized JSON instead of text
  -h, --help

ENV
  EXA_API_KEY, TINYFISH_API_KEY
  WEB_PROVIDERS=exa,tinyfish   provider order (default)
  WEB_TIMEOUT_MS=30000         per-request timeout

Fallback triggers on any provider error (HTTP 4xx/5xx, timeout, network, missing key).
Errors go to stderr; results to stdout.`;

// ---------- utils ----------
const env = (k) => process.env[k]?.trim() || undefined;
const TIMEOUT = Number(env("WEB_TIMEOUT_MS")) || 30_000;
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const log = (m) => console.error(`[web] ${m}`);
const die = (m, code = 1) => {
  console.error(`[web] ${m}`);
  process.exit(code);
};

async function call(url, { method = "GET", headers = {}, body, timeout = TIMEOUT } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? `timeout after ${timeout}ms` : `network: ${e.cause?.code ?? e.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const m = json?.error?.message ?? json?.error ?? json?.message ?? text;
    throw new Error(`HTTP ${res.status}: ${clean(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 200)}`);
  }
  if (!json) throw new Error("invalid JSON response");
  return json;
}

// Keep the passages that overlap most with `focus`; document order preserved.
function focusText(text, focus, max) {
  const terms = [...new Set(focus.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))];
  const paras = text.split(/\n{2,}/).map((p, i) => ({ p, i, s: terms.filter((t) => p.toLowerCase().includes(t)).length }));
  const hits = paras.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  if (!hits.length) return text;
  const keep = [];
  let used = 0;
  for (const h of hits) {
    if (used + h.p.length > max && keep.length) continue;
    keep.push(h);
    used += h.p.length + 2;
  }
  return keep.sort((a, b) => a.i - b.i).map((x) => x.p).join("\n\n…\n\n");
}

// ---------- providers ----------
const EXA_CAT = { news: "news", papers: "publication", company: "company", people: "people", personal: "personal site", financial: "financial report" };
const TF_DOMAIN = { news: "news", papers: "research_paper" };

const exa = {
  name: "exa",
  keyName: "EXA_API_KEY",
  ready: () => !!env("EXA_API_KEY"),
  headers: () => ({ "x-api-key": env("EXA_API_KEY") }),

  async search(q, o) {
    const body = {
      query: q,
      type: o.type ?? "auto",
      numResults: o.n,
      contents: { highlights: { maxCharacters: o.chars } },
    };
    if (o.site) body.includeDomains = o.site;
    if (o.exclude) body.excludeDomains = o.exclude;
    if (o.recentMin) body.startPublishedDate = new Date(Date.now() - o.recentMin * 60_000).toISOString();
    else if (o.since) body.startPublishedDate = `${o.since}T00:00:00.000Z`;
    if (o.until) body.endPublishedDate = `${o.until}T23:59:59.999Z`;
    if (o.cat) body.category = EXA_CAT[o.cat];
    const j = await call("https://api.exa.ai/search", { method: "POST", headers: this.headers(), body });
    return {
      cost: j.costDollars?.total,
      results: (j.results ?? []).map((r) => ({
        title: clean(r.title),
        url: r.url,
        date: r.publishedDate?.slice(0, 10),
        text: clean((r.highlights ?? []).join(" … ")),
      })),
    };
  },

  async fetch(urls, o) {
    const body = {
      urls,
      ...(o.focus ? { highlights: { query: o.focus, maxCharacters: o.max } } : { text: { maxCharacters: o.max } }),
    };
    const j = await call("https://api.exa.ai/contents", { method: "POST", headers: this.headers(), body, timeout: 60_000 });
    const byKey = new Map();
    for (const r of j.results ?? []) {
      byKey.set(r.id, r);
      byKey.set(r.url, r);
    }
    const bad = new Map((j.statuses ?? []).filter((s) => s.status !== "success").map((s) => [s.id, s.error?.tag ?? s.status]));
    const pages = new Map();
    for (const u of urls) {
      const r = byKey.get(u);
      const text = r && (o.focus ? (r.highlights ?? []).join("\n\n…\n\n") : r.text);
      if (!r || bad.has(u) || !text) continue;
      pages.set(u, { url: u, title: clean(r.title), text, truncated: !o.focus && text.length >= o.max });
    }
    return { pages, cost: j.costDollars?.total };
  },

  async answer(q) {
    const j = await call("https://api.exa.ai/answer", { method: "POST", headers: this.headers(), body: { query: q, text: false } });
    const a = typeof j.answer === "string" ? j.answer : JSON.stringify(j.answer);
    return {
      cost: j.costDollars?.total,
      answer: a.trim(),
      citations: (j.citations ?? []).map((c) => ({ title: clean(c.title), url: c.url, date: c.publishedDate?.slice(0, 10) })),
    };
  },
};

const tinyfish = {
  name: "tinyfish",
  keyName: "TINYFISH_API_KEY",
  ready: () => !!env("TINYFISH_API_KEY"),
  headers: () => ({ "X-API-Key": env("TINYFISH_API_KEY") }),

  async search(q, o) {
    const p = new URLSearchParams({ query: q });
    if (o.site) p.set("include_domains", o.site.join(","));
    if (o.exclude) p.set("exclude_domains", o.exclude.join(","));
    if (o.cat && TF_DOMAIN[o.cat]) p.set("domain_type", TF_DOMAIN[o.cat]);
    else if (o.cat) log(`tinyfish: --cat ${o.cat} not supported, searching the plain web`);
    if (o.cat !== "papers") {
      if (o.recentMin) p.set("recency_minutes", String(o.recentMin));
      else {
        if (o.since) p.set("after_date", o.since);
        if (o.until) p.set("before_date", o.until);
      }
    }
    const j = await call(`https://api.search.tinyfish.ai?${p}`, { headers: this.headers() });
    return {
      results: (j.results ?? []).slice(0, o.n).map((r) => ({
        title: clean(r.title),
        url: r.url,
        date: r.date,
        text: clean(r.snippet),
      })),
    };
  },

  async fetch(urls, o) {
    const j = await call("https://api.fetch.tinyfish.ai", {
      method: "POST",
      headers: this.headers(),
      body: { urls, format: "markdown" },
      timeout: 90_000,
    });
    const pages = new Map();
    for (const r of j.results ?? []) {
      const u = urls.find((x) => x === r.url || x === r.final_url) ?? r.url;
      if (!r.text || typeof r.text !== "string") continue;
      let text = r.text;
      if (o.focus) text = focusText(text, o.focus, o.max);
      pages.set(u, { url: u, title: clean(r.title), text, truncated: false });
    }
    for (const e of j.errors ?? []) log(`tinyfish: ${e.url}: ${clean(e.error)}`);
    return { pages };
  },
};

const REGISTRY = { exa, tinyfish };

function providerOrder(forced) {
  const names = forced ? [forced] : (env("WEB_PROVIDERS") ?? "exa,tinyfish").split(",").map((s) => s.trim()).filter(Boolean);
  return names.map((n) => REGISTRY[n] ?? die(`unknown provider "${n}" (use exa | tinyfish)`, 2));
}

// Try providers in order; first one that succeeds with a non-empty result wins.
// An empty result also moves on to the next provider, but is returned if nobody does better.
async function withFallback(order, fn) {
  const errs = [];
  let empty;
  for (const p of order) {
    if (!p.ready()) {
      errs.push(`${p.name}: ${p.keyName} not set`);
      log(`${p.name}: skipped (${p.keyName} not set)`);
      continue;
    }
    try {
      const r = { provider: p.name, ...(await fn(p)) };
      if (r.results?.length) return r;
      empty ??= r;
      log(`${p.name}: 0 results`);
    } catch (e) {
      errs.push(`${p.name}: ${e.message}`);
      log(`${p.name} failed: ${e.message}`);
    }
  }
  return empty ?? die(`all providers failed\n  ${errs.join("\n  ")}`);
}

// ---------- commands ----------
function printResults(q, provider, results, cost) {
  console.log(`# ${q} — ${provider}, ${results.length} result${results.length === 1 ? "" : "s"}${cost ? `, $${cost}` : ""}`);
  results.forEach((r, i) => {
    console.log(`\n${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}${r.date ? `  (${r.date})` : ""}`);
    if (r.text) console.log(`   ${r.text}`);
  });
}

async function cmdSearch(q, o) {
  const r = await withFallback(providerOrder(o.provider), (p) => p.search(q, o));
  if (o.json) return console.log(JSON.stringify({ query: q, provider: r.provider, cost: r.cost, results: r.results }, null, 2));
  if (!r.results.length) return console.log(`# ${q} — ${r.provider}, 0 results`);
  printResults(q, r.provider, r.results, r.cost);
}

async function cmdFetch(urls, o) {
  if (urls.length > 10) die("max 10 URLs per call", 2);
  const order = providerOrder(o.provider);
  const done = new Map(); // url -> page + provider
  let pending = [...urls];
  const errs = [];
  for (const p of order) {
    if (!pending.length) break;
    if (!p.ready()) {
      errs.push(`${p.name}: ${p.keyName} not set`);
      log(`${p.name}: skipped (${p.keyName} not set)`);
      continue;
    }
    try {
      const { pages } = await p.fetch(pending, o);
      for (const [u, page] of pages) done.set(u, { ...page, provider: p.name });
      pending = pending.filter((u) => !pages.has(u));
      if (pending.length && order.at(-1) !== p) log(`${p.name}: ${pending.length} URL(s) failed, trying next provider`);
    } catch (e) {
      errs.push(`${p.name}: ${e.message}`);
      log(`${p.name} failed: ${e.message}`);
    }
  }
  const out = urls.filter((u) => done.has(u)).map((u) => done.get(u));
  if (o.json) {
    return console.log(JSON.stringify({ pages: out.map((x) => ({ ...x, text: trunc(x, o).text })), failed: pending, errors: errs }, null, 2));
  }
  for (const page of out) {
    const { text, total, cut } = trunc(page, o);
    const meta = [page.provider, `${total} chars`, cut ? `truncated to ${o.max} — use --max N or --focus "..."` : null].filter(Boolean).join(", ");
    console.log(`## ${page.url}${page.title ? ` — ${page.title}` : ""}  [${meta}]\n\n${text}\n`);
  }
  for (const u of pending) log(`FAILED ${u}`);
  if (pending.length) process.exitCode = out.length ? 3 : 1; // 3 = partial
}

function trunc(page, o) {
  const t = page.text.replace(/\n{3,}/g, "\n\n").trim();
  const cut = page.truncated || t.length > o.max;
  const text = t.length > o.max ? `${t.slice(0, o.max).trimEnd()} …` : t;
  return { text, total: `${t.length}${page.truncated ? "+" : ""}`, cut };
}

async function cmdAnswer(q, o) {
  const order = providerOrder(o.provider);
  const errs = [];
  for (const p of order) {
    if (!p.ready()) {
      errs.push(`${p.name}: ${p.keyName} not set`);
      log(`${p.name}: skipped (${p.keyName} not set)`);
      continue;
    }
    try {
      if (p.answer) {
        const r = await p.answer(q, o);
        if (o.json) return console.log(JSON.stringify({ query: q, provider: p.name, ...r }, null, 2));
        console.log(`# ${q} — ${p.name}${r.cost ? `, $${r.cost}` : ""}\n\n${r.answer}\n\nSources:`);
        for (const [i, c] of r.citations.entries()) {
          console.log(`${i + 1}. ${c.title || c.url}\n   ${c.url}${c.date ? `  (${c.date})` : ""}`);
        }
        return;
      }
      log(`${p.name}: no answer endpoint, returning search results instead`);
      const r = await p.search(q, o);
      if (o.json) return console.log(JSON.stringify({ query: q, provider: p.name, results: r.results }, null, 2));
      return printResults(q, p.name, r.results, r.cost);
    } catch (e) {
      errs.push(`${p.name}: ${e.message}`);
      log(`${p.name} failed: ${e.message}`);
    }
  }
  die(`all providers failed\n  ${errs.join("\n  ")}`);
}

// ---------- main ----------
function parseDuration(s) {
  const m = /^(\d+)([hdw])$/.exec(s);
  if (!m) die(`bad --recent "${s}" (use e.g. 12h, 7d, 2w)`, 2);
  return Number(m[1]) * { h: 60, d: 1440, w: 10080 }[m[2]];
}
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const date = (flag, s) => {
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) die(`bad ${flag} "${s}" (use YYYY-MM-DD)`, 2);
  return s;
};
const int = (flag, s, def, min, max) => {
  const v = s === undefined ? def : Number(s);
  if (!Number.isInteger(v) || v < min || v > max) die(`bad ${flag} "${s}" (${min}-${max})`, 2);
  return v;
};

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      n: { type: "string", short: "n" },
      site: { type: "string" },
      exclude: { type: "string" },
      recent: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      cat: { type: "string" },
      type: { type: "string" },
      chars: { type: "string" },
      max: { type: "string" },
      focus: { type: "string" },
      provider: { type: "string", short: "p" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  die(`${e.message}\n\n${HELP}`, 2);
}

const { values: v, positionals } = parsed;
const [cmd, ...rest] = positionals;
if (v.help || !cmd) {
  console.log(HELP);
  process.exit(cmd || v.help ? 0 : 2);
}
if (v.cat && !EXA_CAT[v.cat]) die(`bad --cat "${v.cat}" (${Object.keys(EXA_CAT).join(" | ")})`, 2);
if (v.recent && (v.since || v.until)) die("--recent cannot be combined with --since/--until", 2);

const opts = {
  n: int("-n", v.n, 8, 1, 50),
  chars: int("--chars", v.chars, 600, 100, 5000),
  max: int("--max", v.max, 8000, 200, 200_000),
  site: list(v.site),
  exclude: list(v.exclude),
  recentMin: v.recent ? parseDuration(v.recent) : undefined,
  since: date("--since", v.since),
  until: date("--until", v.until),
  cat: v.cat,
  type: v.type,
  focus: v.focus?.trim() || undefined,
  provider: v.provider,
  json: !!v.json,
};

if (cmd === "search" || cmd === "answer") {
  const q = rest.join(" ").trim();
  if (!q) die(`usage: web ${cmd} <${cmd === "search" ? "query" : "question"}>`, 2);
  await (cmd === "search" ? cmdSearch : cmdAnswer)(q, opts);
} else if (cmd === "fetch") {
  if (!rest.length) die("usage: web fetch <url...>", 2);
  const bad = rest.find((u) => !/^https?:\/\//i.test(u));
  if (bad) die(`not an http(s) URL: ${bad}`, 2);
  await cmdFetch(rest, opts);
} else {
  die(`unknown command "${cmd}" (search | fetch | answer). See: web --help`, 2);
}
