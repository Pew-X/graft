#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The contract against the two implementations that need no server.

mod blob_contract;

use blob_contract::{Time, run};
use graft_storage::{FsBlobStore, MemoryBlobStore};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

#[tokio::test]
async fn the_in_memory_store_meets_the_contract() {
    let now = Arc::new(AtomicI64::new(1_800_000_000_000));
    let clock = now.clone();
    let refresh = Duration::from_secs(60);
    let store =
        MemoryBlobStore::with_clock(Arc::new(move || clock.load(Ordering::SeqCst)), refresh);
    run(
        Arc::new(store),
        Time::Fake(now),
        refresh,
        Duration::from_millis(1),
    )
    .await;
}

#[tokio::test]
async fn the_directory_store_meets_the_contract() {
    let dir = std::env::temp_dir().join(format!("graft-contract-{}", std::process::id()));
    let refresh = Duration::from_millis(200);
    let store = FsBlobStore::open_with(&dir, refresh).expect("open");
    run(
        Arc::new(store),
        Time::Real,
        refresh,
        Duration::from_millis(50),
    )
    .await;
    std::fs::remove_dir_all(&dir).expect("cleanup");
}
