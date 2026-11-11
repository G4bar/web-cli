# Changelog

## [0.2.0] - 2026-11-11

### Added

- `web research "<question>" --max-cost <usd>`: paid, asynchronous deep research. Exa Agent by default (`--effort`, `--schema`), TinyFish Research as a fallback (`--mode deep|max`). `--max-cost` is mandatory and checked before anything is sent. Blocks with a backoff poll up to `--wait` minutes (default 15) and exits 4 if the run is still going; `--detach` returns the run id at once. `web research status <id>` and `web research cancel <id>`, with provider-prefixed ids (`exa:...`, `tinyfish:...`). Fallback happens only when *starting* a run fails and no run can exist (HTTP 401/402/403/404/429/503 or a connection that was never established); a timeout, a dropped connection or a 500/502/504 may hide a run that did start, so they are not retried on the other provider (that could pay twice).
- `web answer --deep` (`--fast` for deep-lite): synthesis through Exa deep search, with the cited sources from the grounding, deduplicated.
- `--schema <file|json>` on `answer` and `research`: structured output printed as JSON. Exa's `/search` schema limits (10 properties, 2 levels, arrays need `items`) are checked locally for `--deep`.
- `--goal "<text>"` on `search` and `fetch` (Exa `objective`, TinyFish `purpose`), `--country` / `--lang` (Exa `userLocation`, TinyFish `location` / `language`).
- `fetch --fresh` (live content) and `fetch --links` (outbound links: http(s) only, no `#fragment` links, deduplicated, capped at 100).
- TinyFish search paginates until `-n` results (deduplicated by URL).
- Tests (`npm test`, mocked `fetch`, no network) and type checking (`npm run check`, `tsc --checkJs`).

### Changed

- **HTTP 400 and 422 no longer fall back.** They are caller errors: the provider's message is printed and the exit code is 2. Before, for example `web search x --cat company --recent 30d` was silently answered by TinyFish with exit 0.
- Mistakes Exa would reject are caught before any request (exit 2): an unknown `--type`, `--cat company|people` with date filters, `--cat people` with `--exclude`, impossible dates, `--since` after `--until`, `--recent 0d`.
- Flags a provider cannot honour are reported on stderr when it serves the request (`--type`, `--chars`, `--cat company|people|personal|financial` on TinyFish; `--lang` on Exa; search filters on Exa `/answer`).
- `--cat papers` on TinyFish maps `--since` / `--until` / `--recent` to publication years instead of dropping them.
- `WEB_TIMEOUT_MS` applies to every command; before, `fetch` used hard-coded 60 s / 90 s. Defaults are unchanged when it is unset. TinyFish `per_url_timeout_ms` is sent below the client timeout so one slow URL cannot abort a batch.
- Per-URL fetch failures from Exa are now listed on stderr.
- The code moved from a single file to `skills/web/lib/`. The entry point `skills/web/web.mjs` and the CLI contract are unchanged.
- `engines.node` is now `>=22` (Node 20 is end of life).

### Fixed

- Docs: `--type deep` and `deep-lite` on `search` return ranked results only, they do not synthesize an answer (use `answer --deep`).

## [0.1.0] - 2026-11-11

- Initial release: `web search`, `web fetch` and `web answer` with Exa and automatic TinyFish fallback.
