//! Removes audio no content record uses any more: blobs older than the grace period that nothing
//! refers to. Run it on a schedule (the deploy ticket wires that up). It is idempotent and safe to
//! run while the service is publishing and while another copy of itself runs.
//! Reads the same configuration as the service (database, blob store, `GRAFT_ORPHAN_GRACE_SECS`).
#![allow(clippy::print_stdout)] // a command-line tool: output is its interface

use graft_api::blobs::build_blob_store;
use graft_api::config::Config;
use graft_storage::{Store, remove_orphans};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let store = Store::connect(&config.database_url, 2).await?;
    let blobs = build_blob_store(&config)?;
    let now = graft_storage::blob::now_ms();
    let report = remove_orphans(
        &store,
        blobs.as_ref(),
        Duration::from_secs(config.orphan_grace_secs),
        now,
    )
    .await?;
    println!(
        "examined {} removed {} kept_recent {} kept_referenced {} kept_raced {}",
        report.examined,
        report.removed,
        report.kept_recent,
        report.kept_referenced,
        report.kept_raced
    );
    Ok(())
}
