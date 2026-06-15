import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import createTorrent from "create-torrent";
import parseTorrent from "parse-torrent";
import WebTorrent from "webtorrent";
import type { Instance as WebTorrentInstance, Torrent as WebTorrentTorrent } from "webtorrent";
import { Server as TrackerServer } from "bittorrent-tracker";

export interface TorrentCreateResult {
  torrentFile: Buffer;
  infoHash: string;
  magnetURI: string;
  name: string;
  files: TorrentFileSummary[];
  length: number;
}

export interface TorrentCreateOptions {
  announce?: string[];
  urlList?: string[];
  private?: boolean;
  pieceLength?: number;
}

export interface TorrentEngineOptions {
  dht?: boolean;
  lsd?: boolean;
  utp?: boolean;
  tracker?: boolean;
  downloadLimitBytesPerSecond?: number;
  uploadLimitBytesPerSecond?: number;
  torrentPort?: number;
}

export interface TorrentDownloadOptions {
  selectedFiles?: string[];
}

export interface TorrentSeedOptions {
  announce?: string[];
}

export interface TorrentFileSummary {
  path: string;
  name: string;
  length: number;
  downloaded?: number;
  progress?: number;
  selected?: boolean;
}

export interface TorrentInfo {
  infoHash: string;
  infoHashV2: string | null;
  magnetURI: string;
  name: string;
  length: number;
  pieceLength: number;
  files: TorrentFileSummary[];
  announce: string[];
  urlList: string[];
}

export interface TorrentProgress {
  progress: number;
  downloaded: number;
  total: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  timeRemaining: number;
  ratio: number;
  files: TorrentFileSummary[];
}

export interface TorrentEngine {
  create(inputPath: string, announceOrOptions?: string[] | TorrentCreateOptions): Promise<TorrentCreateResult>;
  seed(inputPath: string, torrentFile: Buffer, announceOrOptions?: string[] | TorrentSeedOptions): Promise<TorrentSession>;
  download(torrentFile: Buffer | string, downloadDir: string, options?: TorrentDownloadOptions): Promise<TorrentSession>;
  setDownloadLimit(bytesPerSecond: number): void;
  setUploadLimit(bytesPerSecond: number): void;
  address(): { address: string; family: string; port: number } | null;
  destroy(): Promise<void>;
}

export interface TorrentSession {
  infoHash: string;
  magnetURI: string;
  addPeer(peer: string): boolean;
  done(): Promise<void>;
  pause(): void;
  resume(): void;
  progress(): TorrentProgress;
  destroy(): Promise<void>;
}

export class WebTorrentEngine implements TorrentEngine {
  private readonly client: WebTorrentInstance;

  constructor(options: TorrentEngineOptions = {}) {
    this.client = new WebTorrent({
      dht: options.dht ?? true,
      lsd: options.lsd ?? false,
      utp: options.utp ?? false,
      tracker: options.tracker ?? true,
      torrentPort: options.torrentPort ?? 0,
      downloadLimit: options.downloadLimitBytesPerSecond ?? -1,
      uploadLimit: options.uploadLimitBytesPerSecond ?? -1
    });
  }

  async create(inputPath: string, announceOrOptions: string[] | TorrentCreateOptions = {}): Promise<TorrentCreateResult> {
    const options = Array.isArray(announceOrOptions) ? { announce: announceOrOptions } : announceOrOptions;
    const torrentFile = await new Promise<Buffer>((resolve, reject) => {
      createTorrent(inputPath, {
        announce: options.announce ?? [],
        urlList: options.urlList ?? [],
        private: options.private ?? false,
        pieceLength: options.pieceLength ?? 16 * 1024
      }, (err: Error | null, torrent: Buffer | Uint8Array | undefined) => {
        if (err || !torrent) reject(err ?? new Error("Torrent creation failed"));
        else resolve(Buffer.from(torrent));
      });
    });
    const tmp = new WebTorrent({ dht: false, lsd: false, utp: false, tracker: false });
    try {
      const parsed = await new Promise<WebTorrentTorrent>((resolve, reject) => {
        const torrent = tmp.add(torrentFile, { destroyStoreOnDestroy: true });
        torrent.once("ready", () => resolve(torrent));
        torrent.once("error", reject);
      });
      return {
        torrentFile,
        infoHash: parsed.infoHash,
        magnetURI: parsed.magnetURI,
        name: parsed.name,
        length: parsed.length,
        files: summarizeFiles(parsed)
      };
    } finally {
      await destroyClient(tmp);
    }
  }

  async seed(inputPath: string, torrentFile: Buffer, announceOrOptions: string[] | TorrentSeedOptions = {}): Promise<TorrentSession> {
    const options = Array.isArray(announceOrOptions) ? { announce: announceOrOptions } : announceOrOptions;
    const addOptions: Record<string, unknown> = { path: dirname(inputPath) };
    if (options.announce?.length) addOptions.announce = options.announce;
    const torrent = await new Promise<WebTorrentTorrent>((resolve, reject) => {
      const t = this.client.add(torrentFile, addOptions);
      t.once("ready", () => resolve(t));
      t.once("error", reject);
      this.client.once("error", reject);
    });
    return new WebTorrentSession(torrent);
  }

