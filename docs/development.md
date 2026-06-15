# Development

Repository layout:

- `apps/desktop`: React frontend and Tauri 2 shell scaffold.
- `src/torrent`: active torrent engine abstraction and WebTorrent sidecar implementation.
- `src/manifest`, `src/crypto`, `src/publish`, `src/storage`: shared protocol implementation used by CLI and desktop.
- `crates/*`: requested Rust crate boundaries, pending Rust toolchain availability.
- `services/torrentd`: sidecar export point.
- `fixtures/test-files`: tiny local GGUF-style fixture.

Useful commands:

```bash
npm test
npm run test:e2e
npm test -- tests/torrent-first.test.ts
npm test -- tests/torrent-resume.test.ts
npm test -- tests/mesh.test.ts
npm run build
npm run shardseed -- torrent smoke-test fixtures/test-files/tiny-model --dest /tmp/shardseed-cli-download
npm run shardseed -- mesh test fixtures/test-files/tiny-model --nodes 3 --work-dir /tmp/shardseed-mesh-3
npm run shardseed -- mesh test fixtures/test-files/tiny-model --nodes 5 --work-dir /tmp/shardseed-mesh-5
```

Rust/Tauri checks require installing `cargo` and platform Tauri dependencies first.
