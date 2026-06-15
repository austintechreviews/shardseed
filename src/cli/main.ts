#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { generatePublisherKey, listKeys } from "../crypto/keys.js";
import { inspectFile } from "../inspect/gguf.js";
import { releaseId } from "../manifest/canonical.js";
import { parseEnvelope, parseEnvelopeJson, verifyEnvelope } from "../manifest/signing.js";
import { SignedEnvelope } from "../manifest/types.js";
import { publishRelease } from "../publish/publish.js";
import { defaultDataDir, quarantine, verifyDownloadedRelease } from "../storage/store.js";
import { readTorrentMetadata } from "../torrent/torrent.js";
import { validateTorrentFileAgainstStatement } from "../torrent/torrent.js";
import { readTransferState, startLocalTransfer, TransferState } from "../torrent/local-service.js";
import { WebTorrentEngine, startLocalTracker } from "../torrent/engine.js";
import { defaultTorrentJobsPath, readTorrentJobStore, runDownloadJob, runSeedJob } from "../torrent/jobs.js";
import { runLocalMeshTest } from "../torrent/mesh.js";
import fg from "fast-glob";

const program = new Command();
program.name("shardseed").description("Secure model distribution prototype").version("0.1.0");

const key = program.command("key").description("Manage local Ed25519 publisher keys");

key.command("generate")
  .option("--dir <dir>")
  .option("--name <name>", "key name", "publisher")
  .action(async (opts) => {
    const key = await generatePublisherKey(opts.dir, opts.name);
    console.log(JSON.stringify({ key_id: key.key_id, public_key_path: key.public_key_path, private_key_path: key.private_key_path }, null, 2));
  });

key.command("list")
  .option("--dir <dir>")
  .action(async (opts) => {
    console.log(JSON.stringify(await listKeys(opts.dir), null, 2));
  });

program.command("inspect <file>")
  .action(async (file) => console.log(JSON.stringify(await inspectFile(file), null, 2)));

const models = program.command("models").description("Discover local model directories without executing them");

models.command("list")
  .option("--root <dir>", "model root", "/Users/austinwells/.lmstudio/models")
  .action(async (opts) => {
    const files = await fg(["*/*/**/*.{gguf,safetensors}", "*/*/*.{gguf,safetensors}"], { cwd: opts.root, onlyFiles: true, unique: true });
    const dirs = new Map<string, { path: string; bytes: number; files: number }>();
    for (const file of files) {
      const parts = file.split("/");
      const dir = parts.length >= 3 ? parts.slice(0, 2).join("/") : parts.slice(0, -1).join("/");
      const full = join(opts.root, file);
      const st = await stat(full);
      const row = dirs.get(dir) ?? { path: join(opts.root, dir), bytes: 0, files: 0 };
      row.bytes += st.size;
      row.files += 1;
      dirs.set(dir, row);
    }
    console.log(JSON.stringify([...dirs.values()].sort((a, b) => a.path.localeCompare(b.path)), null, 2));
  });

const manifest = program.command("manifest").description("Validate and verify signed release manifests");

manifest.command("validate <manifest>")
  .action(async (manifest) => {
    const env = parseEnvelopeJson(await readFile(manifest, "utf8"));
    const statement = parseEnvelope(env);
    console.log(JSON.stringify({ ok: true, release_id: releaseId(statement) }, null, 2));
  });

manifest.command("verify <manifest>")
  .requiredOption("--public-key <path>")
  .action(async (manifest, opts) => {
    const env = parseEnvelopeJson(await readFile(manifest, "utf8"));
    const pub = await readFile(opts.publicKey, "utf8");
    const statement = verifyEnvelope(env, pub);
    console.log(JSON.stringify({ ok: true, release_id: releaseId(statement), publisher: statement.publisher }, null, 2));
  });

