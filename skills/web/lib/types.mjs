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
 * @property {string=} goal
 * @property {string=} country           upper-case ISO 3166-1 alpha-2
 * @property {string=} lang              lower-case ISO 639-1
 * @property {boolean} deep
 * @property {boolean} fast
 * @property {Record<string, any>=} schema
 * @property {boolean} fresh
 * @property {boolean} links
 * @property {number=} maxCost           USD
 * @property {string=} effort
 * @property {string=} mode
 * @property {number} waitMin
 * @property {boolean} detach
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
 * @property {string | Record<string, any>} answer   string, or an object when a schema was given
 * @property {Citation[]} citations
 * @property {number=} cost
 * @property {string=} mode                          "deep" | "deep-lite" for the /search based answer
 * @property {any[]=} grounding
 */

/**
 * @typedef {Object} Page
 * @property {string} url
 * @property {string} title
 * @property {string} text
 * @property {boolean} truncated      the provider already cut the text at --max
 * @property {string[]=} links        raw outbound links, when --links was requested
 */

/**
 * @typedef {Object} FetchOutput
 * @property {Map<string, Page>} pages   keyed by the requested URL
 * @property {number=} cost
 */

/**
 * Normalised state of an asynchronous research run.
 *
 * @typedef {Object} ResearchRun
 * @property {string} id                 provider-prefixed ("exa:...", "tinyfish:...")
 * @property {string} provider
 * @property {"queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out"} status
 * @property {string=} text
 * @property {any=} structured
 * @property {Citation[]} sources
 * @property {number=} cost
 * @property {boolean} costEstimated     true when cost is the published list price, not a measured value
 * @property {string=} reason            stop / termination reason
 * @property {string=} error
 */

/**
 * @typedef {Object} ResearchApi
 * @property {(o: Opts) => { ok: true, price?: string } | { ok: false, reason: string }} check
 * @property {(ctx: Ctx, q: string, o: Opts) => Promise<ResearchRun>} start
 * @property {(ctx: Ctx, rawId: string) => Promise<ResearchRun>} get
 * @property {(ctx: Ctx, rawId: string) => Promise<ResearchRun>} cancel
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
 * @property {ResearchApi} research
 */

/** @typedef {"search" | "answer" | "fetch" | "research"} Op */

export {};
