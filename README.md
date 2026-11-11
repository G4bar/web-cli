# web-cli

Web search, page fetch and cited answers from the command line, built for coding agents.
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
web search "query" [-n 8] [--site a.com,b.org] [--exclude x.com] [--recent 7d] [--cat news|papers|...]
web fetch  <url...> [--max 8000] [--focus "what you need"]
web answer "question"
```

| Command | What it does |
|---|---|
| `search` | Ranked results with title, URL, date and a short excerpt. |
| `fetch` | Page as markdown, up to 10 URLs per call. `--focus` returns only the matching passages; `--max` caps the size. |
| `answer` | Short answer with citations (Exa). On TinyFish, which has no answer endpoint, it returns search results instead. |

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
| `--max <num>` | Max characters per fetched page (default 8000) |
| `--focus "<text>"` | Keep only the passages most relevant to this text |
| `-p, --provider <p>` | `exa` or `tinyfish`: force one provider, no fallback |
| `--json` | Normalized JSON on stdout |

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `EXA_API_KEY`, `TINYFISH_API_KEY` | | Provider credentials. A provider without a key is skipped. |
| `WEB_PROVIDERS` | `exa,tinyfish` | Provider order |
| `WEB_TIMEOUT_MS` | `30000` (`fetch`: 60000 on Exa, 90000 on TinyFish) | Per-request timeout, applies to every command |

Results go to stdout; provider errors and fallback notices go to stderr, so an agent sees when a fallback happened.

Exit codes: `0` ok, `1` every provider failed, `2` bad usage or a request the provider rejected (HTTP 400/422), `3` `fetch` partially failed (failed URLs are listed on stderr).

## How the fallback works

- Providers are tried in order. The first one that answers with a non-empty result wins.
- Any provider failure moves on to the next: missing key, HTTP 401/402/403/404/408/429/5xx, timeout, network failure, invalid JSON. An empty search result moves on too, and is returned only if nobody does better.
- **HTTP 400 and 422 do not fall back.** They mean the request itself is wrong (for example an unsupported filter combination), so another provider would only hide the mistake: the provider's message is printed and the exit code is 2.
- Obvious mistakes are caught before any request: an unknown `--type`, `--cat company|people` with date filters, `--cat people` with `--exclude`, impossible dates. These fail with exit 2 and no network call.
- When TinyFish serves a request, every flag it cannot honour (`--type`, `--chars`, `--cat company|people|personal|financial`) is reported on stderr instead of being dropped silently.
- `fetch` falls back per URL: URLs Exa could not read are retried on TinyFish, the others are kept.

## Provider differences

| | Exa | TinyFish |
|---|---|---|
| Search | Semantic, excerpts picked for the query, all filters and categories | Ranked web results with snippets (up to `-n`, fetched in pages of 10), `news` and `papers` categories. For `papers`, `--since/--until/--recent` apply to the publication year |
| Fetch `--focus` | Semantic highlights | Local keyword-based passage filter on the full page |
| Answer | Yes | No (search results instead) |
| Cost | Paid per request (about $0.007 per search, $0.005 per answer) | Free daily allowance, see [their pricing](https://www.tinyfish.ai/pricing) |

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
