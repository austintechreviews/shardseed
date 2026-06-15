import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WebTorrentEngine, startLocalTracker, LocalTracker } from "../src/torrent/engine.js";
import { sha256File } from "../src/fsutil.js";

const engines: WebTorrentEngine[] = [];
const trackers: LocalTracker[] = [];

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((e) => e.destroy()));
  await Promise.allSettled(trackers.splice(0).map((t) => t.close()));
});

describe("torrent layer first", () => {
  it("creates a torrent, seeds it through a local tracker, downloads it, and verifies bytes", async () => {
    const root = await makeTemp("torrent");
    const seedDir = join(root, "seed", "tiny-model");
    const downloadDir = join(root, "download");
    await mkdir(seedDir, { recursive: true });
    await writeFile(join(seedDir, "tiny-model-Q4_K_M.gguf"), syntheticGguf(768 * 1024));
    await writeFile(join(seedDir, "README.md"), "tiny local release\n");

    const tracker = await startLocalTracker();
    trackers.push(tracker);
    const publisher = new WebTorrentEngine();
    const downloader = new WebTorrentEngine();
    engines.push(publisher, downloader);

    const created = await publisher.create(seedDir, [tracker.announce]);
    expect(created.infoHash).toMatch(/^[0-9a-f]{40}$/);
    const seed = await publisher.seed(seedDir, created.torrentFile, [tracker.announce]);
    expect(seed.infoHash).toBe(created.infoHash);

    const download = await downloader.download(created.torrentFile, downloadDir);
    await download.done();

    expect(await sha256File(join(downloadDir, "tiny-model", "tiny-model-Q4_K_M.gguf"))).toBe(await sha256File(join(seedDir, "tiny-model-Q4_K_M.gguf")));
    expect(await readFile(join(downloadDir, "tiny-model", "README.md"), "utf8")).toBe("tiny local release\n");
    expect(download.progress().progress).toBe(1);
  }, 30_000);
});

function syntheticGguf(size: number): Buffer {
  const b = Buffer.alloc(size, 0x5a);
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
