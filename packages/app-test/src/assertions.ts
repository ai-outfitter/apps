import assert from "node:assert/strict";

/** Narrow a value expected by a test, failing with its scenario label. */
export function defined<T>(value: T | null | undefined, label = "value"): T {
  assert.ok(value !== null && value !== undefined, `expected ${label} to be defined`);
  return value;
}
