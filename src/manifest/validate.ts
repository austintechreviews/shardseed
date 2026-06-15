import { fail } from "../errors.js";
import { PAYLOAD_TYPE, RELEASE_SCHEMA, ReleaseStatement, SignedEnvelope } from "./types.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const INFOHASH = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;
const MAX_DECLARED_FILE_SIZE = 1024 ** 5;
const MAX_ARTIFACTS = 10_000;
const MAX_PATH_BYTES = 512;
const MAX_TRACKERS = 32;
const MAX_WEB_SEEDS = 32;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const SAFE_EXTENSIONS = new Set([
  ".gguf", ".json", ".txt", ".md", ".license", ".licence", ".spm", ".model", ".tiktoken",
  ".yaml", ".yml", ".safetensors", ".jinja"
]);
const EXECUTABLE_EXTENSIONS = [
  ".py", ".sh", ".bash", ".zsh", ".js", ".exe", ".dll", ".dylib", ".so", ".wasm", ".jar",
  ".app", ".bat", ".cmd", ".ps1", ".pkl", ".pickle"
];
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar"];

export function validateEnvelope(envelope: SignedEnvelope): void {
  assertExactKeys(envelope as unknown as Record<string, unknown>, ["payload_type", "payload", "signatures"], "manifest.envelope");
  if (envelope.payload_type !== PAYLOAD_TYPE) fail("manifest.payload_type", "Unsupported signed manifest payload type");
  if (typeof envelope.payload !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) || envelope.payload.length > 2 * 1024 * 1024) {
    fail("manifest.payload", "Manifest payload is not strict base64 or exceeds size limits");
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) fail("manifest.signature_missing", "Manifest has no signatures");
  if (envelope.signatures.length > 8) fail("manifest.signature_count", "Manifest contains too many signatures");
  for (const sig of envelope.signatures) {
    assertExactKeys(sig as unknown as Record<string, unknown>, ["key_id", "signature"], "manifest.signature");
    if (!sig.key_id.startsWith("ed25519:")) fail("manifest.key_id", "Signature key ID is not an Ed25519 key ID");
    if (!sig.signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig.signature)) fail("manifest.signature_malformed", "Manifest signature is malformed");
  }
}

export function validateStatement(statement: ReleaseStatement): void {
  assertStatementShape(statement);
  if (statement.schema !== RELEASE_SCHEMA) fail("manifest.schema", "Unsupported manifest schema version");
  if (!Array.isArray(statement.artifacts) || statement.artifacts.length === 0) fail("manifest.artifacts", "Release must declare at least one artifact");
  if (statement.artifacts.length > MAX_ARTIFACTS) fail("manifest.artifacts", "Release declares too many artifacts");
  if (!statement.publisher.key_id.startsWith("ed25519:")) fail("manifest.publisher_key", "Publisher key ID is invalid");
  if (!statement.transport?.bittorrent?.magnet_uri.startsWith("magnet:?")) fail("torrent.magnet", "Torrent magnet URI is invalid");
  if (statement.transport.bittorrent.infohash_v1 && !INFOHASH.test(statement.transport.bittorrent.infohash_v1)) fail("torrent.infohash", "Torrent infohash_v1 is invalid");
  if (statement.transport.bittorrent.infohash_v2 && !INFOHASH.test(statement.transport.bittorrent.infohash_v2)) fail("torrent.infohash", "Torrent infohash_v2 is invalid");
  if (!SHA256_HEX.test(statement.transport.bittorrent.torrent_file_sha256)) fail("torrent.sha256", "Torrent file SHA-256 is invalid");
  if (statement.transport.bittorrent.trackers.length > MAX_TRACKERS) fail("torrent.trackers", "Manifest declares too many trackers");
  if (statement.transport.bittorrent.web_seeds.length > MAX_WEB_SEEDS) fail("torrent.web_seeds", "Manifest declares too many web seeds");
  if (statement.security.contains_executable_code || statement.security.requires_custom_code || statement.security.serialization_risk !== "data-only") {
    fail("security.executable", "Release declares executable or custom code and is outside the prototype policy");
  }

  const seen = new Set<string>();
  const folded = new Set<string>();
  for (const artifact of statement.artifacts) {
    validateArtifactPath(artifact.path);
    if (seen.has(artifact.path)) fail("manifest.duplicate_path", `Duplicate artifact path: ${artifact.path}`);
    seen.add(artifact.path);
    const lower = artifact.path.toLocaleLowerCase("en-US");
    if (folded.has(lower)) fail("manifest.case_collision", `Duplicate artifact path after case folding: ${artifact.path}`);
    folded.add(lower);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > MAX_DECLARED_FILE_SIZE) {
      fail("manifest.file_size", `Declared file size is outside sensible limits: ${artifact.path}`);
    }
    if (!SHA256_HEX.test(artifact.digests.sha256)) fail("manifest.sha256", `Invalid SHA-256 digest for ${artifact.path}`);
    if (artifact.media_type.includes("\n") || artifact.media_type.includes("\r")) fail("manifest.media_type", `Invalid media type for ${artifact.path}`);
    assertSafeExtension(artifact.path);
  }
}

