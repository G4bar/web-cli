// @ts-check
import { EXIT, ExitError, isCallerError, messageOf } from "../errors.mjs";
import { asCallerFailure, preflight, warnIgnored } from "../fallback.mjs";
import { printJson, printResults, printSources } from "../format.mjs";
import { providerOrder } from "../providers/index.mjs";
import { log } from "../util.mjs";

/** @typedef {import("../types.mjs").Ctx} Ctx */
/** @typedef {import("../types.mjs").Opts} Opts */

/**
 * `web answer`: Exa `/answer`; providers without an answer endpoint return plain
 * search results instead.
 *
 * @param {Ctx} ctx
 * @param {string} q
 * @param {Opts} o
 */
export async function answer(ctx, q, o) {
  const order = providerOrder(ctx, o.provider);
  preflight(order, "answer", o);

  /** @type {string[]} */
  const errs = [];
  for (const p of order) {
    if (!p.ready(ctx)) {
      errs.push(`${p.name}: ${p.keyName} not set`);
      log(ctx, `${p.name}: skipped (${p.keyName} not set)`);
      continue;
    }
    warnIgnored(ctx, p, "answer", o);
    try {
      if (p.answer) {
        const r = await p.answer(ctx, q, o);
        if (o.json) return printJson(ctx, { query: q, provider: p.name, ...r });
        ctx.out(`# ${q} — ${p.name}${r.cost ? `, $${r.cost}` : ""}\n\n${r.answer}`);
        return printSources(ctx, r.citations);
      }
      log(ctx, `${p.name}: no answer endpoint, returning search results instead`);
      const r = await p.search(ctx, q, o);
      if (o.json) return printJson(ctx, { query: q, provider: p.name, results: r.results });
      return printResults(ctx, q, p.name, r.results, r.cost);
    } catch (e) {
      if (isCallerError(e)) throw asCallerFailure(p, e);
      errs.push(`${p.name}: ${messageOf(e)}`);
      log(ctx, `${p.name} failed: ${messageOf(e)}`);
    }
  }
  throw new ExitError(EXIT.FAILED, `all providers failed\n  ${errs.join("\n  ")}`);
}
