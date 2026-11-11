// @ts-check
import { UsageError } from "../errors.mjs";
import { envVar } from "../util.mjs";
import { exa } from "./exa.mjs";
import { tinyfish } from "./tinyfish.mjs";

/** @typedef {import("../types.mjs").Ctx} Ctx */
/** @typedef {import("../types.mjs").Provider} Provider */

/** @type {Record<string, Provider>} */
export const REGISTRY = { exa, tinyfish };

/**
 * Providers to try, in order: the forced one, else WEB_PROVIDERS, else exa then tinyfish.
 * @param {Ctx} ctx
 * @param {string | undefined} forced
 * @returns {Provider[]}
 */
export function providerOrder(ctx, forced) {
  const names = forced ? [forced] : (envVar(ctx, "WEB_PROVIDERS") ?? "exa,tinyfish").split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new UsageError("WEB_PROVIDERS is empty (use exa | tinyfish)");
  return names.map((n) => {
    const p = REGISTRY[n];
    if (!p) throw new UsageError(`unknown provider "${n}" (use exa | tinyfish)`);
    return p;
  });
}
