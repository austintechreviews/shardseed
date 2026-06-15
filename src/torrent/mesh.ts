import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePublisherKey } from "../crypto/keys.js";
import { releaseId } from "../manifest/canonical.js";
import { parseEnvelopeJson } from "../manifest/signing.js";
import { publishRelease } from "../publish/publish.js";
import { verifyDownloadedRelease, VerifyResult } from "../storage/store.js";
import { LocalTracker, parseTorrentInfo, startLocalTracker, TorrentProgress, WebTorrentEngine } from "./engine.js";
import { validateTorrentFileAgainstStatement } from "./torrent.js";

export interface MeshTestOptions {
  sourceDir: string;
  nodes: number;
  workDir?: string;
  name?: string;
  slug?: string;
  architecture?: string;
  trackerAnnounce?: string;
  trackerBindHost?: string;
  trackerPort?: number;
  trackerAnnounceHost?: string;
  dht?: boolean;
  directPeerHost?: string;
  downloadTimeoutMs?: number;
}

export interface MeshNodeReport {
  node_id: string;
  role: "publisher" | "downloader-seeder" | "downloader";
  download_dir?: string;
  verified_dir?: string;
  release_id: string;
  info_hash: string;
  progress?: TorrentProgress;
  verified_files?: VerifyResult["files"];
  direct_peers?: string[];
}

export interface MeshTestReport {
  ok: boolean;
  nodes: number;
  work_dir: string;
  tracker: string;
  release_id: string;
  info_hash: string;
  manifest_path: string;
  torrent_path: string;
  handoff_verified: boolean;
  node_reports: MeshNodeReport[];
}

