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
