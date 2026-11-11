// @ts-check
import { readFileSync } from "node:fs";
import { UsageError } from "./errors.mjs";

/**
 * `--schema` accepts inline JSON (starts with `{`) or a path to a JSON file.
 * The schema must describe an object.
 *
 * @param {string} value
 * @returns {Record<string, any>}
 */
export function loadSchema(value) {
  const v = value.trim();
  let text = v;
  if (!v.startsWith("{")) {
    try {
      text = readFileSync(v, "utf8");
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      throw new UsageError(`--schema: cannot read "${v}"${code ? ` (${code})` : ""}; pass a JSON file or inline JSON starting with {`);
    }
  }
  /** @type {unknown} */
  let schema;
  try {
    schema = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--schema: invalid JSON (${e instanceof Error ? e.message : e})`);
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || /** @type {any} */ (schema).type !== "object") {
    throw new UsageError('--schema must be a JSON Schema object with "type": "object"');
  }
  return /** @type {Record<string, any>} */ (schema);
}

/** Limits Exa enforces on the `outputSchema` of /search (deep, deep-lite). */
export const EXA_SEARCH_SCHEMA_LIMITS = { properties: 10, nesting: 2 };

/**
 * Check a schema against Exa's /search `outputSchema` limits, so a violation is
 * reported before the request: at most 10 properties in total (every level, array
 * items included), at most 2 levels of nesting below the root (an array counts as
 * a level, so `list -> items -> name` is fine but an object inside the items is not),
 * and every array must define `items`.
 *
 * @param {Record<string, any>} schema
 */
export function checkExaSearchSchema(schema) {
  let props = 0;
  /**
   * @param {any} node
   * @param {number} level   0 for the root
   */
  const visit = (node, level) => {
    if (!node || typeof node !== "object") return;
    const isArray = node.type === "array";
    const isObject = !!node.properties && typeof node.properties === "object";
    if (!isArray && !isObject) return;
    if (level > EXA_SEARCH_SCHEMA_LIMITS.nesting) {
      throw new UsageError(`--schema nests deeper than ${EXA_SEARCH_SCHEMA_LIMITS.nesting} levels (Exa's limit for --deep; an array counts as a level)`);
    }
    if (isArray) {
      if (!node.items) throw new UsageError('--schema has an array without "items" (Exa requires it for --deep)');
      visit(node.items, level + 1);
    } else {
      for (const child of Object.values(node.properties)) {
        props++;
        if (props > EXA_SEARCH_SCHEMA_LIMITS.properties) {
          throw new UsageError(`--schema has more than ${EXA_SEARCH_SCHEMA_LIMITS.properties} properties in total (Exa's limit for --deep; nested and array item properties count)`);
        }
        visit(child, level + 1);
      }
    }
  };
  visit(schema, 0);
}
