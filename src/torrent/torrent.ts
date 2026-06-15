import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fail } from "../errors.js";
import fg from "fast-glob";
import { sha256Bytes, sha256RegularFile } from "../fsutil.js";
import { parseJsonStrict } from "../manifest/json.js";
import { ReleaseStatement } from "../manifest/types.js";
import { validateArtifactPath } from "../manifest/validate.js";
import { parseTorrentInfo } from "./engine.js";

export interface TorrentFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface TorrentMetadata {
  name: string;
  piece_length: number;
  pieces_sha256: string[];
  files: TorrentFileEntry[];
  infohash_v1: string;
  magnet_uri: string;
}

export async function createTorrentMetadata(directory: string, outPath: string, trackers: string[] = []): Promise<TorrentMetadata> {
  const files = await discoverFiles(directory);
  const pieces = files.map((f) => f.sha256);
  const infoBytes = JSON.stringify({ name: basename(directory), piece_length: 262144, files, pieces_sha256: pieces, trackers });
  const infohash = createHash("sha1").update(infoBytes).digest("hex");
  const magnet = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(basename(directory))}`;
  const meta: TorrentMetadata = { name: basename(directory), piece_length: 262144, pieces_sha256: pieces, files, infohash_v1: infohash, magnet_uri: magnet };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(meta, null, 2));
  return meta;
}

export async function readTorrentMetadata(path: string): Promise<TorrentMetadata> {
  const meta = parseJsonStrict(await readFile(path, "utf8"), "torrent") as TorrentMetadata;
  validateTorrentMetadata(meta);
  return meta;
}

export function validateTorrentMetadata(meta: TorrentMetadata): void {
  if (!meta || typeof meta !== "object") fail("torrent.metadata", "Torrent metadata must be an object");
  if (!Number.isSafeInteger(meta.piece_length) || meta.piece_length <= 0 || meta.piece_length > 64 * 1024 * 1024) fail("torrent.piece_length", "Torrent piece length is outside limits");
  if (!/^[0-9a-f]{40}$/i.test(meta.infohash_v1)) fail("torrent.infohash", "Torrent metadata infohash is invalid");
  if (!meta.magnet_uri.startsWith("magnet:?")) fail("torrent.magnet", "Torrent metadata magnet URI is invalid");
  if (!Array.isArray(meta.files) || meta.files.length === 0 || meta.files.length > 10_000) fail("torrent.files", "Torrent metadata has an invalid file list");
  const seen = new Set<string>();
  for (const file of meta.files) {
    validateArtifactPath(file.path);
    if (seen.has(file.path)) fail("torrent.duplicate_file", `Torrent metadata has a duplicate file path: ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 1024 ** 5) fail("torrent.file_size", `Torrent file size is outside limits: ${file.path}`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) fail("torrent.sha256", `Torrent file SHA-256 is invalid: ${file.path}`);
  }
}

export async function discoverFiles(directory: string): Promise<TorrentFileEntry[]> {
  const matches = await fg(["**/*"], { cwd: directory, onlyFiles: true, dot: true, unique: true });
  const out: TorrentFileEntry[] = [];
  for (const rel of matches.sort()) {
    validateArtifactPath(rel);
    const full = join(directory, rel);
    const st = await lstat(full);
    if (!st.isFile()) fail("torrent.file_type", `Torrent input is not a regular file: ${rel}`);
    const digest = await sha256RegularFile(full);
    out.push({ path: rel, size: digest.size, sha256: digest.sha256 });
  }
  return out;
}

export function torrentSha256(meta: TorrentMetadata): string {
  return sha256Bytes(JSON.stringify(meta));
}

