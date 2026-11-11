// @ts-check

/** @typedef {import("./types.mjs").Ctx} Ctx */
/** @typedef {import("./types.mjs").Citation} Citation */

/** Collapse whitespace. */
export const clean = (/** @type {unknown} */ s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Comma-separated list -> trimmed non-empty items, or undefined. */
export const list = (/** @type {string | undefined} */ s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

/** How a flag is written on the command line: "-n", "--site". */
export const flagName = (/** @type {string} */ f) => (f.length === 1 ? `-${f}` : `--${f}`);

/**
 * Messages for the flags in `flags` the user actually passed (`given`), e.g. "--type has no effect (Exa only)".
 * @param {Set<string>} given
 * @param {string[]} flags
 * @param {string} why
 */
export const ignoredFlags = (given, flags, why) => flags.filter((f) => given.has(f)).map((f) => `${flagName(f)} ${why}`);

/** Progress / diagnostics go to stderr, results to stdout. */
export const log = (/** @type {Ctx} */ ctx, /** @type {string} */ m) => ctx.err(`[web] ${m}`);

/** Non-empty trimmed env var. */
export const envVar = (/** @type {Ctx} */ ctx, /** @type {string} */ k) => ctx.env[k]?.trim() || undefined;

/**
 * Keep the passages that overlap most with `focus`; document order preserved.
 * @param {string} text
 * @param {string} focus
 * @param {number} max
 */
export function focusText(text, focus, max) {
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

/** Identity of a URL for de-duplication: no fragment, no trailing slash, lower-case host. */
export function urlKey(/** @type {string} */ u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return u.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

/**
 * Outbound links of a page: http(s) only, no pure #fragment links (relative, or
 * absolute links back to the page itself), de-duplicated, capped.
 *
 * @param {string[]} raw
 * @param {string[]} pageUrls  URLs the page is known by (requested, final)
 * @param {number} cap
 * @returns {{ links: string[], total: number }}
 */
export function cleanLinks(raw, pageUrls, cap) {
  const self = new Set(pageUrls.map(urlKey));
  const seen = new Set();
  /** @type {string[]} */
  const all = [];
  for (const l of raw) {
    if (typeof l !== "string") continue;
    const u = l.trim();
    if (!/^https?:\/\//i.test(u)) continue; // drops "#x", mailto:, javascript:, ...
    if (u.includes("#") && self.has(urlKey(u))) continue; // same page, different anchor
    const k = urlKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(u);
  }
  return { links: all.slice(0, cap), total: all.length };
}

/** Unique citations by URL, first title wins. */
export function dedupeCitations(/** @type {Citation[]} */ cits) {
  const seen = new Set();
  /** @type {Citation[]} */
  const out = [];
  for (const c of cits) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

/** 83000 -> "1m23s" */
export function fmtDuration(/** @type {number} */ ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