program.command("publish <directory>")
  .requiredOption("--key <private-key-path>")
  .requiredOption("--public-key <public-key-pem-path>")
  .requiredOption("--key-id <key-id>")
  .option("--out <dir>", "output directory", "dist-release")
  .option("--name <name>")
  .option("--release-version <version>", "release version", "1.0.0")
  .option("--description <description>", "description", "Local Shardseed release")
  .option("--namespace <namespace>", "publisher namespace", "local")
  .option("--slug <slug>")
  .option("--architecture <architecture>", "architecture", "unknown")
  .option("--publisher <publisher>", "publisher display name", "Local Publisher")
  .option("--tracker <announce-url>", "tracker announce URL", (value, previous: string[]) => [...previous, value], [])
  .option("--private-torrent", "disable DHT/PEX by marking the torrent private", false)
  .action(async (directory, opts) => {
    const publicKeyPem = await readFile(opts.publicKey, "utf8");
    const slug = opts.slug || basename(resolve(directory)).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const result = await publishRelease({
      directory,
      outDir: opts.out,
      name: opts.name || basename(resolve(directory)),
      version: opts.releaseVersion,
      description: opts.description,
      publisherNamespace: opts.namespace,
      modelSlug: slug,
      architecture: opts.architecture,
      publisherDisplayName: opts.publisher,
      publisherKeyId: opts.keyId,
      publicKeyPem,
      privateKeyPath: opts.key,
      trackers: opts.tracker,
      privateTorrent: opts.privateTorrent
    });
    console.log(JSON.stringify(result.summary, null, 2));
  });

const torrent = program.command("torrent").description("Create and test BitTorrent release transport");

torrent.command("info <torrent-file>")
  .action(async (torrentFile) => {
    const { parseTorrentInfo } = await import("../torrent/engine.js");
    console.log(JSON.stringify(await parseTorrentInfo(await readFile(torrentFile)), null, 2));
  });

torrent.command("verify <torrent-file>")
  .requiredOption("--manifest <signed-manifest>")
  .action(async (torrentFile, opts) => {
    const env = parseEnvelopeJson(await readFile(opts.manifest, "utf8"));
    const statement = parseEnvelope(env);
    await validateTorrentFileAgainstStatement(await readFile(torrentFile), statement);
    console.log(JSON.stringify({ ok: true, info_hash: statement.transport.bittorrent.infohash_v1, torrent_file_sha256: statement.transport.bittorrent.torrent_file_sha256 }, null, 2));
  });

torrent.command("create <directory>")
  .option("--out <path>", "torrent output", "release.torrent")
  .option("--tracker <announce-url>", "tracker announce URL")
  .option("--private", "disable DHT/PEX by marking the torrent private", false)
  .action(async (directory, opts) => {
    const engine = new WebTorrentEngine({ dht: false, tracker: false });
    try {
      const announce = opts.tracker ? [opts.tracker] : [];
      const created = await engine.create(directory, { announce, private: opts.private });
      await mkdir(dirname(resolve(opts.out)), { recursive: true });
      await import("node:fs/promises").then((fs) => fs.writeFile(opts.out, created.torrentFile));
      console.log(JSON.stringify({ info_hash: created.infoHash, magnet_uri: created.magnetURI, torrent_path: resolve(opts.out) }, null, 2));
    } finally {
      await engine.destroy();
    }
  });

torrent.command("download <torrent-file>")
  .requiredOption("--dest <download-directory>")
  .option("--jobs <path>", "torrent job store")
  .option("--select <path>", "select one file path from torrent", (value, previous: string[]) => [...previous, value], [])
  .option("--no-dht", "disable DHT peer discovery")
  .option("--port <port>", "TCP listen port")
  .option("--download-limit <bytes-per-second>")
  .option("--upload-limit <bytes-per-second>")
  .option("--no-wait", "start job, snapshot initial state, then exit")
  .action(async (torrentFile, opts) => {
    const job = await runDownloadJob({
      jobsPath: opts.jobs || defaultTorrentJobsPath(process.cwd()),
      torrentPath: torrentFile,
      contentDir: opts.dest,
      selectedFiles: opts.select,
      dht: opts.dht,
      torrentPort: opts.port ? Number(opts.port) : null,
      downloadLimitBps: opts.downloadLimit ? Number(opts.downloadLimit) : null,
      uploadLimitBps: opts.uploadLimit ? Number(opts.uploadLimit) : null,
      wait: opts.wait
    });
    console.log(JSON.stringify(job, null, 2));
  });

