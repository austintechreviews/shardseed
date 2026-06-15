//! Core domain types for the Rust implementation.
//!
//! The runnable prototype currently uses the TypeScript sidecar while this crate
//! boundary is kept for the requested Tauri/Rust backend migration.

pub const DOWNLOAD_STATES: &[&str] = &[
    "Discovered",
    "ManifestFetching",
    "ManifestValidating",
    "SignatureUnverified",
    "ReadyToDownload",
    "Downloading",
    "Paused",
    "VerifyingTorrent",
    "VerifyingFiles",
    "Verified",
    "Seeding",
    "Failed",
    "Quarantined",
];
