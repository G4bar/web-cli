// @ts-check
// Shared JSDoc typedefs. This module has no runtime code; it exists so that
// `tsc --checkJs` can resolve `import("./types.mjs").X` references.

/**
 * Everything the CLI needs from its environment, injected so tests can run
 * without touching process state or the network.
 *
 * @typedef {Object} Ctx
 * @property {Record<string, string | undefined>} env
 * @property {(line: string) => void} out      write a line to stdout
 * @property {(line: string) => void} err      write a line to stderr
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now                epoch milliseconds
 * @property {number | undefined} timeout      WEB_TIMEOUT_MS override, validated
 */

/**
 * Parsed and validated command-line options.
 *
 * @typedef {Object} Opts
 * @property {number} n
 * @property {number} chars
 * @property {number} max
 * @property {string[]=} site
 * @property {string[]=} exclude
 * @property {number=} recentMin
 * @property {string=} since             YYYY-MM-DD
 * @property {string=} until             YYYY-MM-DD
 * @property {string=} cat
 * @property {string=} type
 * @property {string=} focus
 * @property {string=} provider
 * @property {boolean} json
 * @property {Set<string>} given         long names of the flags the user passed
 */

/**
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} url
 * @property {string=} date
 * @property {string=} text
 */

/**
 * @typedef {Object} SearchOutput
 * @property {SearchResult[]} results
 * @property {number=} cost
 */

/**
 * @typedef {Object} Citation
 * @property {string} title
 * @property {string} url
 * @property {string=} date
 */

/**
 * @typedef {Object} AnswerOutput
 * @property {string} answer
 * @property {Citation[]} citations
 * @property {number=} cost
 */

/**
 * @typedef {Object} Page
 * @property {string} url
 * @property {string} title
 * @property {string} text
 * @property {boolean} truncated      the provider already cut the text at --max
 */

/**
 * @typedef {Object} FetchOutput
 * @property {Map<string, Page>} pages   keyed by the requested URL
 * @property {number=} cost
 */

/**
 * @typedef {Object} Provider
 * @property {"exa" | "tinyfish"} name
 * @property {string} keyName
 * @property {(ctx: Ctx) => boolean} ready
 * @property {(op: Op, o: Opts) => void} validate                         throws UsageError
 * @property {(op: Op, o: Opts) => string[]} ignored                      flags the provider cannot honour
 * @property {(ctx: Ctx, q: string, o: Opts) => Promise<SearchOutput>} search
 * @property {(ctx: Ctx, urls: string[], o: Opts) => Promise<FetchOutput>} fetch
 * @property {((ctx: Ctx, q: string, o: Opts) => Promise<AnswerOutput>)=} answer
 */

/** @typedef {"search" | "answer" | "fetch"} Op */

export {};
