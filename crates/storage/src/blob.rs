//! Blob storage behind a trait: content-addressed by SHA-256, written put-if-absent, read through
//! short-lived URLs, listed and deleted by the orphan cleanup. Three implementations share one
//! contract suite (`tests/blob_contract.rs`): an in-memory fake for fast tests, a directory for
//! local runs, and an S3-compatible client (`s3.rs`) for deployment.
//!
//! The contract has one rule that is easy to miss. `put_if_absent` stores identical bytes once, but
//! it also guarantees the blob is *recent* when it returns: if the blob already exists and its
//! last-modified time is older than the store's refresh threshold, the time is refreshed. Without
//! that, an old unreferenced blob (left by a failed publish) that a new publish needs again would
//! keep its old time, and the orphan cleanup could delete it just before that publish commits.

use graft_domain::hash::Sha256Hash;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A boxed future, so the trait works as a trait object without an extra crate.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How old a blob may be before `put_if_absent` refreshes its time. The orphan grace period must be
/// comfortably longer than this (the service requires at least twice).
pub const DEFAULT_REFRESH_AFTER: Duration = Duration::from_secs(10 * 60);

/// Why a blob operation failed. Never carries credentials, endpoints or paths.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BlobError {
    /// The store could not be reached or refused the request. The text names the class of
    /// failure, nothing that could identify an account.
    #[error("the blob store failed: {0}")]
    Store(String),
    /// The bytes offered do not hash to the hash they were offered under. Nothing was stored.
    #[error("the bytes do not hash to the hash they were offered under")]
    HashMismatch,
    /// Stored bytes do not hash to their name. They are never returned.
    #[error("a stored blob does not match its hash")]
    Damaged,
}

/// What a listing says about one stored blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobInfo {
    /// The blob's content hash, which is also its name.
    pub hash: Sha256Hash,
    /// Size in bytes.
    pub size: u64,
    /// When it was last written or refreshed, milliseconds since the Unix epoch.
    pub last_modified_ms: i64,
}

/// Content-addressed blob storage.
pub trait BlobStore: Send + Sync {
    /// Store `bytes` under their SHA-256 unless already present; returns the hash either way. On
    /// return the blob exists and its last-modified time is no older than the store's refresh
    /// threshold. Safe to call concurrently with the same bytes.
    fn put_if_absent(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<Sha256Hash, BlobError>>;

    /// As `put_if_absent`, but refuses bytes that do not hash to `hash`.
    fn put_verified(
        &self,
        hash: Sha256Hash,
        bytes: Vec<u8>,
    ) -> BoxFuture<'_, Result<Sha256Hash, BlobError>> {
        Box::pin(async move {
            if Sha256Hash::of(&bytes) != hash {
                return Err(BlobError::HashMismatch);
            }
            self.put_if_absent(bytes).await
        })
    }