export async function runLocalMeshTest(opts: MeshTestOptions): Promise<MeshTestReport> {
  const workDir = opts.workDir ?? join(tmpdir(), `shardseed-mesh-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workDir, { recursive: true });
  if (!Number.isSafeInteger(opts.nodes) || opts.nodes < 2) throw new Error("Mesh tests require at least 2 nodes");
  const tracker = opts.trackerAnnounce ? null : await startLocalTracker({
    host: opts.trackerBindHost,
    port: opts.trackerPort,
    announceHost: opts.trackerAnnounceHost
  });
  const trackerAnnounce = opts.trackerAnnounce ?? tracker!.announce;
  const directPeerHost = opts.directPeerHost ?? "127.0.0.1";
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? 90_000;
  const engines: WebTorrentEngine[] = [];
  const seedPeers: string[] = [];
  try {
    const key = await generatePublisherKey(join(workDir, "keys"), "mesh-publisher");
    const publication = await publishRelease({
      directory: opts.sourceDir,
      outDir: join(workDir, "publication"),
      name: opts.name ?? "Shardseed Mesh Fixture",
      version: "1.0.0",
      description: "Local mesh test release",
      publisherNamespace: "mesh",
      modelSlug: opts.slug ?? "mesh-fixture",
      architecture: opts.architecture ?? "test",
      publisherDisplayName: "Shardseed Mesh Test",
      publisherKeyId: key.key_id,
      publicKeyPem: key.public_key_pem,
      privateKeyPath: key.private_key_path!,
      trackers: [trackerAnnounce]
    });
    const torrentFile = await readFile(publication.summary.torrent_path);
    await validateTorrentFileAgainstStatement(torrentFile, publication.statement);
    const torrentInfo = await parseTorrentInfo(torrentFile);
    const envelope = parseEnvelopeJson(await readFile(publication.summary.manifest_path, "utf8"));
    const rid = releaseId(publication.statement);

    const publisher = new WebTorrentEngine({ dht: opts.dht ?? true });
    engines.push(publisher);
    const publisherSeed = await publisher.seed(opts.sourceDir, torrentFile, { announce: [trackerAnnounce] });
    seedPeers.push(await waitForPeerAddress(publisher, directPeerHost, "node-1"));
    const nodeReports: MeshNodeReport[] = [{
      node_id: "node-1",
      role: "publisher",
      release_id: rid,
      info_hash: publisherSeed.infoHash,
      progress: publisherSeed.progress(),
      direct_peers: [...seedPeers]
    }];

    for (let i = 2; i <= opts.nodes; i++) {
      const role = i === opts.nodes ? "downloader" : "downloader-seeder";
      if (i === 3) {
        await publisher.destroy();
        const publisherIndex = engines.indexOf(publisher);
        if (publisherIndex !== -1) engines.splice(publisherIndex, 1);
      }
      const node = await downloadVerifyAndSeed({
        nodeId: `node-${i}`,
        role,
        workDir,
        torrentFile,
        torrentRoot: torrentInfo.name,
        envelope,
        publicKeyPem: key.public_key_pem,
        releaseId: rid,
        infoHash: torrentInfo.infoHash,
        engines,
        dht: opts.dht ?? true,
        directPeers: [...seedPeers],
        directPeerHost,
        downloadTimeoutMs
      });
      nodeReports.push(node.report);
      if (node.seedPeer) seedPeers.push(node.seedPeer);
    }
    const handoffVerified = opts.nodes >= 3;

    return {
      ok: true,
      nodes: opts.nodes,
      work_dir: workDir,
      tracker: trackerAnnounce,
      release_id: rid,
      info_hash: torrentInfo.infoHash,
      manifest_path: publication.summary.manifest_path,
      torrent_path: publication.summary.torrent_path,
      handoff_verified: handoffVerified,
      node_reports: nodeReports
    };
  } finally {
    await Promise.allSettled(engines.map((engine) => engine.destroy()));
    await tracker?.close();
  }
}

async function downloadVerifyAndSeed(args: {
  nodeId: string;
  role: "downloader" | "downloader-seeder";
  workDir: string;
  torrentFile: Buffer;
  torrentRoot: string;
  envelope: ReturnType<typeof parseEnvelopeJson>;
  publicKeyPem: string;
  releaseId: string;
  infoHash: string;
  engines: WebTorrentEngine[];
  dht: boolean;
  directPeers: string[];
  directPeerHost: string;
  downloadTimeoutMs: number;
}): Promise<{ report: MeshNodeReport; seedRoot: string; seedPeer?: string }> {
  const downloadRoot = join(args.workDir, args.nodeId, "downloads");
  const storeRoot = join(args.workDir, args.nodeId, "store");
  const downloader = new WebTorrentEngine({ dht: args.dht });
  args.engines.push(downloader);
  const download = await downloader.download(args.torrentFile, downloadRoot);
  for (const peer of args.directPeers) download.addPeer(peer);
  await waitForDoneWithDiagnostics(download, args.nodeId, args.downloadTimeoutMs, args.directPeers);
  const releaseRoot = join(downloadRoot, args.torrentRoot);
  const verified = await verifyDownloadedRelease(args.envelope, releaseRoot, storeRoot, args.publicKeyPem);
  if (verified.release_id !== args.releaseId) throw new Error(`Mesh node ${args.nodeId} verified the wrong release ID`);
  let seedPeer: string | undefined;
  if (args.role === "downloader-seeder") {
    const seeder = new WebTorrentEngine({ dht: args.dht });
    args.engines.push(seeder);
    await seeder.seed(releaseRoot, args.torrentFile);
    seedPeer = await waitForPeerAddress(seeder, args.directPeerHost, args.nodeId);
  }
  return {
    seedRoot: releaseRoot,
    seedPeer,
    report: {
      node_id: args.nodeId,
      role: args.role,
      download_dir: releaseRoot,
      verified_dir: verified.verified_dir,
      release_id: verified.release_id,
      info_hash: args.infoHash,
      progress: download.progress(),
      verified_files: verified.files,
      direct_peers: args.directPeers
    }
  };
}

async function waitForPeerAddress(engine: WebTorrentEngine, host: string, nodeId: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const address = engine.address();
    if (address?.port) return `${host}:${address.port}`;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${nodeId} to expose a torrent listen port`);
}

async function waitForDoneWithDiagnostics(session: { done(): Promise<void>; progress(): TorrentProgress }, nodeId: string, timeoutMs: number, directPeers: string[]): Promise<void> {
  let last = session.progress();
  const sampler = setInterval(() => {
    last = session.progress();
  }, 500);
  try {
    await Promise.race([
      session.done(),
      sleep(timeoutMs).then(() => {
        const files = last.files.map((file) => `${file.path}:${file.downloaded ?? 0}/${file.length}`).join(", ");
        throw new Error(`${nodeId} torrent download timed out after ${timeoutMs}ms; peers=${last.peers}; downloaded=${last.downloaded}/${last.total}; direct_peers=${directPeers.join(",") || "none"}; files=${files}`);
      })
    ]);
  } finally {
    clearInterval(sampler);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
