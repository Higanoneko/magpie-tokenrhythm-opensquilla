// Shared pure helpers: small predicates and coercions used across the plugin.
// Everything here is total and side-effect free — undefined rather than throw,
// the input never mutated.

/** v is a plain object, not an array or null. */
export const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v)

/** v as a non-empty trimmed string, or undefined. */
export const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)

/** v as a positive finite number, or undefined. Strings count. */
export const pos = (v) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** v as a finite number, or undefined. */
export const num = (v) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) ? n : undefined
}

/** v as a list of non-empty strings, or undefined when it is no list at all. */
export const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : undefined)

/** The first non-empty string of vals, or "". */
export const firstNonEmpty = (...vals) => vals.map((v) => (typeof v === "string" ? v.trim() : "")).find((s) => s) ?? ""
