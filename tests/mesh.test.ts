import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runLocalMeshTest } from "../src/torrent/mesh.js";

describe("local torrent mesh", () => {
  it("runs a two-node publish/download/verify mesh", async () => {
    const root = await makeTemp("mesh-2");
    const sourceDir = join(root, "source", "mesh-model");
    await writeFixture(sourceDir, 768 * 1024);
    const report = await runLocalMeshTest({
      sourceDir,
      nodes: 2,
      workDir: join(root, "mesh"),
      name: "Mesh Two Node",
      slug: "mesh-two-node",
      dht: false
    });
    expect(report.ok).toBe(true);
    expect(report.nodes).toBe(2);
    expect(report.node_reports).toHaveLength(2);
    expect(report.node_reports[1].progress?.progress).toBe(1);
    expect(report.node_reports[1].release_id).toBe(report.release_id);
  }, 30_000);

  it("runs a three-node handoff mesh where node 3 downloads after node 1 stops", async () => {
    const root = await makeTemp("mesh-3");
    const sourceDir = join(root, "source", "mesh-model");
    await writeFixture(sourceDir, 2 * 1024 * 1024);
    const report = await runLocalMeshTest({
      sourceDir,
      nodes: 3,
      workDir: join(root, "mesh"),
      name: "Mesh Three Node",
      slug: "mesh-three-node",
      dht: false
    });
    expect(report.ok).toBe(true);
    expect(report.nodes).toBe(3);
    expect(report.handoff_verified).toBe(true);
    expect(report.node_reports.map((node) => node.role)).toEqual(["publisher", "downloader-seeder", "downloader"]);
    expect(report.node_reports[2].progress?.progress).toBe(1);
    expect(report.node_reports[2].release_id).toBe(report.release_id);
  }, 45_000);

  it("runs a five-node cascade mesh with intermediate seeders", async () => {
    const root = await makeTemp("mesh-5");
    const sourceDir = join(root, "source", "mesh-model");
    await writeFixture(sourceDir, 1024 * 1024);
    const report = await runLocalMeshTest({
      sourceDir,
      nodes: 5,
      workDir: join(root, "mesh"),
      name: "Mesh Five Node",
      slug: "mesh-five-node",
      dht: false
    });
    expect(report.ok).toBe(true);
    expect(report.nodes).toBe(5);
    expect(report.handoff_verified).toBe(true);
    expect(report.node_reports.map((node) => node.role)).toEqual([
      "publisher",
      "downloader-seeder",
      "downloader-seeder",
      "downloader-seeder",
      "downloader"
    ]);
    expect(report.node_reports.every((node) => node.release_id === report.release_id)).toBe(true);
    expect(report.node_reports.at(-1)?.progress?.progress).toBe(1);
  }, 60_000);
});

async function writeFixture(dir: string, size: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const b = Buffer.alloc(size, 0x33);
  b.write("GGUF", 0, "ascii");
  b.writeUInt32LE(3, 4);
  b.writeBigUInt64LE(1n, 8);
  b.writeBigUInt64LE(0n, 16);
  await writeFile(join(dir, "mesh-model-Q4_K_M.gguf"), b);
  await writeFile(join(dir, "config.json"), JSON.stringify({ model_type: "mesh-test" }));
  await writeFile(join(dir, "README.md"), "Shardseed mesh fixture\n");
}

async function makeTemp(name: string): Promise<string> {
  const dir = join(tmpdir(), `shardseed-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
