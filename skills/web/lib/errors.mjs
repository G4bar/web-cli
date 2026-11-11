// @ts-check

/** Exit codes shared by every command. */
export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1, // every provider failed / a run ended unsuccessfully
  USAGE: 2, // bad usage, or a caller error (HTTP 400/422) reported by a provider
  PARTIAL: 3, // fetch: some URLs failed
  RUNNING: 4, // research: the run is still going
});

/** The user asked for something invalid. Maps to exit code 2. */
export class UsageError extends Error {}

/** Stop the command with a specific exit code. The message (if any) goes to stderr. */
export class ExitError extends Error {
  /**
   * @param {number} code
   * @param {string} [message]
   */
  constructor(code, message = "") {
    super(message);
    this.code = code;
  }
}

/**
 * A failed provider call.
 *  - `http`: the provider answered with an error status
 *  - `timeout` / `network`: no usable answer (the request may or may not have been processed)
 *  - `invalid_json` / `bad_response`: the answer made no sense
 */
export class ProviderError extends Error {
  /**
   * @param {"http" | "timeout" | "network" | "invalid_json" | "bad_response"} kind
   * @param {string} message
   * @param {{ status?: number, retryAfterMs?: number, code?: string }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
    this.code = extra.code;
  }
}

/** HTTP 400 / 422: the request itself is wrong, a different provider will not fix it. */
export function isCallerError(/** @type {unknown} */ e) {
  return e instanceof ProviderError && e.kind === "http" && (e.status === 400 || e.status === 422);
}

/** Error text for any thrown value. */
export function messageOf(/** @type {unknown} */ e) {
  return e instanceof Error ? e.message : String(e);
}
