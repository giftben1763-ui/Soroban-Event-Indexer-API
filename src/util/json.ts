/**
 * scValToNative() can produce BigInt for i64/u64/i128/u128/i256/u256 values,
 * which JSON.stringify chokes on by default. We stringify BigInts (with a
 * suffix so the API can tell them apart from a plain numeric string if it
 * ever needs to) rather than lossily coercing to Number.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

/**
 * Reverses jsonReplacer's bigint encoding when reading rows back out.
 * Large integers (i64/u64/i128/u128/i256/u256) come back as plain decimal
 * strings — safe to embed in JSON, unambiguous, and easy to parse with
 * BigInt(str) on the client if precision matters.
 */
export function jsonReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__bigint__" in (value as Record<string, unknown>) &&
    Object.keys(value as Record<string, unknown>).length === 1
  ) {
    return (value as { __bigint__: string }).__bigint__;
  }
  return value;
}

export function safeParse<T = unknown>(text: string): T {
  return JSON.parse(text, jsonReviver) as T;
}
