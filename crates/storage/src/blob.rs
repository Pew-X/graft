//! Blob storage behind a trait: content-addressed by SHA-256, written put-if-absent, read through
//! short-lived URLs. The in-memory implementation is the fast fake for tests; ticket 11 adds the
//! S3-compatible client and a contract suite that runs against both.

use graft_domain::hash::Sha256Hash;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;

/// A boxed future, so the trait works as a trait object without an extra crate.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why a blob operation failed. Never carries credentials or endpoints.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BlobError {
    /// The store could not be reached or refused the request.
    #[error("the blob store failed: {0}")]
    Store(String),
}

/// Content-addressed blob storage.
pub trait BlobStore: Send + Sync {
    /// Store `bytes` under their SHA-256 unless already present; returns the hash either way.
    fn put_if_absent(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<Sha256Hash, BlobError>>;

    /// A URL from which `hash` can be fetched for `ttl`. Issued only after the caller has checked
    /// that the publication asking for it is available; a blob hash alone never grants access.
    fn signed_url(
        &self,
        hash: Sha256Hash,
        ttl: Duration,
    ) -> BoxFuture<'_, Result<String, BlobError>>;
}

/// An in-memory store for tests and local runs.
#[derive(Default)]
pub struct MemoryBlobStore {
    blobs: Mutex<HashMap<Sha256Hash, Vec<u8>>>,
}

impl MemoryBlobStore {
    /// The stored bytes for `hash`, if any.
    #[must_use]
    pub fn get(&self, hash: &Sha256Hash) -> Option<Vec<u8>> {
        self.blobs.lock().ok()?.get(hash).cloned()
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
            let mut blobs = self
                .blobs
                .lock()
                .map_err(|_| BlobError::Store("poisoned".into()))?;
            blobs.entry(hash).or_insert(bytes);
            Ok(hash)
        })
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
}

#[cfg(test)]
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
}

/// A directory-backed store for local runs, so a seed script and the service can share audio
/// without an object store. URLs are `file://` paths: local development only.
pub struct FsBlobStore {
    dir: std::path::PathBuf,
}

impl FsBlobStore {
    /// Use `dir`, creating it if needed.
    pub fn open(dir: impl Into<std::path::PathBuf>) -> Result<Self, BlobError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(|e| BlobError::Store(e.kind().to_string()))?;
        Ok(Self { dir })
    }

    fn path(&self, hash: &Sha256Hash) -> std::path::PathBuf {
        self.dir.join(hash.to_hex())
    }
}

impl BlobStore for FsBlobStore {
    fn put_if_absent(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<Sha256Hash, BlobError>> {
        Box::pin(async move {
            let hash = Sha256Hash::of(&bytes);
            let target = self.path(&hash);
            if target.exists() {
                return Ok(hash);
            }
            // Write beside the target and rename, so a reader never sees a half-written blob and
            // two writers of the same bytes cannot corrupt each other.
            let temp = self
                .dir
                .join(format!(".{}.{}", hash.to_hex(), std::process::id()));
            let io = |e: std::io::Error| BlobError::Store(e.kind().to_string());
            tokio::fs::write(&temp, &bytes).await.map_err(io)?;
            tokio::fs::rename(&temp, &target).await.map_err(io)?;
            Ok(hash)
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
}

#[cfg(test)]
mod fs_tests {
    use super::*;

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
}
