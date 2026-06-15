import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { generatePublisherKey } from "../src/crypto/keys.js";
import { canonicalJson, releaseId } from "../src/manifest/canonical.js";
import { signStatement, parseEnvelopeJson, verifyEnvelope } from "../src/manifest/signing.js";
import { RELEASE_SCHEMA, ReleaseStatement } from "../src/manifest/types.js";
import { validateStatement } from "../src/manifest/validate.js";
import { verifyDownloadedRelease } from "../src/storage/store.js";
import { WebTorrentEngine } from "../src/torrent/engine.js";
import { validateTorrentFileAgainstStatement, validateTorrentMetadataAgainstStatement } from "../src/torrent/torrent.js";
import { isForbiddenHostname, validateCatalogueEntry } from "../src/catalogue/catalogue.js";

function statement(keyId = "ed25519:placeholder"): ReleaseStatement {
  return {
    schema: RELEASE_SCHEMA,
    release: { name: "Example", version: "1.0.0", created_at: "2026-06-15T12:00:00Z", description: "Example release" },
    model: { publisher_namespace: "example", model_slug: "example-model", architecture: "llama", parameter_count: 7_000_000_000, formats: ["gguf"] },
    artifacts: [{ path: "example-model-Q4_K_M.gguf", role: "weights", media_type: "application/vnd.gguf", size: 24, digests: { sha256: "a".repeat(64) }, format: { family: "gguf", version: 3, quantisation: "Q4_K_M" } }],
    transport: { bittorrent: { magnet_uri: "magnet:?xt=urn:btih:" + "b".repeat(40), infohash_v1: "b".repeat(40), infohash_v2: null, torrent_file_sha256: "c".repeat(64), trackers: [], web_seeds: [] } },
    lineage: { parents: [] },
    licensing: { weights: { expression: "LicenseRef-Unknown", text_path: null, source_url: null, redistribution_claimed: false } },
    security: { contains_executable_code: false, requires_custom_code: false, serialization_risk: "data-only" },
    publisher: { display_name: "Example Publisher", key_id: keyId }
  };
}

