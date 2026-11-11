// @ts-check
import { HELP, parseCli } from "./args.mjs";
import { answer } from "./commands/answer.mjs";
import { fetchPages } from "./commands/fetch.mjs";
import { search } from "./commands/search.mjs";
import { EXIT, ExitError, UsageError } from "./errors.mjs";
import { log } from "./util.mjs";

/** @typedef {import("./types.mjs").Ctx} Ctx */

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Context backed by the real process: env, stdout/stderr, timers, clock.
 * `WEB_TIMEOUT_MS` is validated here once; an invalid value is reported and ignored.
 * @returns {Ctx}
 */
export function realCtx() {
  /** @type {Ctx} */
  const ctx = {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    timeout: undefined,
  };
  ctx.timeout = parseTimeout(ctx);
  return ctx;
}

/** @param {Ctx} ctx */
export function parseTimeout(ctx) {
  const raw = ctx.env.WEB_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    log(ctx, `ignoring WEB_TIMEOUT_MS="${raw}" (expected a number of milliseconds >= 1)`);
    return undefined;
  }
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

/**
 * Run the CLI; resolves to the exit code (never calls process.exit).
 * @param {string[]} argv
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
export async function main(argv, ctx) {
  try {
    const { helpExit, cmd, rest, opts, warnings } = parseCli(argv);
    if (helpExit !== undefined) {
      ctx.out(HELP);
      return helpExit;
    }
    for (const w of warnings) log(ctx, w);

    switch (cmd) {
      case "search":
      case "answer": {
        const q = rest.join(" ").trim();
        if (!q) throw new UsageError(`usage: web ${cmd} <${cmd === "search" ? "query" : "question"}>`);
        await (cmd === "search" ? search : answer)(ctx, q, opts);
        break;
      }
      case "fetch":
        if (!rest.length) throw new UsageError("usage: web fetch <url...>");
        await fetchPages(ctx, rest, opts);
        break;
      default:
        throw new UsageError(`unknown command "${cmd}" (search | fetch | answer). See: web --help`);
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof ExitError) {
      if (e.message) log(ctx, e.message);
      return e.code;
    }
    if (e instanceof UsageError) {
      log(ctx, e.message);
      return EXIT.USAGE;
    }
    log(ctx, `unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    return EXIT.FAILED;
  }
}
