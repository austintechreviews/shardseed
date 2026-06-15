# Shardseed

Shardseed is a prototype desktop and CLI application for decentralised AI model distribution. The current working slice is torrent-first: it can create a torrent, seed it through a local tracker, download it with a second client, and verify transferred bytes. The protocol layer also implements canonical release manifests, stable release IDs, Ed25519 signing, strict path/security validation, SHA-256 artifact verification, quarantine, and content-addressed storage materialisation.

## Current Limitations

- The active torrent engine is a Node sidecar using WebTorrent behind `src/torrent/engine.ts`.
- SQLite is represented by a JSON state file in this slice; replacing it with SQLite is the next storage task.
- The React desktop shell builds, but the CLI/test path is the authoritative working flow right now.
- `npm audit --omit=dev` reports a high-severity transitive `ip` advisory through WebTorrent/bittorrent-tracker. Shardseed does not use that package for catalogue trust decisions, but replacing or sandboxing the torrent sidecar remains required before production distribution.

## Native Desktop Apps

```bash
npm install
npm test
npm run build
npm run desktop:dev
npm run desktop:build
```

Shardseed Desktop is packaged with Tauri for native macOS, Linux, and Windows apps. `npm run desktop:dev` opens the native app for development. `npm run desktop:build` produces a native bundle under `target/release/bundle/`; in production the UI is bundled as static assets inside the app, not served as a webserver.

See `docs/native-apps.md` for local build notes and the GitHub Actions workflow that builds all three desktop platforms.

## Torrent-First Demo

```bash
npm run shardseed -- torrent smoke-test fixtures/test-files/tiny-model --dest /tmp/shardseed-cli-download
```

That command starts a local HTTP tracker, creates a torrent for the fixture directory, starts one publisher client, starts a clean downloader client, waits for completion, and prints progress plus matching info hashes.

## Torrent Commands

```bash
npm run shardseed -- torrent create fixtures/test-files/tiny-model --out /tmp/tiny-model.torrent
npm run shardseed -- torrent info /tmp/tiny-model.torrent
npm run shardseed -- torrent verify /tmp/tiny-model.torrent --manifest /tmp/tiny-model.dsse.json
npm run shardseed -- torrent download /tmp/tiny-model.torrent --dest /tmp/shardseed-downloads --jobs /tmp/shardseed-jobs.json
npm run shardseed -- torrent jobs --jobs /tmp/shardseed-jobs.json
npm run shardseed -- torrent resume <job-id> --jobs /tmp/shardseed-jobs.json
npm run shardseed -- torrent seed /tmp/tiny-model.torrent --source fixtures/test-files/tiny-model --wait
```

The torrent subsystem supports real `.torrent` files, local trackers, tracker/DHT toggles, persisted job state, restart/resume into the same destination directory, per-file progress, download/upload speed snapshots, upload and download limits, and selective file downloads with repeated `--select <torrent-path>`.

## Local Mesh Tests

Run a deterministic two-node mesh:

```bash
npm run shardseed -- mesh test fixtures/test-files/tiny-model --nodes 2 --work-dir /tmp/shardseed-mesh-2
```

Run a deterministic three-node handoff mesh:

```bash
npm run shardseed -- mesh test fixtures/test-files/tiny-model --nodes 3 --work-dir /tmp/shardseed-mesh-3
```

Run a larger cascade:

```bash
npm run shardseed -- mesh test fixtures/test-files/tiny-model --nodes 5 --work-dir /tmp/shardseed-mesh-5
```

For `--nodes 3` and above, node 1 publishes and seeds, node 2 downloads/verifies and starts seeding, node 1 is stopped, and later nodes download from the mesh of verified seeders.

The mesh harness also injects direct peer addresses between local node processes. This makes Docker/single-host runs deterministic even when tracker peer discovery is slow or blocked. Failed node downloads include timeout diagnostics with peer count, bytes downloaded, direct peers, and per-file progress.

## Docker Or Remote Nodes

For containers or machines on different networks, do not use localhost announce URLs. Start a reachable tracker:

```bash
npm run shardseed -- torrent tracker --host 0.0.0.0 --port 8000 --announce-host tracker --announce-port 8000
```

In Docker Compose, `tracker` should be the service name on the shared network. Across the internet, `--announce-host` must be a DNS name or public IP reachable by peers.

Publish with the reachable tracker:

```bash
npm run shardseed -- publish /path/to/model \
  --key /keys/publisher.private.pem \
  --public-key /keys/publisher.public.pem \
  --key-id ed25519:<fingerprint> \
  --out /out/release \
  --tracker http://tracker:8000/announce
```

Seed and download with DHT enabled by default:

```bash
npm run shardseed -- torrent seed /out/release/model.torrent --source /path/to/model --port 6881 --wait
npm run shardseed -- torrent download /out/release/model.torrent --dest /downloads --port 6882
```

Use `--no-dht` when you want tracker-only deterministic tests. For nodes in different countries, keep DHT enabled and use at least one reachable tracker; NAT/firewall port forwarding or UPnP may still be needed for strong connectivity.

For a single-container Docker retest of the mesh harness:

```bash
npm run shardseed -- mesh test fixtures/test-files/tiny-model \
  --nodes 2 \
  --work-dir /tmp/shardseed-docker-mesh-2 \
  --no-dht \
  --download-timeout-ms 30000
```

The JSON report should include `direct_peers` such as `127.0.0.1:<port>` for node 1 and node 2.

## Protocol Commands

```bash
npm run shardseed -- key generate --dir /tmp/shardseed-keys --name demo
npm run shardseed -- key list --dir /tmp/shardseed-keys
npm run shardseed -- inspect fixtures/test-files/tiny-model/tiny-model-Q4_K_M.gguf
```

## Publishing A Local LM Studio Model

Shardseed can publish model directories from `/Users/austinwells/.lmstudio/models` without running or installing them:

```bash
npm run shardseed -- models list --root /Users/austinwells/.lmstudio/models
npm run shardseed -- key generate --dir /tmp/shardseed-keys --name lmstudio-publisher
npm run shardseed -- publish /Users/austinwells/.lmstudio/models/mlx-community/Qwen3.5-0.8B-OptiQ-4bit \
  --key /tmp/shardseed-keys/<publisher>.private.pem \
  --public-key /tmp/shardseed-keys/<publisher>.public.pem \
  --key-id ed25519:<fingerprint> \
  --out /tmp/shardseed-real-model-publish \
  --name Qwen3.5-0.8B-OptiQ-4bit \
  --release-version 1.0.0 \
  --namespace mlx-community \
  --slug qwen3-5-0-8b-optiq-4bit \
  --architecture qwen \
  --publisher "Local LM Studio Publisher"
```

This writes a real `.torrent`, signed `.dsse.json` manifest, publication summary, and magnet link. It never mutates the source model directory.

## Security Notes

Shardseed does not launch models, execute downloaded scripts, import Python, extract archives, or integrate with LM Studio/Ollama. Releases must be data-only. BitTorrent participation can expose your IP address to peers; no anonymity is implied.
