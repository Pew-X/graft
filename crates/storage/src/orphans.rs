//! Orphan cleanup: remove audio that no content record uses any more.
//!
//! A publish writes its audio to the blob store before its database transaction, so a publish that
//! fails after the write leaves a blob nothing refers to. This job removes such blobs, and only
//! such blobs: one that is old enough and that no content record names, as the audio it was cut
//! from or as its output.
//!
//! The blob store and the database cannot be changed atomically together, so the job cannot make a
//! race impossible; it makes it very unlikely and repairable, with four defences:
//!
//! 1. A blob younger than the grace period is never touched. A publish takes seconds; the default
//!    grace is an hour.
//! 2. `BlobStore::put_if_absent` refreshes the time of an old blob that a new publish needs again,
//!    so an old leftover with the same bytes looks young the moment someone needs it.
//! 3. Immediately before deleting, the job reads the blob's time again, so a blob refreshed after
//!    the listing is not deleted on stale information.
//! 4. The publish path writes its blob again after its transaction commits, which restores a blob
//!    that was deleted in the instant between its first write and its commit.
//!
//! The job is idempotent and safe to run concurrently with itself and with publishing.

use crate::blob::{BlobError, BlobStore};
use crate::postgres::{Store, StoreError, db};
use graft_domain::hash::Sha256Hash;
use std::time::Duration;

/// What one run did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CleanupReport {
    /// Blobs listed.
    pub examined: usize,
    /// Blobs deleted.
    pub removed: usize,
    /// Blobs left alone because they are younger than the grace period.
    pub kept_recent: usize,
    /// Blobs left alone because a content record uses them.
    pub kept_referenced: usize,
    /// Blobs that looked old in the listing but had been refreshed or removed by the time of the
    /// last check.
    pub kept_raced: usize,
}

/// Why a run failed. A failure leaves everything it had not yet deleted untouched.
#[derive(Debug, thiserror::Error)]
pub enum CleanupError {
    /// The database failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The blob store failed.
    #[error(transparent)]
    Blob(#[from] BlobError),
}

impl Store {
    /// Whether any content record names `hash` as its source audio or its output.
    pub async fn blob_is_referenced(&self, hash: &Sha256Hash) -> Result<bool, StoreError> {
        sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM content_records WHERE source_blob = $1 OR output_blob = $1)",
        )
        .bind(hash.as_bytes().as_slice())
        .fetch_one(&self.pool)
        .await
        .map_err(db)
    }
}

/// Remove blobs that are older than `grace` and that no content record uses. `now_ms` is the
/// current time in milliseconds since the Unix epoch, passed in so tests can control it.
pub async fn remove_orphans(
    store: &Store,
    blobs: &dyn BlobStore,
    grace: Duration,
    now_ms: i64,
) -> Result<CleanupReport, CleanupError> {
    let grace_ms = i64::try_from(grace.as_millis()).unwrap_or(i64::MAX);
    let mut report = CleanupReport::default();
    for blob in blobs.list().await? {
        report.examined += 1;
        if now_ms.saturating_sub(blob.last_modified_ms) < grace_ms {
            report.kept_recent += 1;
            continue;
        }
        if store.blob_is_referenced(&blob.hash).await? {
            report.kept_referenced += 1;
            continue;
        }
        // The listing may be stale: read the blob's time again right before deleting.
        match blobs.info(blob.hash).await? {
            Some(now) if now_ms.saturating_sub(now.last_modified_ms) >= grace_ms => {
                if blobs.delete(blob.hash).await? {
                    report.removed += 1;
                } else {
                    report.kept_raced += 1;
                }
            }
            _ => report.kept_raced += 1,
        }
    }
    Ok(report)
}
