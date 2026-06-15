import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fail } from "../errors.js";
import { atomicWrite, sha256RegularFile } from "../fsutil.js";
import { parseJsonStrict } from "../manifest/json.js";
import { validateArtifactPath } from "../manifest/validate.js";
import { TorrentMetadata, validateTorrentMetadata } from "./torrent.js";

export interface TransferState {
  torrent: TorrentMetadata;
  sourceDir: string;
  destDir: string;
  completedFiles: string[];
  statePath: string;
}

export async function startLocalTransfer(state: TransferState, maxFiles?: number): Promise<TransferState> {
  validateTransferState(state);
  await mkdir(state.destDir, { recursive: true });
  const done = new Set(state.completedFiles);
  let copied = 0;
  for (const file of state.torrent.files) {
    if (done.has(file.path)) continue;
    const src = join(state.sourceDir, file.path);
    const dst = join(state.destDir, file.path);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    const digest = await sha256RegularFile(dst);
    if (digest.size !== file.size || digest.sha256 !== file.sha256) fail("transfer.hash_mismatch", `Transferred file does not match torrent metadata: ${file.path}`);
    done.add(file.path);
    copied++;
    await persistTransferState({ ...state, completedFiles: [...done] });
    if (maxFiles && copied >= maxFiles) break;
  }
  return { ...state, completedFiles: [...done] };
}

export async function persistTransferState(state: TransferState): Promise<void> {
  validateTransferState(state);
  await mkdir(dirname(state.statePath), { recursive: true });
  await atomicWrite(state.statePath, JSON.stringify(state, null, 2));
}

export async function readTransferState(path: string): Promise<TransferState> {
  const state = parseJsonStrict(await readFile(path, "utf8"), "transfer_state") as TransferState;
  validateTransferState(state);
  return state;
}

export async function hasCompleted(state: TransferState): Promise<boolean> {
  validateTransferState(state);
  for (const file of state.torrent.files) {
    const s = await stat(join(state.destDir, file.path)).catch(() => null);
    if (!s || s.size !== file.size) return false;
    const digest = await sha256RegularFile(join(state.destDir, file.path));
    if (digest.sha256 !== file.sha256) return false;
  }
  return true;
}

function validateTransferState(state: TransferState): void {
  validateTorrentMetadata(state.torrent);
  for (const completed of state.completedFiles) validateArtifactPath(completed);
}