export function validateTorrentMetadataAgainstStatement(meta: TorrentMetadata, statement: ReleaseStatement): void {
  if (statement.transport.bittorrent.infohash_v1 && meta.infohash_v1.toLowerCase() !== statement.transport.bittorrent.infohash_v1.toLowerCase()) {
    fail("torrent.infohash_mismatch", "Torrent infohash does not match the signed manifest");
  }
  if (meta.magnet_uri !== statement.transport.bittorrent.magnet_uri) fail("torrent.magnet_mismatch", "Torrent magnet URI does not match the signed manifest");
  const declared = new Map(statement.artifacts.map((artifact) => [artifact.path, artifact]));
  const seen = new Set<string>();
  for (const file of meta.files) {
    validateArtifactPath(file.path);
    if (seen.has(file.path)) fail("torrent.duplicate_file", `Torrent metadata has a duplicate file path: ${file.path}`);
    seen.add(file.path);
    const artifact = declared.get(file.path);
    if (!artifact) fail("torrent.undeclared_file", `Torrent metadata contains an undeclared file: ${file.path}`);
    if (artifact.size !== file.size) fail("torrent.size_mismatch", `Torrent file size does not match manifest: ${file.path}`);
    if (artifact.digests.sha256 !== file.sha256) fail("torrent.hash_mismatch", `Torrent file hash does not match manifest: ${file.path}`);
  }
  for (const artifact of statement.artifacts) {
    if (!seen.has(artifact.path)) fail("torrent.missing_file", `Torrent metadata is missing manifest artifact: ${artifact.path}`);
  }
}

export async function validateTorrentFileAgainstStatement(torrentFile: Buffer | Uint8Array, statement: ReleaseStatement): Promise<void> {
  const torrentSha = sha256Bytes(torrentFile);
  if (torrentSha !== statement.transport.bittorrent.torrent_file_sha256) {
    fail("torrent.file_hash_mismatch", "Torrent file SHA-256 does not match the signed manifest");
  }
  const info = await parseTorrentInfo(torrentFile);
  if (statement.transport.bittorrent.infohash_v1 && info.infoHash.toLowerCase() !== statement.transport.bittorrent.infohash_v1.toLowerCase()) {
    fail("torrent.infohash_mismatch", "Torrent info hash does not match the signed manifest");
  }
  if (extractBtih(statement.transport.bittorrent.magnet_uri)?.toLowerCase() !== info.infoHash.toLowerCase()) {
    fail("torrent.magnet_mismatch", "Torrent magnet URI does not carry the signed torrent info hash");
  }
  const manifestTrackers = [...statement.transport.bittorrent.trackers].sort();
  const torrentTrackers = [...info.announce].sort();
  if (JSON.stringify(manifestTrackers) !== JSON.stringify(torrentTrackers)) {
    fail("torrent.trackers_mismatch", "Torrent trackers do not match the signed manifest");
  }
  const manifestWebSeeds = [...statement.transport.bittorrent.web_seeds].sort();
  const torrentWebSeeds = [...info.urlList].sort();
  if (JSON.stringify(manifestWebSeeds) !== JSON.stringify(torrentWebSeeds)) {
    fail("torrent.web_seeds_mismatch", "Torrent web seeds do not match the signed manifest");
  }
  const normalized = normalizeTorrentFilePaths(info.files.map((file) => ({ path: file.path, size: file.length })));
  const declared = new Map(statement.artifacts.map((artifact) => [artifact.path, artifact]));
  const seen = new Set<string>();
  for (const file of normalized) {
    validateArtifactPath(file.path);
    if (seen.has(file.path)) fail("torrent.duplicate_file", `Torrent file list has a duplicate path: ${file.path}`);
    seen.add(file.path);
    const artifact = declared.get(file.path);
    if (!artifact) fail("torrent.undeclared_file", `Torrent file list contains an undeclared file: ${file.path}`);
    if (artifact.size !== file.size) fail("torrent.size_mismatch", `Torrent file size does not match manifest: ${file.path}`);
  }
  for (const artifact of statement.artifacts) {
    if (!seen.has(artifact.path)) fail("torrent.missing_file", `Torrent file list is missing manifest artifact: ${artifact.path}`);
  }
}

function extractBtih(magnetUri: string): string | null {
  const url = new URL(magnetUri);
  for (const xt of url.searchParams.getAll("xt")) {
    const match = xt.match(/^urn:btih:([0-9a-fA-F]{40})$/);
    if (match) return match[1];
  }
  return null;
}

function normalizeTorrentFilePaths(files: Array<{ path: string; size: number }>): Array<{ path: string; size: number }> {
  if (files.length === 0) return files;
  const parts = files.map((file) => file.path.split("/"));
  const first = parts[0][0];
  const hasCommonRoot = !!first && parts.every((pathParts) => pathParts.length > 1 && pathParts[0] === first);
  return files.map((file) => ({
    path: hasCommonRoot ? file.path.split("/").slice(1).join("/") : file.path,
    size: file.size
  }));
}
