import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fail } from "./errors.js";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function sha256RegularFile(path: string): Promise<{ sha256: string; size: number; dev: number; ino: number; mtimeMs: number }> {
  const before = await lstat(path);
  if (!before.isFile()) fail("fs.not_regular", `Refusing to hash non-regular file: ${path}`);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = fd.createReadStream({ autoClose: false });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    const after = await fd.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail("fs.race", `File changed during verification: ${path}`);
    }
    return { sha256: hash.digest("hex"), size: after.size, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs };
  } finally {
    await fd.close();
  }
}

export function sha256Bytes(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function atomicWrite(path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

export async function copyRegularFileAtomic(src: string, dest: string, mode = 0o444): Promise<void> {
  const before = await lstat(src);
  if (!before.isFile()) fail("fs.not_regular", `Refusing to copy non-regular file: ${src}`);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${randomBytes(8).toString("hex")}`;
  const inFd = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  let outFd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    outFd = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await inFd.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await outFd.write(buffer, 0, bytesRead);
      position += bytesRead;
    }
    await outFd.sync();
    await outFd.close();
    outFd = null;
    const after = await inFd.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail("fs.race", `File changed during copy: ${src}`);
    }
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    if (outFd) await outFd.close().catch(() => undefined);
    await inFd.close();
  }
}

export function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
