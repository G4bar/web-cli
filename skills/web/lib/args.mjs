// @ts-check
import { parseArgs } from "node:util";
import { UsageError } from "./errors.mjs";
import { flagName, list } from "./util.mjs";
import { AGENT_EFFORTS, EXA_CAT, EXA_LEGACY_TYPES, EXA_TYPES } from "./providers/exa.mjs";
import { loadSchema } from "./schema.mjs";

/** @typedef {import("./types.mjs").Opts} Opts */

export const HELP = `web — web search & page fetch (Exa, falls back to TinyFish)

USAGE
  web search <query> [options]     ranked results + short excerpts
  web fetch  <url...> [options]    page content as markdown (max 10 URLs)
  web answer <question> [options]  cited answer (Exa; falls back to search results)
  web research <question> --max-cost <usd> [options]
                                   PAID asynchronous deep research (Exa Agent / TinyFish)
  web research status <id>         state / result of a research run
  web research cancel <id>         cancel a research run

SEARCH OPTIONS
  -n <num>            results (default 8)
  --site a.com,b.org  only these domains
  --exclude x.com     skip these domains
  --recent 7d         freshness window: <N>h | <N>d | <N>w
  --since YYYY-MM-DD  --until YYYY-MM-DD
  --cat <c>           news | papers | company | people | personal | financial
  --type <t>          Exa only: auto (default) | lite | deep-lite | deep
                      (deep* return ranked results only; use "answer --deep" for a synthesis)
  --chars <num>       excerpt size per result (default 600)
  --goal "<text>"     what you are after: Exa objective / TinyFish purpose
  --country XX        ISO country for localisation (Exa userLocation / TinyFish location)
  --lang xx           result language (TinyFish only; Exa has no language filter)

FETCH OPTIONS
  --max <num>         max chars per page (default 8000)
  --focus "<text>"    return only the passages most relevant to this text
  --goal "<text>"     why you are fetching (TinyFish purpose; ignored by Exa)
  --fresh             bypass the cache: live content
  --links             also list the page's outbound links (deduped, max 100)

ANSWER OPTIONS (also accepts the search options above)
  --deep              synthesize with Exa deep search instead of /answer
  --fast              with --deep: use deep-lite (faster)
  --schema <f|json>   structured answer: JSON Schema file or inline JSON ("type": "object")

RESEARCH OPTIONS (costs money; see README)
  --max-cost <usd>    REQUIRED spending ceiling (Exa needs >= 1, TinyFish deep 2 / max 3)
  -p exa|tinyfish     provider (default: Exa, TinyFish if the run cannot be started)
  --effort <e>        Exa: minimal | low (default) | medium | high | xhigh | auto | ultra
  --mode <m>          TinyFish: deep (default) | max
  --schema <f|json>   Exa only: structured output
  --wait <minutes>    how long to wait for the result (default 15), then exit 4
  --detach            start the run, print its id and exit 0

COMMON
  -p, --provider <p>  exa | tinyfish: force one provider, no fallback
  --json              normalized JSON instead of text
  -h, --help

ENV
  EXA_API_KEY, TINYFISH_API_KEY
  WEB_PROVIDERS=exa,tinyfish   provider order (default)
  WEB_TIMEOUT_MS=30000         per-request timeout (default 30 s; fetch 60 s Exa / 90 s TinyFish)

Fallback: any provider failure (missing key, HTTP 401/402/403/404/429/5xx, timeout, network,
invalid response, empty search result) moves on to the next provider. HTTP 400/422 mean the
request itself is wrong: no fallback, exit 2.
Exit codes: 0 ok, 1 failed, 2 usage / rejected request, 3 fetch partly failed, 4 research still running.
Errors go to stderr; results to stdout.`;

