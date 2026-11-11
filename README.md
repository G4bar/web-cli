# web-cli

Web search, page fetch, cited answers and (optionally, paid) deep research from the command line, built for coding agents.
Uses [Exa](https://exa.ai) first and falls back to [TinyFish](https://www.tinyfish.ai) automatically.

- **Zero runtime dependencies.** Node 22+ and `fetch`, nothing to install. Plain `.mjs`, no build step.
- **Deterministic fallback.** If Exa is down, times out, returns nothing or has no key, the same request goes to TinyFish. A request Exa rejects as invalid (HTTP 400/422) is reported, not silently retried elsewhere. The agent never has to decide.
- **Token-friendly.** Compact output, per-page truncation, `--focus` to keep only the relevant passages.
- **Progressive disclosure.** Ships as an [Agent Skill](https://agentskills.io): the agent pays for a one-line description until it actually needs the tool, instead of carrying MCP tool schemas in every session.

```text
$ web search "pi coding agent extensions skills" -n 2 --chars 150
# pi coding agent extensions skills — exa, 2 results, $0.007

1. Package Catalog · Pi
   https://pi.dev/packages
   # Package Catalog Extensions, skills, prompt templates, and themes published to npm. ...

2. Extensions
   https://pi.dev/docs/latest/extensions
   can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, ...
```

## Install

You need at least one API key (both is better, that is what makes the fallback work):

```bash
export EXA_API_KEY=...        # https://dashboard.exa.ai/api-keys
export TINYFISH_API_KEY=...   # https://agent.tinyfish.ai/api-keys
```

### The CLI

```bash
npm install -g github:G4bar/web-cli
web --help
```

Or clone it and symlink `skills/web/web.mjs` anywhere on your `PATH` as `web`.

### The agent skill

[Pi](https://pi.dev):

```bash
pi install git:github.com/G4bar/web-cli
```

Other agents that read `SKILL.md` files: copy or symlink `skills/web/` into their skills directory.
Agents without skills: point them at `skills/web/SKILL.md` or at `web --help`.

## Usage

```bash
web search "query" [-n 8] [--site a.com,b.org] [--exclude x.com] [--recent 7d] [--cat news|papers|...] [--goal "..."] [--country US] [--lang en]
web fetch  <url...> [--max 8000] [--focus "what you need"] [--fresh] [--links]
web answer "question" [--deep [--fast]] [--schema file.json|'{...}']
web research "question" --max-cost 1 [--effort low] [--wait 15] [--detach]   # paid, see below
web research status <id>   |   web research cancel <id>
```

| Command | What it does |
|---|---|
| `search` | Ranked results with title, URL, date and a short excerpt. |
| `fetch` | Page as markdown, up to 10 URLs per call. `--focus` returns only the matching passages; `--max` caps the size; `--fresh` bypasses the cache; `--links` appends the page's outbound links. |
| `answer` | Short answer with citations (Exa `/answer`). `--deep` synthesizes with Exa deep search instead, `--schema` returns structured JSON. On TinyFish, which has no answer endpoint, it returns search results instead. |
| `research` | **Paid**, asynchronous deep research with a cited report (Exa Agent, TinyFish Research as fallback). Needs `--max-cost`. See [Research](#research-paid). |

Options:

| Flag | Meaning |
|---|---|
| `-n <num>` | Number of results (default 8) |
| `--site`, `--exclude` | Comma-separated domains to keep or drop |
| `--recent 12h\|7d\|2w` | Freshness window |
| `--since`, `--until YYYY-MM-DD` | Date bounds (not combinable with `--recent`) |
| `--cat <c>` | `news`, `papers`, `company`, `people`, `personal`, `financial` (the last four are Exa-only) |
| `--type <t>` | Exa only: `auto` (default), `lite`, `deep-lite`, `deep`. The `deep*` types return ranked results only, with no synthesized answer. |
| `--chars <num>` | Excerpt size per result (default 600) |
| `--goal "<text>"` | What you are after, in a sentence. Search: Exa `objective` / TinyFish `purpose`. Fetch: TinyFish `purpose` (Exa has no equivalent and says so). Max 2000 characters |
| `--country XX`, `--lang xx` | Localisation. `--country` is Exa `userLocation` / TinyFish `location`; `--lang` is TinyFish `language` only (Exa has no language filter and says so) |
| `--max <num>` | Max characters per fetched page (default 8000) |
| `--focus "<text>"` | Keep only the passages most relevant to this text |
| `--fresh` | `fetch`: live content, not the cache (Exa `maxAgeHours: 0`, TinyFish `ttl: 0`) |
| `--links` | `fetch`: list the page's outbound links after its text: http(s) only, `#fragment` links dropped, deduplicated, first 100 (Exa `extras.links` / TinyFish `links`) |
| `--deep`, `--fast` | `answer`: Exa deep search (`type: deep`, or `deep-lite` with `--fast`) with a synthesized answer and its cited sources, instead of `/answer`. Honours the search filters (`--site`, `--recent`, ...), which `/answer` ignores |
| `--schema <file\|json>` | `answer`: structured answer printed as JSON. A JSON Schema file or inline JSON with `"type": "object"`. With `--deep` Exa's limits apply and are checked locally: at most 10 properties in total, 2 levels of nesting (an array counts as one), every array needs `items` |
| `-p, --provider <p>` | `exa` or `tinyfish`: force one provider, no fallback |
| `--json` | Normalized JSON on stdout |

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `EXA_API_KEY`, `TINYFISH_API_KEY` | | Provider credentials. A provider without a key is skipped. |
| `WEB_PROVIDERS` | `exa,tinyfish` | Provider order |
| `WEB_TIMEOUT_MS` | `30000` (`fetch`: 60000 on Exa, 90000 on TinyFish) | Per-request timeout, applies to every command |

Results go to stdout; provider errors and fallback notices go to stderr, so an agent sees when a fallback happened.

Exit codes: `0` ok, `1` every provider failed (or a research run failed), `2` bad usage or a request the provider rejected (HTTP 400/422), `3` `fetch` partially failed (failed URLs are listed on stderr), `4` `research` is still running.

## How the fallback works

- Providers are tried in order. The first one that answers with a non-empty result wins.
- Any provider failure moves on to the next: missing key, HTTP 401/402/403/404/408/429/5xx, timeout, network failure, invalid JSON. An empty search result moves on too, and is returned only if nobody does better.
- **HTTP 400 and 422 do not fall back.** They mean the request itself is wrong (for example an unsupported filter combination), so another provider would only hide the mistake: the provider's message is printed and the exit code is 2.
- Obvious mistakes are caught before any request: an unknown `--type`, `--cat company|people` with date filters, `--cat people` with `--exclude`, impossible dates. These fail with exit 2 and no network call.
- When TinyFish serves a request, every flag it cannot honour (`--type`, `--chars`, `--cat company|people|personal|financial`) is reported on stderr instead of being dropped silently.
- `fetch` falls back per URL: URLs Exa could not read are retried on TinyFish, the others are kept.

## Research (paid)

`web research` runs a multi-step agent that searches, reads and writes a cited report. It is **not free** and takes seconds to many minutes, so use it deliberately.

```bash
web research "How do the main vector databases compare on filtered search?" --max-cost 1
web research "..." --max-cost 5 --effort high            # Exa: more thorough, $0.50 per run
web research "..." --max-cost 3 -p tinyfish --mode max   # TinyFish Research
web research "..." --max-cost 1 --detach                 # start, print the id, exit 0
web research status exa:agent_run_...                    # state / report of a run
web research cancel exa:agent_run_...
```

| Flag | Meaning |
|---|---|
| `--max-cost <usd>` | **Required.** The most you are willing to spend. Without it the command exits 2 and nothing is started. |
| `-p exa\|tinyfish` | Default: Exa; TinyFish only if the run cannot be *started* on Exa. |
| `--effort <e>` | Exa Agent: `minimal` ($0.012 per run), `low` ($0.025, default), `medium` ($0.10), `high` ($0.50), `xhigh` ($1.00), `auto` / `ultra` (metered, up to `--max-cost`). |
| `--mode <m>` | TinyFish Research: `deep` ($2, default) or `max` ($3). |
| `--schema <file\|json>` | Exa only: structured output (printed as JSON). TinyFish Research has no structured output and is skipped when a schema is given. |
| `--wait <minutes>` | How long to wait for the result (default 15). |
| `--detach` | Start the run, print its id and exit 0. |
| `--json` | The normalized run as JSON. |

**Cost rules.** `--max-cost` is checked before anything is sent. Exa's `budget.maxCostDollars` accepts $1 to $100, so `--max-cost` must be at least 1 for Exa (for a fixed effort the budget only caps optional contact enrichment and must cover the effort's price; for `auto` and `ultra` it caps the whole run). TinyFish Research costs $2 (`deep`) or $3 (`max`), charged when a run completes, so it is refused when `--max-cost` is lower. A provider that cannot run within `--max-cost` is refused with the reason (exit 2 when none can, or when you forced it with `-p`). TinyFish reports no cost in its responses: completed runs are shown at list price, failed, cancelled and timed-out runs as not charged.

**Run ids** are prefixed with the provider, `exa:<id>` or `tinyfish:<id>`; `status` and `cancel` route by the prefix. The id is printed on stderr the moment the run starts, before any waiting.

**Waiting.** By default the command blocks, polling with backoff (5 s growing to 30 s) and writing progress to stderr. If the run is not finished after `--wait` minutes it prints the id and how to resume, leaves the run going, and exits **4**. `web research status <id>` exits 0 when completed, 4 while running, 1 when the run failed, was cancelled or timed out. Giving up waiting never cancels a run; `web research cancel <id>` does (Exa bills what accrued up to that point).

**Fallback only happens when starting a run fails**, and only when it is certain that no run exists: the provider refused with an HTTP error other than 400/422 (typically 401, 402, 403, 429 or 5xx) or the connection could not be established. HTTP 400/422 exit 2. A start that **times out or drops the connection** may have created a run, so it is *not* retried on the other provider (that could pay twice); the error says so. Once a run has started there is no fallback: a failing poll is retried a few times, then the command exits 1 with the id so you can resume later.

Output: the report, then its sources, then cost and the stop reason (Exa `stopReason`, e.g. `schema_satisfied`; TinyFish `termination_reason`, e.g. `planner_done`; `synthesis_failed` means interim findings only).

## Provider differences

| | Exa | TinyFish |
|---|---|---|
| Search | Semantic, excerpts picked for the query, all filters and categories | Ranked web results with snippets (up to `-n`, fetched in pages of 10), `news` and `papers` categories. For `papers`, `--since/--until/--recent` apply to the publication year |
| Fetch `--focus` | Semantic highlights | Local keyword-based passage filter on the full page |
| Answer | Yes (`/answer`, or deep search with `--deep`) | No (search results instead) |
| Links (`fetch --links`) | The links Exa extracts from the page (in a spot check 4, where TinyFish listed 26) | Every `<a href>` on the page |
| Research | Agent API, $0.012 to $1.00 per run by effort, or metered | Research API, $2 / $3 per run, charged on completion (the pricing page also mentions free runs per day; `--max-cost` is always checked against the list price) |
| Cost | Paid per request (about $0.007 per search, $0.005 per answer, $0.012 for a deep answer) | Search and fetch free within a daily allowance, see [their pricing](https://www.tinyfish.ai/pricing) |

Check each provider's docs for current limits and pricing: [Exa](https://exa.ai/docs), [TinyFish](https://docs.tinyfish.ai/).

## Why a CLI and a skill

A search tool does not need to sit in the model's context all session. A CLI is composable (`web fetch URL > /tmp/page.md`, `web search ... --json | jq`) and a skill is only loaded when relevant. The reasoning is laid out in Mario Zechner's posts [What if you don't need MCP at all?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) and [What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).

## Development

No build step and no runtime dependencies. Developed on Node 24, tested on Node 22 and 24 (`engines.node` is `>=22`).

```bash
npm install          # dev tooling only: typescript and @types/node
npm test             # node --test, mocked fetch, no network
npm run check        # tsc --checkJs, must report 0 errors
node skills/web/web.mjs --help
```

`skills/web/web.mjs` is the entry point (npm `bin`, Pi skill, symlinks); the code lives in `skills/web/lib/`: `providers/` (Exa, TinyFish), `commands/`, plus `http`, `fallback`, `args` and `format`.

## License

[MIT](LICENSE)
