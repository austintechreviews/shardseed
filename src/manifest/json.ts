import { fail } from "../errors.js";

export const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;

export function parseJsonStrict(text: string, label = "json"): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) fail(`${label}.too_large`, "JSON document exceeds the maximum allowed size");
  rejectDuplicateKeys(text, label);
  return JSON.parse(text) as unknown;
}

export function rejectDuplicateKeys(text: string, label = "json"): void {
  const stack: Array<{ keys: Set<string>; expectingKey: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isWhitespace(ch) || ch === "," || ch === ":") {
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push({ keys: new Set(), expectingKey: ch === "{" });
      if (stack.length > MAX_JSON_DEPTH) fail(`${label}.depth`, "JSON document exceeds the maximum nesting depth");
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i++;
      afterValue(stack);
      continue;
    }
    if (ch === "\"") {
      const { value, next } = readJsonString(text, i);
      const top = stack.at(-1);
      let j = next;
      while (isWhitespace(text[j])) j++;
      if (top?.expectingKey && text[j] === ":") {
        if (top.keys.has(value)) fail(`${label}.duplicate_key`, `JSON object contains a duplicate key: ${value}`);
        top.keys.add(value);
        top.expectingKey = false;
      } else {
        afterValue(stack);
      }
      i = next;
      continue;
    }
    i = skipPrimitive(text, i);
    afterValue(stack);
  }
}

function afterValue(stack: Array<{ keys: Set<string>; expectingKey: boolean }>): void {
  const top = stack.at(-1);
  if (top) top.expectingKey = true;
}

function readJsonString(text: string, start: number): { value: string; next: number } {
  let out = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\"") return { value: out, next: i + 1 };
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = text[++i];
    if (esc === "u") {
      const hex = text.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("json.escape", "Invalid JSON unicode escape");
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      out += esc;
    }
  }
  fail("json.string", "Unterminated JSON string");
}

function skipPrimitive(text: string, start: number): number {
  let i = start;
  while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
  return i;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}
