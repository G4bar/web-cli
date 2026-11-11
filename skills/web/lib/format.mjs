// @ts-check
/** @typedef {import("./types.mjs").Ctx} Ctx */
/** @typedef {import("./types.mjs").SearchResult} SearchResult */
/** @typedef {import("./types.mjs").Citation} Citation */

/** Pretty JSON on stdout. */
export const printJson = (/** @type {Ctx} */ ctx, /** @type {unknown} */ v) => ctx.out(JSON.stringify(v, null, 2));

/** `, $0.007` or empty. */
const costSuffix = (/** @type {number | undefined} */ cost) => (cost ? `, $${cost}` : "");

/**
 * @param {Ctx} ctx
 * @param {string} q
 * @param {string} provider
 * @param {SearchResult[]} results
 * @param {number} [cost]
 */
export function printResults(ctx, q, provider, results, cost) {
  ctx.out(`# ${q} — ${provider}, ${results.length} result${results.length === 1 ? "" : "s"}${costSuffix(cost)}`);
  results.forEach((r, i) => {
    ctx.out(`\n${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}${r.date ? `  (${r.date})` : ""}`);
    if (r.text) ctx.out(`   ${r.text}`);
  });
}

/** @param {Ctx} ctx @param {Citation[]} citations */
export function printSources(ctx, citations) {
  ctx.out("\nSources:");
  for (const [i, c] of citations.entries()) {
    ctx.out(`${i + 1}. ${c.title || c.url}\n   ${c.url}${c.date ? `  (${c.date})` : ""}`);
  }
}


/**
 * One fetched page, truncated to `max` characters.
 * @param {{ text: string, truncated: boolean }} page
 * @param {number} max
 */
export function trunc(page, max) {
  const t = page.text.replace(/\n{3,}/g, "\n\n").trim();
  const cut = page.truncated || t.length > max;
  const text = t.length > max ? `${t.slice(0, max).trimEnd()} …` : t;
  return { text, total: `${t.length}${page.truncated ? "+" : ""}`, cut };
}