export function validateArtifactPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) fail("path.empty", "Artifact path is empty");
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) fail("path.length", "Artifact path exceeds the maximum length");
  if (path.includes("\0")) fail("path.nul", "Artifact path contains a NUL character");
  if (path !== path.normalize("NFC")) fail("path.unicode", "Artifact path is not Unicode NFC normalized");
  if (path.includes("\\")) fail("path.separator", "Artifact path contains a Windows path separator");
  if (/%2e|%2f|%5c/i.test(path)) fail("path.encoded_traversal", "Artifact path contains encoded traversal characters");
  if (path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:[\\/]/.test(path)) fail("path.absolute", "Artifact path is absolute");
  const parts = path.split("/");
  if (parts.some((p) => p.length === 0)) fail("path.empty_component", "Artifact path contains an empty component");
  if (parts.some((p) => p === "..")) fail("path.parent", "Artifact path contains a parent-directory component");
  if (parts.some((p) => p === ".")) fail("path.dot", "Artifact path contains a current-directory component");
  if (parts.some((p) => p.endsWith(".") || p.endsWith(" "))) fail("path.trailing", "Artifact path contains a trailing dot or space");
  if (parts.some((p) => WINDOWS_RESERVED.test(p))) fail("path.windows_reserved", "Artifact path uses a reserved Windows filename");
}

export function assertSafeExtension(path: string): void {
  const lower = path.toLowerCase();
  if (EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) fail("security.executable_file", `Executable content is not permitted: ${path}`);
  if (ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))) fail("security.archive", `Archive files are rejected by default: ${path}`);
  if (![...SAFE_EXTENSIONS].some((ext) => lower.endsWith(ext))) fail("security.unsupported_file", `Unsupported artifact type: ${path}`);
}

function assertStatementShape(statement: ReleaseStatement): void {
  assertExactKeys(statement as unknown as Record<string, unknown>, ["schema", "release", "model", "artifacts", "transport", "lineage", "licensing", "security", "publisher"], "manifest.statement");
  assertExactKeys(statement.release as unknown as Record<string, unknown>, ["name", "version", "created_at", "description"], "manifest.release");
  assertExactKeys(statement.model as unknown as Record<string, unknown>, ["publisher_namespace", "model_slug", "architecture", "parameter_count", "formats"], "manifest.model");
  assertExactKeys(statement.transport as unknown as Record<string, unknown>, ["bittorrent"], "manifest.transport");
  assertExactKeys(statement.transport.bittorrent as unknown as Record<string, unknown>, ["magnet_uri", "infohash_v1", "infohash_v2", "torrent_file_sha256", "trackers", "web_seeds"], "manifest.bittorrent");
  assertExactKeys(statement.lineage as unknown as Record<string, unknown>, ["parents"], "manifest.lineage");
  assertExactKeys(statement.licensing as unknown as Record<string, unknown>, ["weights"], "manifest.licensing");
  assertExactKeys(statement.licensing.weights as unknown as Record<string, unknown>, ["expression", "text_path", "source_url", "redistribution_claimed"], "manifest.licensing.weights");
  assertExactKeys(statement.security as unknown as Record<string, unknown>, ["contains_executable_code", "requires_custom_code", "serialization_risk"], "manifest.security");
  assertExactKeys(statement.publisher as unknown as Record<string, unknown>, ["display_name", "key_id"], "manifest.publisher");
  for (const artifact of statement.artifacts) {
    assertExactKeys(artifact as unknown as Record<string, unknown>, ["path", "role", "media_type", "size", "digests", "format"], "manifest.artifact");
    assertExactKeys(artifact.digests as unknown as Record<string, unknown>, ["sha256"], "manifest.artifact.digests");
    assertExactKeys(artifact.format as unknown as Record<string, unknown>, ["family", "version", "quantisation"], "manifest.artifact.format");
  }
}

function assertExactKeys(obj: Record<string, unknown>, keys: string[], code: string): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail(code, "Expected a JSON object");
  const allowed = new Set(keys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(code, `Unknown field is not permitted: ${key}`);
  }
  for (const key of keys) {
    if (!(key in obj)) fail(code, `Required field is missing: ${key}`);
  }
}
