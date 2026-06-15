# Protocol

Release identity is `sha256:<hex>` over the exact canonical unsigned release statement. Signatures are stored in a DSSE-style envelope and are never included in the release ID.

Canonical JSON sorts object keys recursively by code-unit order, omits undefined values, and rejects unsafe number representations in signed data. The test suite proves equivalent object ordering produces identical bytes and release IDs.

Manifests use schema `org.shardseed.release/v1`, Ed25519 publisher signatures, SHA-256 artifact hashes, and torrent transport metadata. Raw manifest JSON and embedded payload JSON are rejected when duplicate object keys are present before normal deserialisation. Unknown manifest fields are rejected.

Artifact paths are rejected if they are absolute, contain `..`, contain empty components, use backslashes, include encoded traversal markers, exceed path limits, are not NFC normalized, collide after case folding, use Windows reserved names, use unsupported extensions, or imply executable/archive content.

Torrent transport is bound into the signed manifest by magnet URI info hash, tracker/web seed lists, and torrent file SHA-256. Public torrents are used by default so DHT/PEX can help nodes discover one another across networks; publishers can opt into private tracker-only torrents when deterministic or closed-network behavior is required. The client validates the exact `.torrent` file against the signed manifest before treating it as an authorized transport. Torrent completion is not sufficient for trust; full-file SHA-256 verification is required before a release enters the verified store.
