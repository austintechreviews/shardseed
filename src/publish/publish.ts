import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import mime from "mime-types";
import { readPrivateKey } from "../crypto/keys.js";
import { atomicWrite, sha256Bytes } from "../fsutil.js";
import { inspectFile } from "../inspect/gguf.js";
import { releaseId } from "../manifest/canonical.js";
import { signStatement } from "../manifest/signing.js";
import { Artifact, RELEASE_SCHEMA, ReleaseStatement, SignedEnvelope } from "../manifest/types.js";
import { assertSafeExtension, validateArtifactPath, validateStatement } from "../manifest/validate.js";
import { WebTorrentEngine } from "../torrent/engine.js";
import { discoverFiles } from "../torrent/torrent.js";

export interface PublishOptions {
  directory: string;
  outDir: string;
  name: string;
  version: string;
  description: string;
  publisherNamespace: string;
  modelSlug: string;
  architecture: string;
  publisherDisplayName: string;
  publisherKeyId: string;
  publicKeyPem: string;
  privateKeyPath: string;
  trackers?: string[];
  webSeeds?: string[];
  privateTorrent?: boolean;
}

export interface PublicationSummary {
  release_id: string;
  manifest_path: string;
  torrent_path: string;
  magnet_uri: string;
  publisher_key_fingerprint: string;
  total_release_size: number;
  artifact_count: number;
  seeding_active: boolean;
}

export async function publishRelease(opts: PublishOptions): Promise<{ statement: ReleaseStatement; envelope: SignedEnvelope; summary: PublicationSummary }> {
  await mkdir(opts.outDir, { recursive: true });
  const trackers = opts.trackers ?? [];
  const webSeeds = opts.webSeeds ?? [];
  const torrentPath = join(opts.outDir, `${opts.modelSlug}.torrent`);
  const engine = new WebTorrentEngine({ dht: false, tracker: false });
  let torrent;
  try {
    torrent = await engine.create(opts.directory, { announce: trackers, urlList: webSeeds, private: opts.privateTorrent ?? false });
  } finally {
    await engine.destroy();
  }
  await atomicWrite(torrentPath, torrent.torrentFile);
  const torrentFileHash = sha256Bytes(torrent.torrentFile);
  const files = await discoverFiles(opts.directory);
  const artifacts: Artifact[] = [];
  for (const file of files) {
    validateArtifactPath(file.path);
    assertSafeExtension(file.path);
    const full = join(opts.directory, file.path);
    const inspection = await inspectFile(full);
    artifacts.push({
      path: file.path,
      role: file.path.toLowerCase().endsWith(".gguf") || file.path.toLowerCase().endsWith(".safetensors") ? "weights" : "metadata",
      media_type: mime.lookup(file.path) || "application/octet-stream",
      size: (await stat(full)).size,
      digests: { sha256: file.sha256 },
      format: { family: inspection.file_format, version: inspection.gguf_version, quantisation: inspection.quantisation }
    });
  }
  const statement: ReleaseStatement = {
    schema: RELEASE_SCHEMA,
    release: { name: opts.name, version: opts.version, created_at: new Date().toISOString(), description: opts.description },
    model: {
      publisher_namespace: opts.publisherNamespace,
      model_slug: opts.modelSlug,
      architecture: opts.architecture,
      parameter_count: null,
      formats: [...new Set(artifacts.map((a) => a.format.family))]
    },
    artifacts,
    transport: {
      bittorrent: {
        magnet_uri: torrent.magnetURI,
        infohash_v1: torrent.infoHash,
        infohash_v2: null,
        torrent_file_sha256: torrentFileHash,
        trackers,
        web_seeds: webSeeds
      }
    },
    lineage: { parents: [] },
    licensing: { weights: { expression: "LicenseRef-Unknown", text_path: null, source_url: null, redistribution_claimed: false } },
    security: { contains_executable_code: false, requires_custom_code: false, serialization_risk: "data-only" },
    publisher: { display_name: opts.publisherDisplayName, key_id: opts.publisherKeyId }
  };
  validateStatement(statement);
  const privatePem = await readPrivateKey(opts.privateKeyPath);
  const envelope = signStatement(statement, privatePem, opts.publicKeyPem);
  const manifestPath = join(opts.outDir, `${opts.modelSlug}.dsse.json`);
  await atomicWrite(manifestPath, JSON.stringify(envelope, null, 2));
  const summary: PublicationSummary = {
    release_id: releaseId(statement),
    manifest_path: manifestPath,
    torrent_path: torrentPath,
    magnet_uri: torrent.magnetURI,
    publisher_key_fingerprint: opts.publisherKeyId,
    total_release_size: artifacts.reduce((sum, a) => sum + a.size, 0),
    artifact_count: artifacts.length,
    seeding_active: false
  };
  await atomicWrite(join(opts.outDir, `${opts.modelSlug}.publication.json`), JSON.stringify(summary, null, 2));
  await atomicWrite(join(opts.outDir, `${opts.modelSlug}.magnet.txt`), `${torrent.magnetURI}\n`);
  return { statement, envelope, summary };
}