describe("protocol core", () => {
  it("canonicalizes equivalent objects to identical bytes and release IDs", () => {
    const a = { z: 1, a: { b: true, a: "x" } };
    const b = { a: { a: "x", b: true }, z: 1 };
    expect(canonicalJson(a).toString()).toBe(canonicalJson(b).toString());
    expect(releaseId(a)).toBe(releaseId(b));
  });

  it("rejects unsafe artifact paths and case collisions", () => {
    const s = statement();
    s.artifacts[0].path = "../escape.gguf";
    expect(() => validateStatement(s)).toThrow(/parent-directory/);
    s.artifacts[0].path = "nested\\escape.gguf";
    expect(() => validateStatement(s)).toThrow(/Windows path separator/);
    s.artifacts[0].path = "CON.gguf";
    expect(() => validateStatement(s)).toThrow(/reserved Windows/);
    const c = statement();
    c.artifacts.push({ ...c.artifacts[0], path: "Example-Model-Q4_K_M.gguf" });
    expect(() => validateStatement(c)).toThrow(/case folding/);
  });

  it("rejects duplicate JSON keys before manifest deserialization", async () => {
    const dir = await makeTemp("keys");
    const key = await generatePublisherKey(dir, "test");
    const privatePem = await readFile(key.private_key_path!, "utf8");
    const env = signStatement(statement(key.key_id), privatePem, key.public_key_pem);
    const duplicated = `{"payload_type":"wrong","payload_type":${JSON.stringify(env.payload)},"payload":${JSON.stringify(env.payload)},"signatures":${JSON.stringify(env.signatures)}}`;
    expect(() => parseEnvelopeJson(duplicated)).toThrow(/duplicate key/);
  });

  it("signs and verifies Ed25519 envelopes and rejects modified manifests", async () => {
    const dir = await makeTemp("keys");
    const key = await generatePublisherKey(dir, "test");
    const privatePem = await readFile(key.private_key_path!, "utf8");
    const s = statement(key.key_id);
    const env = signStatement(s, privatePem, key.public_key_pem);
    expect(verifyEnvelope(env, key.public_key_pem).release.name).toBe("Example");
    const tampered = structuredClone(env);
    const payload = JSON.parse(Buffer.from(tampered.payload, "base64").toString("utf8")) as ReleaseStatement;
    payload.release.name = "Changed";
    tampered.payload = canonicalJson(payload).toString("base64");
    expect(() => verifyEnvelope(tampered, key.public_key_pem)).toThrow(/signature is invalid/);
  });

  it("requires a valid publisher signature before materializing the trusted store", async () => {
    const dir = await makeTemp("verify");
    const key = await generatePublisherKey(join(dir, "keys"), "test");
    const privatePem = await readFile(key.private_key_path!, "utf8");
    const body = Buffer.from("GGUF".padEnd(24, "\0"));
    const digest = await import("../src/fsutil.js").then((m) => m.sha256Bytes(body));
    const s = statement(key.key_id);
    s.artifacts[0].size = body.length;
    s.artifacts[0].digests.sha256 = digest;
    const env = signStatement(s, privatePem, key.public_key_pem);
    await mkdir(join(dir, "download"), { recursive: true });
    await writeFile(join(dir, "download", s.artifacts[0].path), body);
    const tampered = structuredClone(env);
    tampered.signatures[0].signature = Buffer.from("forged").toString("base64");
    await expect(verifyDownloadedRelease(tampered, join(dir, "download"), join(dir, "store"), key.public_key_pem)).rejects.toThrow(/signature is invalid/);
    await expect(verifyDownloadedRelease(env, join(dir, "download"), join(dir, "store"), key.public_key_pem)).resolves.toMatchObject({ release_id: releaseId(s) });
  });

  it("does not hardlink untrusted downloads into the verified store", async () => {
    const dir = await makeTemp("store-hardlink");
    const key = await generatePublisherKey(join(dir, "keys"), "test");
    const privatePem = await readFile(key.private_key_path!, "utf8");
    const body = Buffer.from("GGUF".padEnd(24, "\0"));
    const digest = await import("../src/fsutil.js").then((m) => m.sha256Bytes(body));
    const s = statement(key.key_id);
    s.artifacts[0].size = body.length;
    s.artifacts[0].digests.sha256 = digest;
    const env = signStatement(s, privatePem, key.public_key_pem);
    const downloadFile = join(dir, "download", s.artifacts[0].path);
    await mkdir(join(dir, "download"), { recursive: true });
    await writeFile(downloadFile, body);

    const verified = await verifyDownloadedRelease(env, join(dir, "download"), join(dir, "store"), key.public_key_pem);
    await writeFile(downloadFile, Buffer.from("evil".padEnd(24, "\0")));

    await expect(readFile(join(verified.verified_dir, "files", s.artifacts[0].path))).resolves.toEqual(body);
  });

  it("rejects symlink artifacts even when the target bytes match", async () => {
    const dir = await makeTemp("symlink");
    const key = await generatePublisherKey(join(dir, "keys"), "test");
    const privatePem = await readFile(key.private_key_path!, "utf8");
    const body = Buffer.from("GGUF".padEnd(24, "\0"));
    const digest = await import("../src/fsutil.js").then((m) => m.sha256Bytes(body));
    const s = statement(key.key_id);
    s.artifacts[0].size = body.length;
    s.artifacts[0].digests.sha256 = digest;
    const env = signStatement(s, privatePem, key.public_key_pem);
    await mkdir(join(dir, "download"), { recursive: true });
    await writeFile(join(dir, "target.gguf"), body);
    await symlink(join(dir, "target.gguf"), join(dir, "download", s.artifacts[0].path));
    await expect(verifyDownloadedRelease(env, join(dir, "download"), join(dir, "store"), key.public_key_pem)).rejects.toThrow(/symbolic link|not a regular file/);
  });

  it("rejects torrent metadata substitution and undeclared files", () => {
    const s = statement();
    const good = {
      name: "example",
      piece_length: 262144,
      pieces_sha256: [s.artifacts[0].digests.sha256],
      files: [{ path: s.artifacts[0].path, size: s.artifacts[0].size, sha256: s.artifacts[0].digests.sha256 }],
      infohash_v1: s.transport.bittorrent.infohash_v1!,
      magnet_uri: s.transport.bittorrent.magnet_uri
    };
    expect(() => validateTorrentMetadataAgainstStatement(good, s)).not.toThrow();
    expect(() => validateTorrentMetadataAgainstStatement({ ...good, magnet_uri: "magnet:?xt=urn:btih:" + "d".repeat(40) }, s)).toThrow(/magnet URI/);
    expect(() => validateTorrentMetadataAgainstStatement({ ...good, files: [...good.files, { path: "extra.md", size: 1, sha256: "e".repeat(64) }] }, s)).toThrow(/undeclared/);
  });

  it("binds torrent web seeds to the signed manifest", async () => {
    const dir = await makeTemp("web-seeds");
    const releaseDir = join(dir, "release");
    const body = Buffer.from("GGUF".padEnd(24, "\0"));
    const digest = await import("../src/fsutil.js").then((m) => m.sha256Bytes(body));
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, "example-model-Q4_K_M.gguf"), body);
    const engine = new WebTorrentEngine({ dht: false, tracker: false });
    try {
      const created = await engine.create(releaseDir, { urlList: ["https://cdn.example.invalid/models/example-model/"] });
      const s = statement();
      s.artifacts[0].size = body.length;
      s.artifacts[0].digests.sha256 = digest;
      s.transport.bittorrent.magnet_uri = created.magnetURI;
      s.transport.bittorrent.infohash_v1 = created.infoHash;
      s.transport.bittorrent.torrent_file_sha256 = await import("../src/fsutil.js").then((m) => m.sha256Bytes(created.torrentFile));
      s.transport.bittorrent.web_seeds = ["https://cdn.example.invalid/models/example-model/"];
      await expect(validateTorrentFileAgainstStatement(created.torrentFile, s)).resolves.toBeUndefined();
      s.transport.bittorrent.web_seeds = [];
      await expect(validateTorrentFileAgainstStatement(created.torrentFile, s)).rejects.toThrow(/web seeds/);
    } finally {
      await engine.destroy();
    }
  });

  it("rejects catalogue manifest URLs that target local or private networks", () => {
    expect(() => validateCatalogueEntry({ release_id: "sha256:" + "a".repeat(64), name: "x", publisher: "p", architecture: "llama", formats: ["gguf"], size: 1, manifest_url: "http://127.0.0.1/manifest.json" })).toThrow(/forbidden/);
    expect(() => validateCatalogueEntry({ release_id: "sha256:" + "a".repeat(64), name: "x", publisher: "p", architecture: "llama", formats: ["gguf"], size: 1, manifest_url: "file:///tmp/manifest.json" })).toThrow(/HTTP/);
    expect(isForbiddenHostname("[::1]")).toBe(true);
    expect(isForbiddenHostname("::ffff:127.0.0.1")).toBe(true);
    expect(isForbiddenHostname("0.0.0.0")).toBe(true);
    expect(isForbiddenHostname("224.0.0.1")).toBe(true);
    expect(isForbiddenHostname("example.com")).toBe(false);
  });
});

async function makeTemp(name: string): Promise<string> {
  const dir = join(tmpdir(), `shardseed-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
