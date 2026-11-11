// @ts-check
import { ProviderError } from "./errors.mjs";
import { clean } from "./util.mjs";

/** @typedef {import("./types.mjs").Ctx} Ctx */

/**
 * Effective request timeout: `WEB_TIMEOUT_MS` wins over the per-command default.
 * @param {Ctx} ctx
 * @param {number} fallback
 */
export const timeoutFor = (ctx, fallback) => ctx.timeout ?? fallback;

/** @param {string | null} h Retry-After header, seconds or HTTP date */
function parseRetryAfter(h) {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

/**
 * JSON request. Always resolves to parsed JSON or throws a ProviderError.
 * Provider payloads are untyped here on purpose: each provider module
 * normalises what it reads into the types in types.mjs.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string | undefined>, body?: unknown, timeout: number }} opts
 * @returns {Promise<any>}
 */
export async function call(url, { method = "GET", headers = {}, body, timeout }) {
  /** @type {Record<string, string>} */
  const h = { accept: "application/json" };
  if (body !== undefined) h["content-type"] = "application/json";
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;

  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    text = await res.text();
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new ProviderError("timeout", `timeout after ${timeout}ms`);
    }
    throw new ProviderError("network", `network: ${err?.cause?.code ?? err?.message ?? String(e)}`, { code: err?.cause?.code });
  }

  /** @type {any} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    const m = json?.error?.message ?? json?.error ?? json?.message ?? text;
    throw new ProviderError("http", `HTTP ${res.status}: ${clean(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 400)}`, {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after") ?? null),
      code: typeof json?.error?.code === "string" ? json.error.code : undefined,
    });
  }
  if (json === undefined || json === null) throw new ProviderError("invalid_json", "invalid JSON response");
  return json;
}
