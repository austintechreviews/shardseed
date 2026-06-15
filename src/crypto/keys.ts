import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { base64Url, sha256Bytes } from "../fsutil.js";
import { fail } from "../errors.js";

export interface KeyRecord {
  key_id: string;
  public_key_pem: string;
  public_key_path?: string;
  private_key_path?: string;
  created_at: string;
}

export function defaultKeyDir(): string {
  return join(homedir(), ".shardseed", "keys");
}

export function keyIdFromPublicPem(publicPem: string): string {
  const der = createPublicKey(publicPem).export({ type: "spki", format: "der" }) as Buffer;
  return `ed25519:${base64Url(Buffer.from(sha256Bytes(der), "hex")).slice(0, 32)}`;
}

export async function generatePublisherKey(dir = defaultKeyDir(), name = "publisher"): Promise<KeyRecord> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyId = keyIdFromPublicPem(publicPem);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const stem = `${name}-${keyId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const privPath = join(dir, `${stem}.private.pem`);
  const publicPemPath = join(dir, `${stem}.public.pem`);
  const pubPath = join(dir, `${stem}.public.json`);
  await writeFile(privPath, privatePem, { mode: 0o600 });
  await chmod(privPath, 0o600).catch(() => undefined);
  await writeFile(publicPemPath, publicPem, { mode: 0o644 });
  const record: KeyRecord = { key_id: keyId, public_key_pem: publicPem, public_key_path: publicPemPath, private_key_path: privPath, created_at: new Date().toISOString() };
  await writeFile(pubPath, JSON.stringify(record, null, 2), { mode: 0o644 });
  return record;
}

export async function listKeys(dir = defaultKeyDir()): Promise<KeyRecord[]> {
  const files = await readdir(dir).catch(() => []);
  const records: KeyRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".public.json"))) {
    const record = JSON.parse(await readFile(join(dir, file), "utf8")) as KeyRecord;
    records.push(record);
  }
  return records.sort((a, b) => a.key_id.localeCompare(b.key_id));
}

export async function readPrivateKey(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export function signBytes(bytes: Buffer, privatePem: string): string {
  return sign(null, bytes, createPrivateKey(privatePem)).toString("base64");
}

export function verifyBytes(bytes: Buffer, signatureBase64: string, publicPem: string): boolean {
  try {
    return verify(null, bytes, createPublicKey(publicPem), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export function assertKeyMatchesId(publicPem: string, keyId: string): void {
  if (keyIdFromPublicPem(publicPem) !== keyId) fail("manifest.key_mismatch", "Mismatched publisher key ID");
}
