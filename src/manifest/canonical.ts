import { sha256Bytes } from "../fsutil.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, normalize(v)]));
  }
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) {
    throw new Error("Canonical JSON only permits safe integers in signed data");
  }
  return value;
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(normalize(value)), "utf8");
}

export function releaseId(statement: unknown): string {
  return `sha256:${sha256Bytes(canonicalJson(statement))}`;
}
