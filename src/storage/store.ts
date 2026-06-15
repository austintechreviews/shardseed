import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fail } from "../errors.js";
import { atomicWrite, copyRegularFileAtomic, sha256RegularFile } from "../fsutil.js";
import { releaseId } from "../manifest/canonical.js";
import { verifyEnvelope } from "../manifest/signing.js";
import { ReleaseStatement, SignedEnvelope } from "../manifest/types.js";
import { validateArtifactPath } from "../manifest/validate.js";

export interface VerifyResult {
  release_id: string;
  verified_dir: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export function defaultDataDir(root: string): string {
  return join(root, ".shardseed-data");
}

export async function verifyDownloadedRelease(envelope: SignedEnvelope, downloadDir: string, storeRoot: string, publicKeyPem: string): Promise<VerifyResult> {
  const statement = verifyEnvelope(envelope, publicKeyPem);
  const rid = releaseId(statement);
  await assertNoUndeclaredFiles(statement, downloadDir);
  for (const artifact of statement.artifacts) {
    validateArtifactPath(artifact.path);
    const full = join(downloadDir, artifact.path);
    const st = await lstat(full).catch(() => null);
    if (!st) fail("verify.missing_file", `Downloaded file is missing: ${artifact.path}`);
    if (!st.isFile()) fail("verify.not_regular", `Downloaded artifact is not a regular file: ${artifact.path}`);
    if (st.size !== artifact.size) fail("verify.size_mismatch", `Downloaded file size does not match manifest: ${artifact.path}`);
    const got = await sha256RegularFile(full);
    if (got.sha256 !== artifact.digests.sha256) fail("verify.hash_mismatch", `Downloaded file hash does not match manifest: ${artifact.path}`);
  }
  const releaseDirName = rid.replace("sha256:", "sha256-");
  const releaseDir = join(storeRoot, "store", "releases", releaseDirName);
  const filesDir = join(releaseDir, "files");
  await mkdir(filesDir, { recursive: true });
  await atomicWrite(join(releaseDir, "manifest.json"), JSON.stringify(envelope, null, 2));
  await atomicWrite(join(releaseDir, "release.json"), JSON.stringify(statement, null, 2));
  for (const artifact of statement.artifacts) {
    const src = join(downloadDir, artifact.path);
    const blob = join(storeRoot, "store", "blobs", "sha256", artifact.digests.sha256.slice(0, 2), artifact.digests.sha256);
    await mkdir(dirname(blob), { recursive: true });
    await copyVerifiedContent(src, blob, artifact.digests.sha256);
    const mat = join(filesDir, artifact.path);
    await mkdir(dirname(mat), { recursive: true });
    await copyVerifiedContent(blob, mat, artifact.digests.sha256);
  }
  await writeState(storeRoot, { release_id: rid, state: "Verified", path: releaseDir, updated_at: new Date().toISOString() });
  return {
    release_id: rid,
    verified_dir: releaseDir,
    files: statement.artifacts.map((a) => ({ path: a.path, size: a.size, sha256: a.digests.sha256 }))
  };
}

export async function quarantine(downloadDir: string, storeRoot: string, reason: string): Promise<string> {
  const target = join(storeRoot, "downloads", "quarantine", `${Date.now()}-${reason.replace(/[^a-z0-9_-]+/gi, "_")}`);
  await mkdir(dirname(target), { recursive: true });
  await rename(downloadDir, target).catch(async () => {
    await mkdir(target, { recursive: true });
  });
  await writeFile(join(target, "QUARANTINE_REASON.txt"), `${reason}\n`);
  return target;
}

async function assertNoUndeclaredFiles(statement: ReleaseStatement, dir: string): Promise<void> {
  const declared = new Set(statement.artifacts.map((a) => a.path));
  async function walk(base: string): Promise<void> {
    for (const ent of await readdir(base, { withFileTypes: true })) {
      const full = join(base, ent.name);
      if (ent.isDirectory()) await walk(full);
      else {
        const rel = resolve(full).slice(resolve(dir).length + 1).replaceAll("\\", "/");
        if (ent.isSymbolicLink()) fail("verify.symlink", `Release contains a symbolic link: ${rel}`);
        const st = await lstat(full);
        if (!st.isFile()) fail("verify.special_file", `Release contains a non-regular file: ${rel}`);
        if (!declared.has(rel)) fail("verify.undeclared_file", `Release contains an undeclared file: ${rel}`);
      }
    }
  }
  await walk(dir);
}

async function copyVerifiedContent(src: string, dest: string, expectedSha256: string): Promise<void> {
  const existing = await lstat(dest).catch(() => null);
  if (existing) {
    if (!existing.isFile()) fail("store.destination", `Trusted-store destination is not a regular file: ${dest}`);
    const digest = await sha256RegularFile(dest);
    if (digest.sha256 !== expectedSha256) fail("store.destination", `Trusted-store destination already exists with different content: ${dest}`);
    await chmod(dest, 0o444).catch(() => undefined);
    return;
  }
  await copyRegularFileAtomic(src, dest, 0o444);
  const written = await sha256RegularFile(dest);
  if (written.sha256 !== expectedSha256) fail("store.destination", `Trusted-store materialized content does not match expected digest: ${dest}`);
  await chmod(dest, 0o444).catch(() => undefined);
}

async function writeState(root: string, row: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  const path = join(root, "catalogue.db.json");
  const existing: unknown[] = await readFile(path, "utf8").then((s) => JSON.parse(s) as unknown[]).catch(() => [] as unknown[]);
  existing.push(row);
  await atomicWrite(path, JSON.stringify(existing, null, 2));
}
