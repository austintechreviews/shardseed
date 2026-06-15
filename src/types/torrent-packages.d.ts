declare module "create-torrent" {
  export default function createTorrent(
    input: string | string[],
    options: Record<string, unknown>,
    cb: (err: Error | null, torrent?: Buffer | Uint8Array) => void
  ): void;
}

declare module "webtorrent" {
  interface TorrentDestroyOptions {
    destroyStore?: boolean;
  }

  export interface Torrent {
    infoHash: string;
    magnetURI: string;
    name: string;
    length: number;
    timeRemaining: number;
    done: boolean;
    progress: number;
    downloaded: number;
    uploaded: number;
    downloadSpeed: number;
    uploadSpeed: number;
    numPeers: number;
    ratio: number;
    files: Array<{
      name: string;
      path: string;
      length: number;
      downloaded: number;
      progress: number;
      done: boolean;
      select(priority?: number): void;
      deselect(): void;
    }>;
    addPeer(peer: string): boolean;
    pause(): void;
    resume(): void;
    destroy(opts: TorrentDestroyOptions, cb: () => void): void;
    once(event: "metadata" | "ready" | "done" | "error", cb: (...args: unknown[]) => void): void;
  }

  export interface Instance {
    add(torrent: Buffer | string, options?: Record<string, unknown>): Torrent;
    seed(input: string | string[], options: Record<string, unknown>, cb: (torrent: Torrent) => void): void;
    once(event: "error", cb: (err: Error) => void): void;
    throttleDownload(rate: number): boolean | void;
    throttleUpload(rate: number): boolean | void;
    address(): { address: string; family: string; port: number } | string | null;
    destroy(cb: () => void): void;
  }

  export default class WebTorrent {
    constructor(options?: Record<string, unknown>);
    add(torrent: Buffer | string, options?: Record<string, unknown>): Torrent;
    seed(input: string | string[], options: Record<string, unknown>, cb: (torrent: Torrent) => void): void;
    once(event: "error", cb: (err: Error) => void): void;
    throttleDownload(rate: number): boolean | void;
    throttleUpload(rate: number): boolean | void;
    address(): { address: string; family: string; port: number } | string | null;
    destroy(cb: () => void): void;
  }
}

declare module "parse-torrent" {
  export default function parseTorrent(input: Buffer | Uint8Array | string): Promise<{
    infoHash: string;
    infoHashV2?: string;
    magnetURI: string;
    name?: string;
    length?: number;
    pieceLength?: number;
    files?: Array<{ path: string; name?: string; length: number }>;
    announce?: string[];
  }>;
}

declare module "bittorrent-tracker" {
  import type { AddressInfo } from "node:net";

  export class Server {
    http?: { address(): AddressInfo | string | null };
    constructor(options?: Record<string, unknown>);
    listen(port: number, host: string, cb: () => void): void;
    close(cb: () => void): void;
  }
}
