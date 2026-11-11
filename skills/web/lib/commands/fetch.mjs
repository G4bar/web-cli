// @ts-check
import { EXIT, ExitError, UsageError, isCallerError, messageOf } from "../errors.mjs";
import { asCallerFailure, preflight, warnIgnored } from "../fallback.mjs";
import { printJson, trunc } from "../format.mjs";
import { providerOrder } from "../providers/index.mjs";
import { log } from "../util.mjs";

/** @typedef {import("../types.mjs").Ctx} Ctx */
/** @typedef {import("../types.mjs").Opts} Opts */
/** @typedef {import("../types.mjs").Page} Page */

/**
 * @param {Ctx} ctx
 * @param {string[]} urls
 * @param {Opts} o
 */
export async function fetchPages(ctx, urls, o) {
  if (urls.length > 10) throw new UsageError("max 10 URLs per call");
  const bad = urls.find((u) => !/^https?:\/\//i.test(u) || !URL.canParse(u) || u.length > 2048);
  if (bad) throw new UsageError(`not an http(s) URL: ${bad}`);

  const order = providerOrder(ctx, o.provider);
  preflight(order, "fetch", o);
  /** @type {Map<string, Page & { provider: string }>} */
  const done = new Map();
  let pending = [...urls];
  /** @type {string[]} */
  const errs = [];
  for (const p of order) {
    if (!pending.length) break;
    if (!p.ready(ctx)) {
      errs.push(`${p.name}: ${p.keyName} not set`);
      log(ctx, `${p.name}: skipped (${p.keyName} not set)`);
      continue;
    }
    warnIgnored(ctx, p, "fetch", o);
    try {
      const { pages } = await p.fetch(ctx, pending, o);
      for (const [u, page] of pages) done.set(u, { ...page, provider: p.name });
      pending = pending.filter((u) => !pages.has(u));
      if (pending.length && order.at(-1) !== p) log(ctx, `${p.name}: ${pending.length} URL(s) failed, trying next provider`);
    } catch (e) {
      if (isCallerError(e)) throw asCallerFailure(p, e);
      errs.push(`${p.name}: ${messageOf(e)}`);
      log(ctx, `${p.name} failed: ${messageOf(e)}`);
    }
  }

  const out = urls.filter((u) => done.has(u)).map((u) => /** @type {Page & { provider: string }} */ (done.get(u)));
  if (o.json) {
    printJson(ctx, { pages: out.map((x) => ({ ...x, text: trunc(x, o.max).text })), failed: pending, errors: errs });
  } else {
    for (const page of out) {
      const { text, total, cut } = trunc(page, o.max);
      const meta = [page.provider, `${total} chars`, cut ? `truncated to ${o.max} — use --max N or --focus "..."` : null].filter(Boolean).join(", ");
      ctx.out(`## ${page.url}${page.title ? ` — ${page.title}` : ""}  [${meta}]\n\n${text}\n`);
    }
  }
  for (const u of pending) log(ctx, `FAILED ${u}`);
  if (pending.length) throw new ExitError(out.length ? EXIT.PARTIAL : EXIT.FAILED);
}
