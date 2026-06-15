# Security

Downloaded content is untrusted. Shardseed never executes downloaded files, imports code, changes executable permissions, launches model runtimes, or automatically opens model files in another application.

Verification requires duplicate-key-free JSON, valid schema, stable release ID, valid Ed25519 signature, valid torrent metadata, exact file sizes, exact SHA-256 hashes, regular files only, and no undeclared files. Failures are quarantined and not seeded from the verified store. A completed torrent or resume state is never sufficient to establish trust.

## Threat model

Shardseed treats catalogues, manifests, torrent metadata, peers, downloaded files, resume state, and frontend state as attacker-controlled. The trusted boundary is the shared verification code that validates the signed manifest, binds it to torrent metadata, re-hashes every artifact from disk, rejects symlinks and special files, and only then materializes content into the verified store.

Catalogue entries can help users discover releases, but they cannot override signed manifest fields or establish publisher identity. Manifest URLs from catalogues are restricted to HTTP(S) and local/private hosts are rejected by default to reduce SSRF risk.

Frontend code is not trusted to mark a release verified. The desktop shell currently exposes only a status command; future IPC commands must enforce the same checks in backend code and must not grant broad filesystem or shell permissions.

BitTorrent exposes participation metadata, including IP address, to peers and trackers. The prototype uses a local tracker for deterministic tests and makes no anonymity claims.

Private keys are generated under the user key directory with restrictive file permissions and are not stored in release directories.

## Current release blockers

This prototype is not suitable for public release. Remaining blockers include the vulnerable WebTorrent tracker dependency chain reported by `npm audit`, incomplete Rust-core implementations, no fuzz targets, no SQLite-backed transactional state machine, no authenticated sidecar API design, and incomplete protection against all filesystem race classes.

Cryptographic integrity does not imply model safety. UI copy and downstream integrations must distinguish intact bytes, valid signatures, externally verified identity, declared lineage, structural file validity, malware scan status, and unknown model behavior.
