---
name: web
description: Search the web, read pages by URL and get cited answers with the `web` CLI (Exa, automatic TinyFish fallback). Use for current information, docs, library or API lookups, news, papers, and whenever you need the content of a URL. Also has a paid `research` command, only for when the user explicitly asks for deep research.
---

# web

CLI on PATH (`web`). Run it through bash.
Output is compact text on stdout; provider errors and fallbacks go to stderr.

## Commands

```bash
web search "query" [-n 8] [--site a.com,b.org] [--exclude x.com] [--recent 7d] [--cat news|papers|company|people|personal|financial] [--goal "what for"]
web fetch  <url...> [--max 8000] [--focus "what you need"] [--fresh] [--links]
web answer "question" [--deep [--fast]] [--schema file.json|'{...}']
```

- `search`: ranked results, each with title, URL, date and a short excerpt. Start here, then `fetch` only the 1-3 pages worth reading.
- `fetch`: page as markdown, up to 10 URLs. Truncated at `--max` chars (the header says when). Prefer `--focus "..."` over raising `--max`: it keeps only the matching passages.
- `answer`: short cited answer for a factual question. `--deep` = slower, multi-step synthesis (`--fast` for lighter); `--schema` = structured JSON answer. Falls back to plain search results when only TinyFish is available.

## Options worth knowing

| Flag | Use |
|---|---|
| `--recent 12h\|7d\|2w`, `--since/--until YYYY-MM-DD` | freshness (for `--cat papers` on TinyFish: by publication year) |
| `--site` / `--exclude` | restrict or drop domains (comma-separated). Don't put `site:` in the query |
| `--type lite\|auto\|deep-lite\|deep` | Exa only. `lite` = fast and cheap, `deep*` = slower multi-step search; still returns results only, no synthesis. Default `auto` |
| `--goal "..."` | say what you are after (search, fetch): helps ranking / extraction |
| `--fresh` | fetch: live page, not cached. `--links`: also list the page's outbound links |
| `--country US`, `--lang en` | localise results (`--lang` is TinyFish only) |
| `-p exa\|tinyfish` | force one provider, no fallback |
| `--json` | normalized JSON, for piping into `jq` |

## Research (PAID: only when the user explicitly asks for deep research)

```bash
web research "question" --max-cost 1 [--effort low|medium|high] [--detach]
web research status <id>    web research cancel <id>
```

- Costs real money and takes minutes. `--max-cost <usd>` is mandatory: use the amount the user gave, never invent one (Exa needs >= 1; TinyFish fallback costs $2-3).
- Blocks up to `--wait` minutes (default 15), progress on stderr. Exit `4` = still running: tell the user the printed id, resume with `web research status <id>`. `--detach` returns the id immediately.
- For a quick factual answer use `web answer` instead (cents, seconds).

## Tips

- Write the query as a natural-language description of the page you want, not bare keywords (Exa is semantic).
- Save big output instead of printing it: `web fetch URL --max 100000 > /tmp/page.md`, then `rg`/`read` what you need.
- Exit codes: `0` ok, `1` all providers failed, `2` bad usage or request rejected by the provider (no fallback, fix the flags), `3` fetch partially failed (stderr lists the URLs), `4` research still running.
- Fallback order is Exa then TinyFish (`WEB_PROVIDERS` env overrides). A provider whose key is missing is skipped. Warnings on stderr say which flags TinyFish could not honour.
- `web --help` shows every option.
