// @ts-check
import { EXIT, ExitError, ProviderError, UsageError, isCallerError, messageOf } from "../errors.mjs";
import { asCallerFailure, warnIgnored } from "../fallback.mjs";
import { printJson, printRun } from "../format.mjs";
import { REGISTRY, providerOrder } from "../providers/index.mjs";
import { RESEARCH_PRICE } from "../providers/tinyfish.mjs";
import { fmtDuration, log } from "../util.mjs";

/** @typedef {import("../types.mjs").Ctx} Ctx */
/** @typedef {import("../types.mjs").Opts} Opts */
/** @typedef {import("../types.mjs").Provider} Provider */
/** @typedef {import("../types.mjs").ResearchRun} ResearchRun */

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const isDone = (/** @type {ResearchRun} */ r) => TERMINAL.has(r.status);

/** Poll interval: starts at 5 s, grows by 1.5x up to 30 s. */
export const POLL_START_MS = 5_000;
export const POLL_MAX_MS = 30_000;
/** Consecutive failed polls tolerated before giving up on a run (it keeps running server-side). */
const MAX_POLL_FAILURES = 5;
/** Quiet period between progress lines when nothing changed. */
const PROGRESS_EVERY_MS = 60_000;

/** Errors that prove the request never reached the provider. */
const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * May the same question be started on another provider after this failure?
 * Only when we know no run was created: the provider refused (any HTTP error except
 * 400/422, which `isCallerError` handles) or the connection was never established.
 * A timeout or a dropped connection may hide a run that did start: falling back
 * then could pay for the same question twice.
 *
 * @param {unknown} e
 */
export function safeToFallBack(e) {
  if (!(e instanceof ProviderError)) return false;
  if (e.kind === "http") return true;
  if (e.kind === "network") return !!e.code && CONNECT_ERRORS.has(e.code);
  return e.kind === "bad_response" && e.code === "not_created";
}

/**
 * "exa:abc" -> provider + the provider's own id.
 * @param {string} id
 */
export function parseRunId(id) {
  const i = id.indexOf(":");
  const name = i > 0 ? id.slice(0, i) : "";
  const raw = i > 0 ? id.slice(i + 1) : "";
  const p = REGISTRY[name];
  if (!p || !raw) throw new UsageError(`bad run id "${id}": expected exa:<id> or tinyfish:<id> (as printed when the run started)`);
  return { p, raw };
}

/** Provider ready to be called, or an exit 1 error naming the missing key. */
function readyProvider(/** @type {Ctx} */ ctx, /** @type {Provider} */ p) {
  if (!p.ready(ctx)) throw new ExitError(EXIT.FAILED, `${p.name}: ${p.keyName} not set`);
  return p;
}

/** Turn a provider failure of a status / cancel call into the right exit. */
function failure(/** @type {Provider} */ p, /** @type {unknown} */ e) {
  return isCallerError(e) ? asCallerFailure(p, e) : new ExitError(EXIT.FAILED, `${p.name}: ${messageOf(e)}`);
}

/**
 * Cost of a finished TinyFish run: its status response carries none, so a completed
 * run is shown at the list price of the requested mode (when known).
 */
function withCost(/** @type {ResearchRun} */ run, /** @type {string | undefined} */ mode) {
  if (run.provider === "tinyfish" && run.status === "completed" && run.cost === undefined && mode) run.cost = RESEARCH_PRICE[mode];
  return run;
}

/** Where to find a run again, as two lines or (inline) one. */
const resumeHint = (/** @type {string} */ id, /** @type {string} */ sep = "\n") => `resume: web research status ${id}${sep}cancel: web research cancel ${id}`;

/**
 * `web research <question> --max-cost <usd>`
 * @param {Ctx} ctx
 * @param {string} q
 * @param {Opts} o
 */
export async function startResearch(ctx, q, o) {
  if (o.maxCost === undefined) {
    throw new UsageError("research is paid: --max-cost <usd> is required (Exa needs >= 1; TinyFish deep costs $2, max $3)");
  }
  const order = providerOrder(ctx, o.provider);

  // Refuse before any request: which providers could run this within --max-cost?
  const checks = new Map(order.map((p) => [p.name, p.research.check(o)]));
  const refusals = order.filter((p) => p.ready(ctx)).flatMap((p) => {
    const c = checks.get(p.name);
    return c && !c.ok ? [`${p.name}: ${c.reason}`] : [];
  });
  const usable = order.filter((p) => p.ready(ctx) && checks.get(p.name)?.ok);
  if (refusals.length && (o.provider || !usable.length)) {
    throw new UsageError(`cannot run within --max-cost $${o.maxCost}\n  ${refusals.join("\n  ")}`);
  }

  /** @type {string[]} */
  const errs = [];
  /** @type {ResearchRun | undefined} */
  let run;
  /** @type {Provider | undefined} */
  let used;
  for (const p of order) {
    if (!p.ready(ctx)) {
      errs.push(`${p.name}: ${p.keyName} not set`);
      log(ctx, `${p.name}: skipped (${p.keyName} not set)`);
      continue;
    }
    const c = checks.get(p.name);
    if (c && !c.ok) {
      errs.push(`${p.name}: ${c.reason}`);
      log(ctx, `${p.name}: skipped (${c.reason})`);
      continue;
    }
    warnIgnored(ctx, p, "research", o);
    try {
      run = await p.research.start(ctx, q, o);
      used = p;
      break;
    } catch (e) {
      if (isCallerError(e)) throw asCallerFailure(p, e);
      if (!safeToFallBack(e)) {
        throw new ExitError(
          EXIT.FAILED,
          `${p.name}: ${messageOf(e)}\nThe request may have reached ${p.name} and started a (paid) run, so it was not retried elsewhere. Check the ${p.name} dashboard before trying again.`,
        );
      }
      errs.push(`${p.name}: ${messageOf(e)}`);
      log(ctx, `${p.name} failed to start the run: ${messageOf(e)}`);
    }
  }
  if (!run || !used) throw new ExitError(EXIT.FAILED, `could not start a research run\n  ${errs.join("\n  ")}`);

  // From here on there is no fallback: the run exists and may be costing money.
  const price = checks.get(used.name);
  log(ctx, `started ${run.id} (${used.name}${price?.ok && price.price ? `, ${price.price}` : ""})`);
  log(ctx, resumeHint(run.id, "; "));

  if (o.detach) {
    if (o.json) return printJson(ctx, run);
    ctx.out(`started: ${run.id}\n${resumeHint(run.id)}`);
    return;
  }
  run = await waitForRun(ctx, used, run, o);
  if (!isDone(run)) {
    if (o.json) printJson(ctx, run);
    else ctx.out(`still running after ${o.waitMin} min: ${run.id}\n${resumeHint(run.id)}`);
    throw new ExitError(EXIT.RUNNING);
  }
  finish(ctx, withCost(run, o.mode ?? "deep"), o, q);
}

