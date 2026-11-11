// @ts-check
import { parseArgs } from "node:util";
import { UsageError } from "./errors.mjs";
import { flagName, list } from "./util.mjs";
import { EXA_CAT, EXA_LEGACY_TYPES, EXA_TYPES } from "./providers/exa.mjs";

/** @typedef {import("./types.mjs").Opts} Opts */

export const HELP = `web — web search & page fetch (Exa, falls back to TinyFish)

USAGE
  web search <query> [options]     ranked results + short excerpts
  web fetch  <url...> [options]    page content as markdown (max 10 URLs)
  web answer <question>            cited answer (Exa; falls back to search results)

SEARCH OPTIONS
  -n <num>            results (default 8)
  --site a.com,b.org  only these domains
  --exclude x.com     skip these domains
  --recent 7d         freshness window: <N>h | <N>d | <N>w
  --since YYYY-MM-DD  --until YYYY-MM-DD
  --cat <c>           news | papers | company | people | personal | financial
  --type <t>          Exa only: auto (default) | lite | deep-lite | deep
                      (deep* returns ranked results only, no synthesis)
  --chars <num>       excerpt size per result (default 600)

FETCH OPTIONS
  --max <num>         max chars per page (default 8000)
  --focus "<text>"    return only the passages most relevant to this text

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
Exit codes: 0 ok, 1 failed, 2 usage / rejected request, 3 fetch partly failed.
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
  provider: { type: "string", short: "p" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

/** Flags that have a meaning for each command; others are reported as ignored. */
const SEARCH_FLAGS = ["n", "site", "exclude", "recent", "since", "until", "cat", "type", "chars"];
const SCOPE = /** @type {Record<string, string[]>} */ ({
  search: [...SEARCH_FLAGS, "provider", "json"],
  answer: [...SEARCH_FLAGS, "provider", "json"],
  fetch: ["max", "focus", "provider", "json"],
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
  const cmd = first;

  /** @type {string[]} */
  const warnings = [];
  const scope = cmd ? SCOPE[cmd] : undefined;
  if (scope) for (const f of given) if (!scope.includes(f)) warnings.push(`${flagName(f)} has no effect on "web ${cmd}"`);

  if (v.help || !cmd) return { helpExit: v.help ? 0 : 2, cmd, rest, opts: /** @type {Opts} */ ({}), warnings };

  if (v.cat && !EXA_CAT[v.cat]) throw new UsageError(`bad --cat "${v.cat}" (${Object.keys(EXA_CAT).join(" | ")})`);
  if (v.type && ![...EXA_TYPES, ...EXA_LEGACY_TYPES].includes(v.type)) throw new UsageError(`bad --type "${v.type}" (${EXA_TYPES.join(" | ")})`);
  if (v.recent && (v.since || v.until)) throw new UsageError("--recent cannot be combined with --since/--until");
  const since = date("--since", v.since);
  const until = date("--until", v.until);
  if (since && until && since > until) throw new UsageError(`--since ${since} is after --until ${until}`);

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
    given,
  };
  return { cmd, rest, opts, warnings };
}
