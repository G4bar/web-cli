// @ts-check
import { ExitError, EXIT, UsageError, isCallerError, messageOf } from "./errors.mjs";
import { log } from "./util.mjs";

/** @typedef {import("./types.mjs").Ctx} Ctx */
/** @typedef {import("./types.mjs").Opts} Opts */
/** @typedef {import("./types.mjs").Op} Op */
/** @typedef {import("./types.mjs").Provider} Provider */

/**
 * Check the request against every provider in the order, before any network call.
 * Throws UsageError (exit 2) when a provider is certain to reject it. Providers
 * without a key are checked too, so the verdict does not depend on which keys are set;
 * `-p` / WEB_PROVIDERS narrow the list.
 * @param {Provider[]} order
 * @param {Op} op
 * @param {Opts} o
 */
export function preflight(order, op, o) {
  for (const p of order) p.validate(op, o);
}

/**
 * A provider's answer that we cannot use, with the reason it is skipped.
 * HTTP 400/422 are not "provider failures": the request is wrong, so they abort the
 * command with exit 2 instead of being retried elsewhere.
 *
 * @param {Provider} p
 * @param {unknown} e
 */
export function asCallerFailure(p, e) {
  return new UsageError(`${p.name} rejected the request: ${messageOf(e)}`);
}

/**
 * Log, once per flag, what the provider is about to ignore.
 * @param {Ctx} ctx
 * @param {Provider} p
 * @param {Op} op
 * @param {Opts} o
 */
export function warnIgnored(ctx, p, op, o) {
  for (const w of p.ignored(op, o)) log(ctx, `${p.name}: ${w}`);
}

/**
 * Try providers in order; the first one that succeeds with a non-empty result wins.
 * An empty result also moves on to the next provider, but is returned if nobody does better.
 * Fallback applies to everything except caller errors (HTTP 400/422), which exit 2.
 *
 * @template T
 * @param {Ctx} ctx
 * @param {Provider[]} order
 * @param {Op} op
 * @param {Opts} o
 * @param {(p: Provider) => Promise<T>} fn
 * @param {(r: T) => boolean} isEmpty
 * @returns {Promise<T & { provider: string }>}
 */
export async function withFallback(ctx, order, op, o, fn, isEmpty) {
  preflight(order, op, o);
  /** @type {string[]} */
  const errs = [];
  /** @type {(T & { provider: string }) | undefined} */
  let empty;
  for (const p of order) {
    if (!p.ready(ctx)) {
      errs.push(`${p.name}: ${p.keyName} not set`);
      log(ctx, `${p.name}: skipped (${p.keyName} not set)`);
      continue;
    }
    warnIgnored(ctx, p, op, o);
    try {
      const r = { provider: p.name, ...(await fn(p)) };
      if (!isEmpty(r)) return r;
      empty ??= r;
      log(ctx, `${p.name}: 0 results`);
    } catch (e) {
      if (isCallerError(e)) throw asCallerFailure(p, e);
      errs.push(`${p.name}: ${messageOf(e)}`);
      log(ctx, `${p.name} failed: ${messageOf(e)}`);
    }
  }
  if (empty) return empty;
  throw new ExitError(EXIT.FAILED, `all providers failed\n  ${errs.join("\n  ")}`);
}