const OPTIONS = /** @type {const} */ ({
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
  goal: { type: "string" },
  country: { type: "string" },
  lang: { type: "string" },
  deep: { type: "boolean" },
  fast: { type: "boolean" },
  schema: { type: "string" },
  fresh: { type: "boolean" },
  links: { type: "boolean" },
  "max-cost": { type: "string" },
  effort: { type: "string" },
  mode: { type: "string" },
  wait: { type: "string" },
  detach: { type: "boolean" },
  provider: { type: "string", short: "p" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

/** Flags that have a meaning for each command; others are reported as ignored. */
const SEARCH_FLAGS = ["n", "site", "exclude", "recent", "since", "until", "cat", "type", "chars", "goal", "country", "lang"];
const SCOPE = /** @type {Record<string, string[]>} */ ({
  search: [...SEARCH_FLAGS, "provider", "json"],
  answer: [...SEARCH_FLAGS, "deep", "fast", "schema", "provider", "json"],
  fetch: ["max", "focus", "goal", "fresh", "links", "provider", "json"],
  research: ["max-cost", "effort", "mode", "schema", "wait", "detach", "provider", "json"],
  status: ["json"],
  cancel: ["json"],
});

/** Parse `5h`, `7d`, `2w` into minutes. */
function parseDuration(/** @type {string} */ s) {
  const m = /^(\d+)([hdw])$/.exec(s);
  const mult = { h: 60, d: 1440, w: 10080 };
  if (!m || Number(m[1]) === 0) throw new UsageError(`bad --recent "${s}" (use e.g. 12h, 7d, 2w)`);
  return Number(m[1]) * mult[/** @type {"h" | "d" | "w"} */ (m[2])];
}

/** A real calendar date in YYYY-MM-DD form. */
function date(/** @type {string} */ flag, /** @type {string | undefined} */ s) {
  if (s === undefined) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  if (!ok) throw new UsageError(`bad ${flag} "${s}" (use YYYY-MM-DD)`);
  return s;
}

function int(/** @type {string} */ flag, /** @type {string | undefined} */ s, /** @type {number} */ def, /** @type {number} */ min, /** @type {number} */ max) {
  const v = s === undefined ? def : Number(s);
  if (!Number.isInteger(v) || v < min || v > max) throw new UsageError(`bad ${flag} "${s}" (${min}-${max})`);
  return v;
}

/** Positive finite number. */
function num(/** @type {string} */ flag, /** @type {string | undefined} */ s, /** @type {number} */ max) {
  const v = Number(s);
  if (s === undefined || s.trim() === "" || !Number.isFinite(v) || v <= 0 || v > max) throw new UsageError(`bad ${flag} "${s}" (a number > 0 and <= ${max})`);
  return v;
}

/**
 * Parse argv into a command, its positional arguments and validated options.
 * Throws UsageError for anything invalid; never touches the network.
 *
 * @param {string[]} argv
 * @returns {{ helpExit?: number, cmd?: string, rest: string[], opts: Opts, warnings: string[] }}  `helpExit` is set when the help text is to be shown (0: asked for, 2: no command)
 */
export function parseCli(argv) {
  /** @type {ReturnType<typeof parseArgs<{ options: typeof OPTIONS, allowPositionals: true }>>} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : e}\n\n${HELP}`);
  }
  const { values: v, positionals } = parsed;
  const [first, ...rest] = positionals;
  const given = new Set(Object.keys(v).filter((k) => k !== "help"));
  // "research status|cancel <id>" are sub-commands: the question must be quoted as one argument.
  const sub = first === "research" && (rest[0] === "status" || rest[0] === "cancel") ? /** @type {"status" | "cancel"} */ (rest[0]) : undefined;
  const cmd = sub ?? first;

  /** @type {string[]} */
  const warnings = [];
  const scope = cmd ? SCOPE[cmd] : undefined;
  const shown = sub ? `research ${sub}` : cmd;
  if (scope) for (const f of given) if (!scope.includes(f)) warnings.push(`${flagName(f)} has no effect on "web ${shown}"`);

  if (v.help || !cmd) return { helpExit: v.help ? 0 : 2, cmd, rest, opts: /** @type {Opts} */ ({}), warnings };

  if (v.cat && !EXA_CAT[v.cat]) throw new UsageError(`bad --cat "${v.cat}" (${Object.keys(EXA_CAT).join(" | ")})`);
  if (v.type && ![...EXA_TYPES, ...EXA_LEGACY_TYPES].includes(v.type)) throw new UsageError(`bad --type "${v.type}" (${EXA_TYPES.join(" | ")})`);
  if (v.recent && (v.since || v.until)) throw new UsageError("--recent cannot be combined with --since/--until");
  const since = date("--since", v.since);
  const until = date("--until", v.until);
  if (since && until && since > until) throw new UsageError(`--since ${since} is after --until ${until}`);
  if (v.fast && !v.deep) throw new UsageError("--fast only applies together with --deep");
  if (v.goal !== undefined && (!v.goal.trim() || v.goal.length > 2000)) throw new UsageError("--goal must be 1-2000 characters");
  if (v.country !== undefined && !/^[A-Za-z]{2}$/.test(v.country)) throw new UsageError(`bad --country "${v.country}" (two-letter ISO code, e.g. US)`);
  if (v.lang !== undefined && !/^[A-Za-z]{2}$/.test(v.lang)) throw new UsageError(`bad --lang "${v.lang}" (two-letter code, e.g. en)`);
  if (v.effort !== undefined && !AGENT_EFFORTS.includes(v.effort)) throw new UsageError(`bad --effort "${v.effort}" (${AGENT_EFFORTS.join(" | ")})`);
  if (v.mode !== undefined && v.mode !== "deep" && v.mode !== "max") throw new UsageError(`bad --mode "${v.mode}" (deep | max)`);

  /** @type {Opts} */
  const opts = {
    n: int("-n", v.n, 8, 1, 50),
    chars: int("--chars", v.chars, 600, 100, 5000),
    max: int("--max", v.max, 8000, 200, 200_000),
    site: list(v.site),
    exclude: list(v.exclude),
    recentMin: v.recent ? parseDuration(v.recent) : undefined,
    since,
    until,
    cat: v.cat,
    type: v.type,
    focus: v.focus?.trim() || undefined,
    provider: v.provider,
    json: !!v.json,
    goal: v.goal?.trim(),
    country: v.country?.toUpperCase(),
    lang: v.lang?.toLowerCase(),
    deep: !!v.deep,
    fast: !!v.fast,
    fresh: !!v.fresh,
    links: !!v.links,
    maxCost: v["max-cost"] === undefined ? undefined : num("--max-cost", v["max-cost"], 100),
    effort: v.effort,
    mode: v.mode,
    waitMin: v.wait === undefined ? 15 : num("--wait", v.wait, 240),
    detach: !!v.detach,
    given,
  };
  // The schema is only read where it is used, so a stray --schema elsewhere is just a warning.
  if (v.schema !== undefined && (cmd === "answer" || cmd === "research")) opts.schema = loadSchema(v.schema);
  return { cmd, rest: sub ? rest.slice(1) : rest, opts, warnings };
}