torrent.command("seed <torrent-file>")
  .requiredOption("--source <release-directory>")
  .option("--jobs <path>", "torrent job store")
  .option("--no-dht", "disable DHT peer discovery")
  .option("--port <port>", "TCP listen port")
  .option("--upload-limit <bytes-per-second>")
  .option("--wait", "keep seeding until interrupted", false)
  .action(async (torrentFile, opts) => {
    const job = await runSeedJob({
      jobsPath: opts.jobs || defaultTorrentJobsPath(process.cwd()),
      torrentPath: torrentFile,
      contentDir: opts.source,
      dht: opts.dht,
      torrentPort: opts.port ? Number(opts.port) : null,
      uploadLimitBps: opts.uploadLimit ? Number(opts.uploadLimit) : null,
      wait: opts.wait
    });
    console.log(JSON.stringify(job, null, 2));
  });

torrent.command("jobs")
  .option("--jobs <path>", "torrent job store")
  .action(async (opts) => {
    console.log(JSON.stringify(await readTorrentJobStore(opts.jobs || defaultTorrentJobsPath(process.cwd())), null, 2));
  });

torrent.command("resume <job-id>")
  .option("--jobs <path>", "torrent job store")
  .option("--wait", "wait until completion for downloads", true)
  .action(async (jobId, opts) => {
    const jobsPath = opts.jobs || defaultTorrentJobsPath(process.cwd());
    const store = await readTorrentJobStore(jobsPath);
    const job = store.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Torrent job not found: ${jobId}`);
    const runner = job.kind === "download" ? runDownloadJob : runSeedJob;
    const resumed = await runner({
      jobsPath,
      torrentPath: job.torrent_path,
      contentDir: job.content_dir,
      selectedFiles: job.selected_files,
      dht: job.dht,
      downloadLimitBps: job.download_limit_bps,
      uploadLimitBps: job.upload_limit_bps,
      torrentPort: null,
      wait: opts.wait,
      jobId: job.id
    });
    console.log(JSON.stringify(resumed, null, 2));
  });

torrent.command("tracker")
  .option("--host <host>", "bind host", "0.0.0.0")
  .option("--port <port>", "bind port", "8000")
  .option("--announce-host <host>", "host peers should use in announce URL")
  .option("--announce-port <port>", "port peers should use in announce URL")
  .action(async (opts) => {
    const tracker = await startLocalTracker({
      host: opts.host,
      port: Number(opts.port),
      announceHost: opts.announceHost,
      announcePort: opts.announcePort ? Number(opts.announcePort) : undefined
    });
    console.log(JSON.stringify({ listening: `${tracker.bindHost}:${tracker.port}`, announce: tracker.announce }, null, 2));
    await new Promise(() => undefined);
  });

torrent.command("smoke-test <directory>")
  .requiredOption("--dest <download-directory>")
  .action(async (directory, opts) => {
    const tracker = await startLocalTracker();
    const publisher = new WebTorrentEngine();
    const downloader = new WebTorrentEngine();
    try {
      const created = await publisher.create(directory, [tracker.announce]);
      const seed = await publisher.seed(directory, created.torrentFile, [tracker.announce]);
      const download = await downloader.download(created.torrentFile, opts.dest);
      await download.done();
      console.log(JSON.stringify({
        ok: true,
        tracker: tracker.announce,
        info_hash: created.infoHash,
        seed_info_hash: seed.infoHash,
        download_dir: resolve(opts.dest),
        progress: download.progress()
      }, null, 2));
    } finally {
      await Promise.allSettled([publisher.destroy(), downloader.destroy(), tracker.close()]);
    }
  });

program.command("fetch <manifest>")
  .requiredOption("--torrent <torrent-json>")
  .requiredOption("--source <seed-directory>")
  .requiredOption("--dest <download-directory>")
  .option("--state <path>")
  .option("--max-files <n>")
  .action(async (_manifest, opts) => {
    const torrent = await readTorrentMetadata(opts.torrent);
    const statePath = opts.state || join(opts.dest, ".shardseed-transfer.json");
    let state: TransferState;
    try {
      state = await readTransferState(statePath);
    } catch {
      state = { torrent, sourceDir: opts.source, destDir: opts.dest, completedFiles: [], statePath };
    }
    const updated = await startLocalTransfer(state, opts.maxFiles ? Number(opts.maxFiles) : undefined);
    console.log(JSON.stringify({ state: updated.completedFiles.length === torrent.files.length ? "Downloaded" : "Paused", completed_files: updated.completedFiles.length, total_files: torrent.files.length }, null, 2));
  });

program.command("verify <release-directory>")
  .requiredOption("--manifest <signed-manifest>")
  .requiredOption("--public-key <publisher-public-key-pem>")
  .option("--store <store-root>")
  .action(async (releaseDirectory, opts) => {
    const store = opts.store || defaultDataDir(process.cwd());
    const env = parseEnvelopeJson(await readFile(opts.manifest, "utf8"));
    const publicKeyPem = await readFile(opts.publicKey, "utf8");
    try {
      console.log(JSON.stringify(await verifyDownloadedRelease(env, releaseDirectory, store, publicKeyPem), null, 2));
    } catch (err) {
      const q = await quarantine(releaseDirectory, store, err instanceof Error ? err.message : "verification failed");
      throw new Error(`Torrent completed, but cryptographic verification failed. Quarantined at ${q}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

const catalogue = program.command("catalogue").description("Serve simple local catalogues");

catalogue.command("serve <directory>")
  .option("--port <port>", "port", "8787")
  .action(async (directory, opts) => {
    const http = await import("node:http");
    const server = http.createServer(async (req, res) => {
      const file = req.url === "/" ? "index.json" : req.url?.replace(/^\//, "") || "index.json";
      const path = resolve(directory, file);
      if (!path.startsWith(resolve(directory))) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        res.setHeader("content-type", file.endsWith(".json") ? "application/json" : "application/octet-stream");
        res.end(await readFile(path));
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    await mkdir(directory, { recursive: true });
    server.listen(Number(opts.port), "127.0.0.1", () => console.log(`catalogue listening on http://127.0.0.1:${opts.port}/`));
  });

const mesh = program.command("mesh").description("Run deterministic local multi-node torrent mesh tests");

mesh.command("test <source-directory>")
  .option("--nodes <count>", "node count, at least 2", "2")
  .option("--work-dir <dir>", "work directory for node state and artifacts")
  .option("--tracker <announce-url>", "external tracker announce URL")
  .option("--tracker-bind-host <host>", "internal tracker bind host", "127.0.0.1")
  .option("--tracker-port <port>", "internal tracker bind port")
  .option("--tracker-announce-host <host>", "internal tracker advertised host")
  .option("--no-dht", "disable DHT peer discovery")
  .option("--direct-peer-host <host>", "host used for direct in-process mesh peer bootstrap", "127.0.0.1")
  .option("--download-timeout-ms <ms>", "per-node download timeout", "90000")
  .option("--name <name>", "release name")
  .option("--slug <slug>", "release slug")
  .option("--architecture <architecture>", "model architecture", "test")
  .action(async (sourceDirectory, opts) => {
    const nodes = Number(opts.nodes);
    if (!Number.isSafeInteger(nodes) || nodes < 2) throw new Error("--nodes must be an integer >= 2");
    const report = await runLocalMeshTest({
      sourceDir: sourceDirectory,
      nodes,
      workDir: opts.workDir,
      trackerAnnounce: opts.tracker,
      trackerBindHost: opts.trackerBindHost,
      trackerPort: opts.trackerPort ? Number(opts.trackerPort) : undefined,
      trackerAnnounceHost: opts.trackerAnnounceHost,
      dht: opts.dht,
      directPeerHost: opts.directPeerHost,
      downloadTimeoutMs: Number(opts.downloadTimeoutMs),
      name: opts.name,
      slug: opts.slug,
      architecture: opts.architecture
    });
    console.log(JSON.stringify(report, null, 2));
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
