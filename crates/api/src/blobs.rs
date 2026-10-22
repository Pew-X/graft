//! Choosing the blob store from configuration: an S3-compatible bucket when one is configured, a
//! directory for local runs, and memory otherwise (audio that cannot be fetched and does not
//! survive a restart, so the service says so loudly).

use crate::config::Config;
use graft_storage::{BlobError, BlobStore, FsBlobStore, MemoryBlobStore, S3BlobStore};
use std::sync::Arc;
use std::time::Duration;

/// Build the store the configuration asks for. Logs which kind, and never anything that could
/// identify an account or carry a credential.
pub fn build_blob_store(config: &Config) -> Result<Arc<dyn BlobStore>, BlobError> {
    let refresh = Duration::from_secs(config.blob_refresh_secs);
    if let Some(s3) = &config.s3 {
        tracing::info!(bucket = %s3.bucket, "audio is stored in an S3-compatible bucket");
        if config.blob_dir.is_some() {
            tracing::warn!("GRAFT_BLOB_DIR is ignored because an S3 bucket is configured");
        }
        return Ok(Arc::new(S3BlobStore::new(s3)?));
    }
    if let Some(dir) = &config.blob_dir {
        tracing::warn!("audio is stored in a local directory: for development only");
        return Ok(Arc::new(FsBlobStore::open_with(dir, refresh)?));
    }
    tracing::warn!(
        "no blob store is configured: audio is kept in memory, cannot be fetched and is lost on restart"
    );
    Ok(Arc::new(MemoryBlobStore::with_clock(
        Arc::new(graft_storage::blob::now_ms),
        refresh,
    )))
}