/**
 * Poll until the run reaches a terminal status or the `--wait` budget is spent.
 * Returns the last known state (not terminal when the budget ran out).
 *
 * @param {Ctx} ctx
 * @param {Provider} p
 * @param {ResearchRun} first
 * @param {Opts} o
 */
export async function waitForRun(ctx, p, first, o) {
  const raw = first.id.slice(first.id.indexOf(":") + 1);
  const t0 = ctx.now();
  const deadline = t0 + o.waitMin * 60_000;
  let run = first;
  let delay = POLL_START_MS;
  let failures = 0;
  let lastStatus = "";
  let lastLine = -Infinity;
  while (!isDone(run)) {
    const left = deadline - ctx.now();
    if (left <= 0) break;
    await ctx.sleep(Math.min(delay, left));
    try {
      run = await p.research.get(ctx, raw);
      failures = 0;
    } catch (e) {
      const status = e instanceof ProviderError ? e.status : undefined;
      const fatal = isCallerError(e) || status === 401 || status === 403 || status === 404;
      if (fatal || ++failures > MAX_POLL_FAILURES) {
        throw new ExitError(EXIT.FAILED, `${p.name}: lost track of ${first.id}: ${messageOf(e)}\nThe run may still be going. ${resumeHint(first.id, "; ")}`);
      }
      log(ctx, `${p.name}: poll failed (${messageOf(e)}), retrying`);
      if (e instanceof ProviderError && e.retryAfterMs) delay = Math.max(delay, Math.min(e.retryAfterMs, POLL_MAX_MS));
      continue;
    }
    const now = ctx.now();
    if (!isDone(run) && (run.status !== lastStatus || now - lastLine >= PROGRESS_EVERY_MS)) {
      log(ctx, `${run.id} ${run.status}, ${fmtDuration(now - t0)} elapsed (waiting up to ${o.waitMin} min)`);
      lastStatus = run.status;
      lastLine = now;
    }
    delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
  }
  return run;
}

/** Print a finished run and set the exit code: 0 only when it completed. */
function finish(/** @type {Ctx} */ ctx, /** @type {ResearchRun} */ run, /** @type {Opts} */ o, /** @type {string | undefined} */ q) {
  if (o.json) printJson(ctx, run);
  else printRun(ctx, run, q);
  if (run.provider === "tinyfish" && run.reason === "synthesis_failed") log(ctx, "tinyfish: final synthesis failed, the report contains interim findings only");
  if (run.status !== "completed") throw new ExitError(EXIT.FAILED);
}

/**
 * `web research status <id>`: exit 0 completed, 4 still running, 1 failed / cancelled.
 * @param {Ctx} ctx
 * @param {string} id
 * @param {Opts} o
 */
export async function researchStatus(ctx, id, o) {
  const { p, raw } = parseRunId(id);
  readyProvider(ctx, p);
  /** @type {ResearchRun} */
  let run;
  try {
    run = await p.research.get(ctx, raw);
  } catch (e) {
    throw failure(p, e);
  }
  if (!isDone(run)) {
    if (o.json) printJson(ctx, run);
    else ctx.out(`# research — ${run.provider}, ${run.status}\nid: ${run.id}\n${resumeHint(run.id)}`);
    throw new ExitError(EXIT.RUNNING);
  }
  finish(ctx, run, o, undefined);
}

/**
 * `web research cancel <id>`
 * @param {Ctx} ctx
 * @param {string} id
 * @param {Opts} o
 */
export async function researchCancel(ctx, id, o) {
  const { p, raw } = parseRunId(id);
  readyProvider(ctx, p);
  /** @type {ResearchRun} */
  let run;
  try {
    run = await p.research.cancel(ctx, raw);
  } catch (e) {
    throw failure(p, e);
  }
  if (o.json) return printJson(ctx, run);
  const note = run.status === "cancelled" ? "cancelled" : `not cancelled: the run is already ${run.status}`;
  ctx.out(`${run.id}: ${note}${run.cost !== undefined && !run.costEstimated ? `, billed $${run.cost}` : ""}`);
}
