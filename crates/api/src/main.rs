//! The graft service entry point.

use graft_api::config::Config;
use graft_api::http::{AppState, router};
use graft_storage::{BlobStore, FsBlobStore, MemoryBlobStore, Store};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let store = Store::connect(&config.database_url, 10).await?;
    store.migrate().await?;
    // The object-store client arrives with the blob ticket. Until then a directory (shared with
    // graft-seed) holds audio when GRAFT_BLOB_DIR is set, and memory otherwise.
    let blobs: Arc<dyn BlobStore> = match std::env::var("GRAFT_BLOB_DIR") {
        Ok(dir) => Arc::new(FsBlobStore::open(dir)?),
        Err(_) => Arc::new(MemoryBlobStore::default()),
    };
    let state = AppState::new(&config, store, blobs);
    let app = router(state, &config);
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(bind = %config.bind, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
