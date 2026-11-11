// @ts-check
import { withFallback } from "../fallback.mjs";
import { printJson, printResults } from "../format.mjs";
import { providerOrder } from "../providers/index.mjs";

/** @typedef {import("../types.mjs").Ctx} Ctx */
/** @typedef {import("../types.mjs").Opts} Opts */

/**
 * @param {Ctx} ctx
 * @param {string} q
 * @param {Opts} o
 */
export async function search(ctx, q, o) {
  const r = await withFallback(ctx, providerOrder(ctx, o.provider), "search", o, (p) => p.search(ctx, q, o), (x) => !x.results.length);
  if (o.json) return printJson(ctx, { query: q, provider: r.provider, cost: r.cost, results: r.results });
  if (!r.results.length) return ctx.out(`# ${q} — ${r.provider}, 0 results`);
  printResults(ctx, q, r.provider, r.results, r.cost);
}
