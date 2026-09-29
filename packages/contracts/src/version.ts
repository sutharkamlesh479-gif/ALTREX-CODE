// Contract version carried by every event envelope (`v`).
// Adding an event type or an optional payload field is non-breaking.
// Removing/renaming a type or field, or changing a field's meaning, requires a new version.
export const CONTRACT_VERSION = 1 as const
export type ContractVersion = typeof CONTRACT_VERSION
