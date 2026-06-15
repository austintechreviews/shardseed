import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { fail } from "../errors.js";
import { parseJsonStrict } from "../manifest/json.js";

export interface CatalogueEntry {
  release_id: string;
  name: string;
  publisher: string;
  architecture: string;
  formats: string[];
  size: number;
  manifest_url: string;
}

export async function readFilesystemCatalogue(dir: string): Promise<CatalogueEntry[]> {
  const entries: CatalogueEntry[] = [];
  for (const file of await readdir(dir).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const parsed = parseJsonStrict(await readFile(join(dir, file), "utf8"), "catalogue") as CatalogueEntry | CatalogueEntry[];
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      validateCatalogueEntry(entry);
      entries.push(entry);
    }
  }
  return entries;
}

export function searchCatalogue(entries: CatalogueEntry[], query: string): CatalogueEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => [e.name, e.publisher, e.architecture, ...e.formats].join(" ").toLowerCase().includes(q));
}

export function validateCatalogueEntry(entry: CatalogueEntry): void {
  const keys = ["release_id", "name", "publisher", "architecture", "formats", "size", "manifest_url"];
  for (const key of keys) {
    if (!(key in (entry as unknown as Record<string, unknown>))) fail("catalogue.entry", `Catalogue entry missing field: ${key}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(entry.release_id)) fail("catalogue.release_id", "Catalogue release ID is malformed");
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 1024 ** 5) fail("catalogue.size", "Catalogue size is outside limits");
  const url = new URL(entry.manifest_url);
  if (url.protocol !== "https:" && url.protocol !== "http:") fail("catalogue.url", "Catalogue manifest URL must be HTTP(S)");
  if (isForbiddenHostname(url.hostname)) fail("catalogue.ssrf", "Catalogue manifest URL targets a forbidden local or private host");
}

export function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isForbiddenHostname(mapped[1]);
  if (isIP(host) === 6) {
    return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  }
  if (isIP(host) !== 4) return false;
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const first = Number(host.split(".")[0]);
  return first === 0 || first >= 224;
}
