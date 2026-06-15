import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "../src/fsutil.js";
import { LocalTracker, normalizeTorrentPath, parseTorrentInfo, startLocalTracker, WebTorrentEngine } from "../src/torrent/engine.js";
import { readTorrentJobStore, runDownloadJob } from "../src/torrent/jobs.js";

const engines: WebTorrentEngine[] = [];
const trackers: LocalTracker[] = [];

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((e) => e.destroy()));
  await Promise.allSettled(trackers.splice(0).map((t) => t.close()));
});

describe("torrent resume and persisted jobs", () => {
  it("normalizes torrent library paths to manifest-safe separators", () => {
    expect(normalizeTorrentPath("release\\README.md")).toBe("release/README.md");
    expect(normalizeTorrentPath("release\\nested\\weights.gguf")).toBe("release/nested/weights.gguf");
  });

  it("parses generated torrent files with file, length, announce, and info hash metadata", async () => {
    const root = await makeTemp("torrent-info");
    const seedDir = join(root, "seed", "release");
    await mkdir(seedDir, { recursive: true });
    await writeFile(join(seedDir, "weights.gguf"), syntheticGguf(256 * 1024));
    await writeFile(join(seedDir, "README.md"), "info test\n");
    const tracker = await startLocalTracker();
    trackers.push(tracker);
    const engine = new WebTorrentEngine();
    engines.push(engine);
    const created = await engine.create(seedDir, [tracker.announce]);
    const info = await parseTorrentInfo(created.torrentFile);
    expect(info.infoHash).toBe(created.infoHash);
    expect(info.announce).toContain(tracker.announce);
    expect(info.files.map((file) => file.path).sort()).toEqual(["release/README.md", "release/weights.gguf"]);
    expect(info.length).toBeGreaterThan(256 * 1024);
  });

  it("resumes an interrupted real torrent download into the same destination", async () => {
    const root = await makeTemp("torrent-resume");
    const seedDir = join(root, "seed", "big-release");
    const downloadDir = join(root, "download");
    await mkdir(seedDir, { recursive: true });
    await writeFile(join(seedDir, "big-model-Q4_K_M.gguf"), syntheticGguf(6 * 1024 * 1024));
    await writeFile(join(seedDir, "config.json"), JSON.stringify({ model_type: "resume-test" }));

    const tracker = await startLocalTracker();
    trackers.push(tracker);
    const publisher = new WebTorrentEngine();
    const slowDownloader = new WebTorrentEngine({ downloadLimitBytesPerSecond: 96 * 1024 });
    engines.push(publisher, slowDownloader);
    const created = await publisher.create(seedDir, [tracker.announce]);
    const seed = await publisher.seed(seedDir, created.torrentFile, [tracker.announce]);
    expect(seed.infoHash).toBe(created.infoHash);

    const partial = await slowDownloader.download(created.torrentFile, downloadDir);
    await waitFor(() => partial.progress().downloaded > 128 * 1024, 12_000);
    const interruptedBytes = partial.progress().downloaded;
    expect(interruptedBytes).toBeGreaterThan(0);
    await partial.destroy();
    await slowDownloader.destroy();
    engines.splice(engines.indexOf(slowDownloader), 1);

    const resumedDownloader = new WebTorrentEngine();
    engines.push(resumedDownloader);
    const resumed = await resumedDownloader.download(created.torrentFile, downloadDir);
    await resumed.done();
    expect(resumed.progress().progress).toBe(1);
    expect(await sha256File(join(downloadDir, "big-release", "big-model-Q4_K_M.gguf"))).toBe(await sha256File(join(seedDir, "big-model-Q4_K_M.gguf")));
  }, 30_000);

  it("persists completed download job state with final progress", async () => {
    const root = await makeTemp("torrent-job");
    const seedDir = join(root, "seed", "job-release");
    const torrentPath = join(root, "job-release.torrent");
    const jobsPath = join(root, "jobs.json");
    const downloadDir = join(root, "download");
    await mkdir(seedDir, { recursive: true });
    await writeFile(join(seedDir, "job-model-Q4_K_M.gguf"), syntheticGguf(384 * 1024));

    const tracker = await startLocalTracker();
    trackers.push(tracker);
    const publisher = new WebTorrentEngine();
    engines.push(publisher);
    const created = await publisher.create(seedDir, [tracker.announce]);
    await writeFile(torrentPath, created.torrentFile);
    await publisher.seed(seedDir, created.torrentFile, [tracker.announce]);

    const job = await runDownloadJob({ jobsPath, torrentPath, contentDir: downloadDir, wait: true });
    expect(job.status).toBe("Completed");
    const store = await readTorrentJobStore(jobsPath);
    expect(store.jobs[0]).toMatchObject({ id: job.id, info_hash: created.infoHash, status: "Completed" });
    expect(store.jobs[0].progress?.progress).toBe(1);
    expect(await readFile(join(downloadDir, "job-release", "job-model-Q4_K_M.gguf"))).toHaveLength(384 * 1024);
  }, 30_000);
});

function syntheticGguf(size: number): Buffer {
  const b = Buffer.alloc(size, 0x42);
  b.write("GGUF", 0, "ascii");
  b.writeUInt32LE(3, 4);
  b.writeBigUInt64LE(1n, 8);
  b.writeBigUInt64LE(0n, 16);
  return b;
}

async function makeTemp(name: string): Promise<string> {
  const dir = join(tmpdir(), `shardseed-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for torrent progress");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
