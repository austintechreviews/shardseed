import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { generatePublisherKey } from "../src/crypto/keys.js";
import { sha256Bytes, sha256File } from "../src/fsutil.js";
import { releaseId } from "../src/manifest/canonical.js";
import { parseEnvelopeJson } from "../src/manifest/signing.js";
import { publishRelease } from "../src/publish/publish.js";
import { verifyDownloadedRelease } from "../src/storage/store.js";
import { LocalTracker, startLocalTracker, WebTorrentEngine } from "../src/torrent/engine.js";
import { validateTorrentFileAgainstStatement } from "../src/torrent/torrent.js";

const engines: WebTorrentEngine[] = [];
const trackers: LocalTracker[] = [];

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((e) => e.destroy()));
  await Promise.allSettled(trackers.splice(0).map((t) => t.close()));
});

describe("publish, torrent download, and verify", () => {
  it("publishes a signed release, downloads by real torrent, verifies hashes, and materializes the store", async () => {
    const root = await makeTemp("e2e");
    const modelDir = join(root, "publisher", "tiny-model");
    const outDir = join(root, "publication");
    const downloadRoot = join(root, "download");
    const storeRoot = join(root, "client-store");
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, "tiny-model-Q4_K_M.gguf"), syntheticGguf(384 * 1024));
    await writeFile(join(modelDir, "config.json"), JSON.stringify({ architectures: ["TinyForCausalLM"], model_type: "tiny" }));
    await writeFile(join(modelDir, "README.md"), "Tiny local Shardseed test release\n");

    const key = await generatePublisherKey(join(root, "keys"), "publisher");
    const tracker = await startLocalTracker();
    trackers.push(tracker);

    const publication = await publishRelease({
      directory: modelDir,
      outDir,
      name: "Tiny Model",
      version: "1.0.0",
      description: "Torrent e2e fixture",
      publisherNamespace: "local",
      modelSlug: "tiny-model",
      architecture: "tiny",
      publisherDisplayName: "Local Publisher",
      publisherKeyId: key.key_id,
      publicKeyPem: key.public_key_pem,
      privateKeyPath: key.private_key_path!,
      trackers: [tracker.announce]
    });

    expect(publication.statement.transport.bittorrent.torrent_file_sha256).toBe(await sha256File(publication.summary.torrent_path));
    expect(publication.summary.release_id).toBe(releaseId(publication.statement));

    const publisher = new WebTorrentEngine();
    const downloader = new WebTorrentEngine();
    engines.push(publisher, downloader);
    const torrentFile = await readFile(publication.summary.torrent_path);
    await expect(validateTorrentFileAgainstStatement(torrentFile, publication.statement)).resolves.toBeUndefined();
    const substituted = Buffer.from(torrentFile);
    substituted[substituted.length - 1] ^= 0xff;
    await expect(validateTorrentFileAgainstStatement(substituted, publication.statement)).rejects.toThrow(/SHA-256/);
    const seed = await publisher.seed(modelDir, torrentFile, [tracker.announce]);
    expect(seed.infoHash).toBe(publication.statement.transport.bittorrent.infohash_v1);
    const download = await downloader.download(torrentFile, downloadRoot);
    await download.done();

    const manifest = parseEnvelopeJson(await readFile(publication.summary.manifest_path, "utf8"));
    const verified = await verifyDownloadedRelease(manifest, join(downloadRoot, "tiny-model"), storeRoot, key.public_key_pem);
    expect(verified.release_id).toBe(publication.summary.release_id);
    expect(await sha256File(join(verified.verified_dir, "files", "tiny-model-Q4_K_M.gguf"))).toBe(publication.statement.artifacts.find((a) => a.path.endsWith(".gguf"))?.digests.sha256);
  }, 30_000);

  it("quarantines by failing verification when a downloaded byte is corrupted", async () => {
    const root = await makeTemp("corrupt");
    const modelDir = join(root, "publisher", "tiny-model");
    const outDir = join(root, "publication");
    const downloadDir = join(root, "download", "tiny-model");
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, "tiny-model-Q4_K_M.gguf"), syntheticGguf(64 * 1024));
    const key = await generatePublisherKey(join(root, "keys"), "publisher");
    const publication = await publishRelease({
      directory: modelDir,
      outDir,
      name: "Tiny Model",
      version: "1.0.0",
      description: "Corruption fixture",
      publisherNamespace: "local",
      modelSlug: "tiny-model",
      architecture: "tiny",
      publisherDisplayName: "Local Publisher",
      publisherKeyId: key.key_id,
      publicKeyPem: key.public_key_pem,
      privateKeyPath: key.private_key_path!
    });
    await mkdir(downloadDir, { recursive: true });
    const corrupted = syntheticGguf(64 * 1024);
    corrupted[128] ^= 0xff;
    await writeFile(join(downloadDir, "tiny-model-Q4_K_M.gguf"), corrupted);
    const manifest = parseEnvelopeJson(await readFile(publication.summary.manifest_path, "utf8"));
    await expect(verifyDownloadedRelease(manifest, downloadDir, join(root, "store"), key.public_key_pem)).rejects.toThrow(/hash does not match/);
  });
});

function syntheticGguf(size: number): Buffer {
  const b = Buffer.alloc(size, 0x5a);
  b.write("GGUF", 0, "ascii");
  b.writeUInt32LE(3, 4);
  b.writeBigUInt64LE(1n, 8);
  b.writeBigUInt64LE(0n, 16);
  sha256Bytes(b);
  return b;
}

async function makeTemp(name: string): Promise<string> {
  const dir = join(tmpdir(), `shardseed-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