  async download(torrentFile: Buffer | string, downloadDir: string, options: TorrentDownloadOptions = {}): Promise<TorrentSession> {
    await mkdir(downloadDir, { recursive: true });
    const torrent = await new Promise<WebTorrentTorrent>((resolve, reject) => {
      const t = this.client.add(torrentFile, { path: downloadDir, startAsDeselected: !!options.selectedFiles?.length });
      t.once("ready", () => {
        try {
          applyFileSelection(t, options.selectedFiles);
          resolve(t);
        } catch (err) {
          reject(err);
        }
      });
      t.once("error", reject);
      this.client.once("error", reject);
    });
    return new WebTorrentSession(torrent);
  }

  setDownloadLimit(bytesPerSecond: number): void {
    this.client.throttleDownload(bytesPerSecond);
  }

  setUploadLimit(bytesPerSecond: number): void {
    this.client.throttleUpload(bytesPerSecond);
  }

  address(): { address: string; family: string; port: number } | null {
    const address = this.client.address();
    if (!address || typeof address === "string") return null;
    return address;
  }

  async destroy(): Promise<void> {
    await destroyClient(this.client);
  }
}

export class WebTorrentSession implements TorrentSession {
  constructor(private readonly torrent: WebTorrentTorrent) {}

  get infoHash(): string {
    return this.torrent.infoHash;
  }

  get magnetURI(): string {
    return this.torrent.magnetURI;
  }

  addPeer(peer: string): boolean {
    return this.torrent.addPeer(peer);
  }

  async done(): Promise<void> {
    if (this.torrent.done) return;
    await new Promise<void>((resolve, reject) => {
      this.torrent.once("done", () => resolve());
      this.torrent.once("error", reject);
    });
  }

  pause(): void {
    this.torrent.pause();
  }

  resume(): void {
    this.torrent.resume();
  }

  progress(): TorrentProgress {
    return {
      progress: this.torrent.progress,
      downloaded: this.torrent.downloaded,
      total: this.torrent.length,
      uploaded: this.torrent.uploaded,
      downloadSpeed: this.torrent.downloadSpeed,
      uploadSpeed: this.torrent.uploadSpeed,
      peers: this.torrent.numPeers,
      timeRemaining: this.torrent.timeRemaining,
      ratio: this.torrent.ratio,
      files: summarizeFiles(this.torrent)
    };
  }

  async destroy(): Promise<void> {
    await new Promise<void>((resolve) => this.torrent.destroy({ destroyStore: false }, () => resolve()));
  }
}

export async function parseTorrentInfo(torrentFile: Buffer | Uint8Array | string): Promise<TorrentInfo> {
  const parsed = await parseTorrent(torrentFile) as Awaited<ReturnType<typeof parseTorrent>> & { urlList?: string[] };
  return {
    infoHash: parsed.infoHash,
    infoHashV2: parsed.infoHashV2 ?? null,
    magnetURI: parsed.magnetURI,
    name: parsed.name ?? "",
    length: parsed.length ?? 0,
    pieceLength: parsed.pieceLength ?? 0,
    files: (parsed.files ?? []).map((file: { path: string; name?: string; length: number }) => ({
      path: file.path,
      name: file.name ?? file.path.split("/").at(-1) ?? file.path,
      length: file.length
    })),
    announce: (parsed.announce ?? []) as string[],
    urlList: (parsed.urlList ?? []) as string[]
  };
}

function applyFileSelection(torrent: WebTorrentTorrent, selectedFiles?: string[]): void {
  if (!selectedFiles?.length) return;
  const wanted = new Set(selectedFiles);
  let matched = 0;
  for (const file of torrent.files) {
    if (wanted.has(file.path)) {
      file.select();
      matched++;
    } else {
      file.deselect();
    }
  }
  if (matched !== wanted.size) {
    const available = torrent.files.map((file) => file.path).join(", ");
    throw new Error(`Selective download requested missing file(s). Available files: ${available}`);
  }
}

function summarizeFiles(torrent: WebTorrentTorrent): TorrentFileSummary[] {
  return torrent.files.map((file) => ({
    path: file.path,
    name: file.name,
    length: file.length,
    downloaded: file.downloaded,
    progress: file.progress,
    selected: file.progress > 0 || file.done
  }));
}

export interface LocalTracker {
  announce: string;
  bindHost: string;
  port: number;
  close(): Promise<void>;
}

export interface LocalTrackerOptions {
  host?: string;
  port?: number;
  announceHost?: string;
  announcePort?: number;
}

export async function startLocalTracker(options: LocalTrackerOptions = {}): Promise<LocalTracker> {
  const server = new TrackerServer({ udp: false, ws: false, http: true });
  const bindHost = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, bindHost, resolve));
  const address = server.http?.address();
  if (!address || typeof address === "string") throw new Error("Local tracker did not expose an HTTP address");
  const announceHost = options.announceHost ?? (bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost);
  const announcePort = options.announcePort ?? address.port;
  return {
    announce: `http://${announceHost}:${announcePort}/announce`,
    bindHost,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function destroyClient(client: WebTorrentInstance): Promise<void> {
  await new Promise<void>((resolve) => client.destroy(() => resolve()));
}
