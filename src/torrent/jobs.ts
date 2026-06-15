import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fail } from "../errors.js";
import { atomicWrite, sha256File } from "../fsutil.js";
import { parseJsonStrict } from "../manifest/json.js";
import { parseTorrentInfo, TorrentProgress, WebTorrentEngine } from "./engine.js";

export type TorrentJobKind = "download" | "seed";
export type TorrentJobStatus = "Queued" | "Running" | "Paused" | "Completed" | "Seeding" | "Failed";

export interface TorrentJob {
  id: string;
  kind: TorrentJobKind;
  status: TorrentJobStatus;
  torrent_path: string;
  torrent_sha256: string;
  info_hash: string;
  magnet_uri: string;
  content_dir: string;
  selected_files: string[];
  dht: boolean;
  download_limit_bps: number | null;
  upload_limit_bps: number | null;
  progress: TorrentProgress | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TorrentJobStore {
  schema: "org.shardseed.torrent.jobs/v1";
  jobs: TorrentJob[];
}

export interface TorrentRunOptions {
  jobsPath: string;
  torrentPath: string;
  contentDir: string;
  selectedFiles?: string[];
  dht?: boolean;
  downloadLimitBps?: number | null;
  uploadLimitBps?: number | null;
  torrentPort?: number | null;
  wait?: boolean;
  jobId?: string;
}

export async function readTorrentJobStore(path: string): Promise<TorrentJobStore> {
  const text = await readFile(path, "utf8").catch(() => "");
  if (!text) return { schema: "org.shardseed.torrent.jobs/v1", jobs: [] };
  const parsed = parseJsonStrict(text, "torrent.jobs") as TorrentJobStore;
  if (parsed.schema !== "org.shardseed.torrent.jobs/v1" || !Array.isArray(parsed.jobs)) fail("torrent.jobs", "Unsupported torrent job store");
  return parsed;
}

export async function writeTorrentJobStore(path: string, store: TorrentJobStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify(store, null, 2));
}

export async function upsertTorrentJob(path: string, job: TorrentJob): Promise<void> {
  const store = await readTorrentJobStore(path);
  const idx = store.jobs.findIndex((existing) => existing.id === job.id);
  if (idx === -1) store.jobs.push(job);
  else store.jobs[idx] = job;
  await writeTorrentJobStore(path, store);
}

export async function createTorrentJob(kind: TorrentJobKind, opts: TorrentRunOptions): Promise<TorrentJob> {
  const torrentPath = resolve(opts.torrentPath);
  const contentDir = resolve(opts.contentDir);
  const torrentBytes = await readFile(torrentPath);
  const info = await parseTorrentInfo(torrentBytes);
  const now = new Date().toISOString();
  return {
    id: opts.jobId ?? `${kind}-${info.infoHash}-${Date.now()}`,
    kind,
    status: "Queued",
    torrent_path: torrentPath,
    torrent_sha256: await sha256File(torrentPath),
    info_hash: info.infoHash,
    magnet_uri: info.magnetURI,
    content_dir: contentDir,
    selected_files: opts.selectedFiles ?? [],
    dht: opts.dht ?? true,
    download_limit_bps: opts.downloadLimitBps ?? null,
    upload_limit_bps: opts.uploadLimitBps ?? null,
    progress: null,
    error: null,
    created_at: now,
    updated_at: now
  };
}

export async function runDownloadJob(opts: TorrentRunOptions): Promise<TorrentJob> {
  let job = await createTorrentJob("download", opts);
  await upsertTorrentJob(opts.jobsPath, job);
  const engine = new WebTorrentEngine({
    dht: job.dht,
    torrentPort: opts.torrentPort ?? undefined,
    downloadLimitBytesPerSecond: job.download_limit_bps ?? undefined,
    uploadLimitBytesPerSecond: job.upload_limit_bps ?? undefined
  });
  try {
    job = await mark(opts.jobsPath, job, "Running");
    const session = await engine.download(await readFile(job.torrent_path), job.content_dir, { selectedFiles: job.selected_files });
    job = await saveProgress(opts.jobsPath, job, session.progress());
    if (opts.wait ?? true) {
      await session.done();
      job = await saveProgress(opts.jobsPath, job, session.progress());
      job = await mark(opts.jobsPath, job, "Completed");
    }
    return job;
  } catch (err) {
    job = { ...job, status: "Failed", error: err instanceof Error ? err.message : String(err), updated_at: new Date().toISOString() };
    await upsertTorrentJob(opts.jobsPath, job);
    throw err;
  } finally {
    await engine.destroy();
  }
}

export async function runSeedJob(opts: TorrentRunOptions): Promise<TorrentJob> {
  let job = await createTorrentJob("seed", opts);
  await upsertTorrentJob(opts.jobsPath, job);
  const engine = new WebTorrentEngine({
    dht: job.dht,
    torrentPort: opts.torrentPort ?? undefined,
    uploadLimitBytesPerSecond: job.upload_limit_bps ?? undefined
  });
  try {
    job = await mark(opts.jobsPath, job, "Running");
    const session = await engine.seed(job.content_dir, await readFile(job.torrent_path));
    job = await saveProgress(opts.jobsPath, job, session.progress());
    job = await mark(opts.jobsPath, job, "Seeding");
    if (opts.wait) {
      await waitForever();
    }
    return job;
  } catch (err) {
    job = { ...job, status: "Failed", error: err instanceof Error ? err.message : String(err), updated_at: new Date().toISOString() };
    await upsertTorrentJob(opts.jobsPath, job);
    throw err;
  } finally {
    if (!opts.wait) await engine.destroy();
  }
}

export function defaultTorrentJobsPath(root: string): string {
  return join(root, ".shardseed-data", "torrent-jobs.json");
}

async function mark(path: string, job: TorrentJob, status: TorrentJobStatus): Promise<TorrentJob> {
  const next = { ...job, status, error: null, updated_at: new Date().toISOString() };
  await upsertTorrentJob(path, next);
  return next;
}

async function saveProgress(path: string, job: TorrentJob, progress: TorrentProgress): Promise<TorrentJob> {
  const next = { ...job, progress, updated_at: new Date().toISOString() };
  await upsertTorrentJob(path, next);
  return next;
}

async function waitForever(): Promise<never> {
  await new Promise(() => undefined);
  throw new Error("unreachable");
}
