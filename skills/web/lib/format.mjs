// @ts-check
/** @typedef {import("./types.mjs").Ctx} Ctx */
/** @typedef {import("./types.mjs").SearchResult} SearchResult */
/** @typedef {import("./types.mjs").Citation} Citation */
/** @typedef {import("./types.mjs").ResearchRun} ResearchRun */

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

/** Answer body: a string as is, a structured answer as JSON. */
export const answerBody = (/** @type {string | Record<string, any>} */ a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2));

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

/**
 * Cost part of a run header. A TinyFish run reports no cost: completed runs are shown at list
 * price ("~"), failed / cancelled / timed-out ones are not charged.
 * @param {number | undefined} cost
 * @param {boolean} estimated
 */
const runCost = (cost, estimated) => {
  if (cost === undefined) return "";
  if (!estimated) return `, $${cost}`;
  return cost === 0 ? ", not charged" : `, ~$${cost} (list price)`;
};

/**
 * Final or intermediate state of a research run, as text.
 * @param {Ctx} ctx
 * @param {ResearchRun} run
 * @param {string} [title]
 */
export function printRun(ctx, run, title) {
  const head = `# ${title ?? "research"} — ${run.provider}, ${run.status}${runCost(run.cost, run.costEstimated)}${run.reason ? `, ${run.reason}` : ""}`;
  ctx.out(head);
  ctx.out(`id: ${run.id}`);
  if (run.error) ctx.out(`error: ${run.error}`);
  if (run.structured !== undefined && run.structured !== null) ctx.out(`\n${JSON.stringify(run.structured, null, 2)}`);
  else if (run.text) ctx.out(`\n${run.text.trim()}`);
  if (run.sources.length) printSources(ctx, run.sources);
}
