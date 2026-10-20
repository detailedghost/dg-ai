/**
 * In-memory held-state map: the server is the single writer of payload.json.
 * PUT /api/[board]/state merges into this map; POST /api/respond reads forceEnforce
 * from it and updates it after merge. Module-level so both handlers share one instance.
 *
 * Node-compatible only (no Bun.* APIs) — same constraint as respond-core.ts.
 */

/** Keyed by board slug. Value is the current authoritative payload for that board. */
export const heldState = new Map<string, Record<string, unknown>>();