    /// The bytes stored under `hash`, or `None`. A store that finds bytes that do not hash to
    /// `hash` reports [`BlobError::Damaged`] and never returns them.
    fn get(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<Vec<u8>>, BlobError>>;

    /// A URL from which `hash` can be fetched for `ttl`. Issued only after the caller has checked
    /// that the publication asking for it is available; a blob hash alone never grants access.
    fn signed_url(
        &self,
        hash: Sha256Hash,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<String, BlobError>>;

    /// One blob's size and last-modified time, or `None`. For the orphan cleanup's last check
    /// before it deletes.
    fn info(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<BlobInfo>, BlobError>>;

    /// Every stored blob, with its size and last-modified time. For the orphan cleanup.
    fn list(&self) -> BoxFuture<'_, Result<Vec<BlobInfo>, BlobError>>;

    /// Delete a blob; true if it existed. Deleting what is not there is not an error.
    fn delete(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<bool, BlobError>>;
}

/// Milliseconds since the Unix epoch, from the system clock.
#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A source of the current time, so tests can move it.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Entry {
    bytes: Vec<u8>,
    modified_ms: i64,
}

/// An in-memory store for tests and local runs.
pub struct MemoryBlobStore {
    blobs: Mutex<HashMap<Sha256Hash, Entry>>,
    clock: Clock,
    refresh_after: Duration,
}

impl Default for MemoryBlobStore {
    fn default() -> Self {
        Self::with_clock(Arc::new(now_ms), DEFAULT_REFRESH_AFTER)
    }
}

impl MemoryBlobStore {
    /// A store that reads time from `clock` and refreshes blobs older than `refresh_after`.
    #[must_use]
    pub fn with_clock(clock: Clock, refresh_after: Duration) -> Self {
        Self {
            blobs: Mutex::new(HashMap::new()),
            clock,
            refresh_after,
        }
    }

    /// The stored bytes for `hash`, if any.
    #[must_use]
    pub fn get(&self, hash: &Sha256Hash) -> Option<Vec<u8>> {
        self.blobs.lock().ok()?.get(hash).map(|e| e.bytes.clone())
    }

    /// How many distinct blobs are stored.
    #[must_use]
    pub fn len(&self) -> usize {
        self.blobs.lock().map_or(0, |b| b.len())
    }

    /// True when nothing is stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl BlobStore for MemoryBlobStore {
    fn put_if_absent(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<Sha256Hash, BlobError>> {
        Box::pin(async move {
            let hash = Sha256Hash::of(&bytes);
            let now = (self.clock)();
            let refresh_ms = i64::try_from(self.refresh_after.as_millis()).unwrap_or(i64::MAX);
            let mut blobs = self
                .blobs
                .lock()
                .map_err(|_| BlobError::Store("the in-memory store is poisoned".into()))?;
            match blobs.get_mut(&hash) {
                Some(entry) if now.saturating_sub(entry.modified_ms) >= refresh_ms => {
                    entry.modified_ms = now;
                }
                Some(_) => {}
                None => {
                    blobs.insert(
                        hash,
                        Entry {
                            bytes,
                            modified_ms: now,
                        },
                    );
                }
            }
            Ok(hash)
        })
    }

    fn get(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<Vec<u8>>, BlobError>> {
        Box::pin(async move { Ok(MemoryBlobStore::get(self, &hash)) })
    }

    fn signed_url(
        &self,
        hash: Sha256Hash,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<String, BlobError>> {
        Box::pin(async move {
            Ok(format!(
                "memory://blob/{}?ttl={}",
                hash.to_hex(),
                ttl.as_secs()
            ))
        })
    }

    fn info(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<BlobInfo>, BlobError>> {
        Box::pin(async move {
            let blobs = self
                .blobs
                .lock()
                .map_err(|_| BlobError::Store("the in-memory store is poisoned".into()))?;
            Ok(blobs.get(&hash).map(|e| BlobInfo {
                hash,
                size: e.bytes.len() as u64,
                last_modified_ms: e.modified_ms,
            }))
        })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<BlobInfo>, BlobError>> {
        Box::pin(async move {
            let blobs = self
                .blobs
                .lock()
                .map_err(|_| BlobError::Store("the in-memory store is poisoned".into()))?;
            Ok(blobs
                .iter()
                .map(|(hash, e)| BlobInfo {
                    hash: *hash,
                    size: e.bytes.len() as u64,
                    last_modified_ms: e.modified_ms,
                })
                .collect())
        })
    }

    fn delete(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<bool, BlobError>> {
        Box::pin(async move {
            let mut blobs = self
                .blobs
                .lock()
                .map_err(|_| BlobError::Store("the in-memory store is poisoned".into()))?;
            Ok(blobs.remove(&hash).is_some())
        })
    }
}

/// A directory-backed store for local runs, so a seed script and the service can share audio
/// without an object store. URLs are `file://` paths: local development only.
pub struct FsBlobStore {
    dir: std::path::PathBuf,
    refresh_after: Duration,
}

impl FsBlobStore {
    /// Use `dir`, creating it if needed.
    pub fn open(dir: impl Into<std::path::PathBuf>) -> Result<Self, BlobError> {
        Self::open_with(dir, DEFAULT_REFRESH_AFTER)
    }

    /// As `open`, refreshing blobs older than `refresh_after`.
    pub fn open_with(
        dir: impl Into<std::path::PathBuf>,
        refresh_after: Duration,
    ) -> Result<Self, BlobError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(|e| BlobError::Store(e.kind().to_string()))?;
        Ok(Self { dir, refresh_after })
    }

    fn path(&self, hash: &Sha256Hash) -> std::path::PathBuf {
        self.dir.join(hash.to_hex())
    }
}

fn io(e: &std::io::Error) -> BlobError {
    BlobError::Store(e.kind().to_string())
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl BlobStore for FsBlobStore {
    fn put_if_absent(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<Sha256Hash, BlobError>> {
        Box::pin(async move {
            let hash = Sha256Hash::of(&bytes);
            let target = self.path(&hash);
            match tokio::fs::metadata(&target).await {
                Ok(meta) => {
                    // Already there: refresh its time if it is old, so the orphan cleanup cannot
                    // mistake it for a leftover. If it vanishes in between (the cleanup deleted
                    // it), fall through and write it again.
                    let age = now_ms().saturating_sub(modified_ms(&meta));
                    let refresh = i64::try_from(self.refresh_after.as_millis()).unwrap_or(i64::MAX);
                    if age < refresh {
                        return Ok(hash);
                    }
                    match std::fs::OpenOptions::new().write(true).open(&target) {
                        Ok(file) => {
                            file.set_modified(SystemTime::now()).map_err(|e| io(&e))?;
                            return Ok(hash);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(io(&e)),
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io(&e)),
            }
            // Write to a name no other writer shares, then rename: a reader never sees a
            // half-written blob, and concurrent writers of the same bytes (in this process or
            // another) each own their temporary file. Renaming over an identical file is harmless.
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let temp = self.dir.join(format!(
                ".{}.{}.{unique}",
                hash.to_hex(),
                std::process::id()
            ));
            tokio::fs::write(&temp, &bytes).await.map_err(|e| io(&e))?;
            tokio::fs::rename(&temp, &target)
                .await
                .map_err(|e| io(&e))?;
            Ok(hash)
        })
    }

    fn get(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<Vec<u8>>, BlobError>> {
        Box::pin(async move {
            let bytes = match tokio::fs::read(self.path(&hash)).await {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(io(&e)),
            };
            // Content addressing is only worth something if it is checked on the way out.
            if Sha256Hash::of(&bytes) != hash {
                return Err(BlobError::Damaged);
            }
            Ok(Some(bytes))
        })
    }

    fn signed_url(
        &self,
        hash: Sha256Hash,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<String, BlobError>> {
        Box::pin(async move {
            Ok(format!(
                "file://{}?ttl={}",
                self.path(&hash).display(),
                ttl.as_secs()
            ))
        })
    }

    fn info(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<Option<BlobInfo>, BlobError>> {
        Box::pin(async move {
            match tokio::fs::metadata(self.path(&hash)).await {
                Ok(meta) => Ok(Some(BlobInfo {
                    hash,
                    size: meta.len(),
                    last_modified_ms: modified_ms(&meta),
                })),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(io(&e)),
            }
        })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<BlobInfo>, BlobError>> {
        Box::pin(async move {
            let mut out = Vec::new();
            let mut dir = tokio::fs::read_dir(&self.dir).await.map_err(|e| io(&e))?;
            while let Some(entry) = dir.next_entry().await.map_err(|e| io(&e))? {
                // Temporary files start with a dot and are not blobs.
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(hash) = Sha256Hash::parse(&name) else {
                    continue;
                };
                let meta = entry.metadata().await.map_err(|e| io(&e))?;
                out.push(BlobInfo {
                    hash,
                    size: meta.len(),
                    last_modified_ms: modified_ms(&meta),
                });
            }
            Ok(out)
        })
    }

    fn delete(&self, hash: Sha256Hash) -> BoxFuture<'_, Result<bool, BlobError>> {
        Box::pin(async move {
            match tokio::fs::remove_file(self.path(&hash)).await {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(io(&e)),
            }
        })
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // test helpers fail loudly
mod tests {
    use super::*;

    #[tokio::test]
    async fn identical_bytes_are_stored_once_and_return_the_same_hash() {
        let store = MemoryBlobStore::default();
        let a = store.put_if_absent(vec![1, 2, 3]).await.expect("put");
        let b = store.put_if_absent(vec![1, 2, 3]).await.expect("put again");
        assert_eq!(a, b);
        assert_eq!(a, Sha256Hash::of(&[1, 2, 3]));
        assert_eq!(store.len(), 1);
        assert_eq!(store.get(&a), Some(vec![1, 2, 3]));
    }

    #[tokio::test]
    async fn bytes_written_twice_land_once_and_read_back_from_disk() {
        let dir = std::env::temp_dir().join(format!("graft-fs-blob-{}", std::process::id()));
        let store = FsBlobStore::open(&dir).expect("open");
        let a = store.put_if_absent(vec![9, 9, 9]).await.expect("put");
        let b = store.put_if_absent(vec![9, 9, 9]).await.expect("put again");
        assert_eq!(a, b);
        assert_eq!(
            std::fs::read(dir.join(a.to_hex())).expect("file"),
            vec![9, 9, 9]
        );
        assert_eq!(
            std::fs::read_dir(&dir).expect("dir").count(),
            1,
            "no temp files left behind"
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[tokio::test]
    async fn many_concurrent_writers_of_the_same_bytes_all_succeed_and_leave_one_blob() {
        let dir = std::env::temp_dir().join(format!("graft-fs-race-{}", std::process::id()));
        let store = Arc::new(FsBlobStore::open(&dir).expect("open"));
        let writers: Vec<_> = (0..32)
            .map(|_| {
                let store = store.clone();
                tokio::spawn(async move { store.put_if_absent(vec![7; 4096]).await })
            })
            .collect();
        for w in writers {
            assert_eq!(
                w.await.expect("task").expect("every writer succeeds"),
                Sha256Hash::of(&[7; 4096])
            );
        }
        assert_eq!(
            std::fs::read_dir(&dir).expect("dir").count(),
            1,
            "one blob, no temp files"
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[tokio::test]
    async fn a_file_whose_bytes_do_not_match_its_name_is_an_error_never_served() {
        let dir = std::env::temp_dir().join(format!("graft-fs-bad-{}", std::process::id()));
        let store = FsBlobStore::open(&dir).expect("open");
        let hash = store.put_if_absent(vec![1, 2, 3]).await.expect("put");
        std::fs::write(dir.join(hash.to_hex()), [9, 9, 9]).expect("tamper");
        assert_eq!(store.get(hash).await, Err(BlobError::Damaged));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
