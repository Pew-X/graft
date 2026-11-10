#![allow(dead_code, clippy::expect_used, clippy::panic)] // shared by several test binaries
//! The contract every `BlobStore` must meet. It runs against the in-memory fake, the directory
//! store and the S3 client, so the fake cannot drift from the real thing.

use graft_domain::hash::Sha256Hash;
use graft_storage::{BlobError, BlobStore};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// How a test lets time pass for the store under test.
pub enum Time {
    /// A store with an injectable clock: move it.
    Fake(Arc<std::sync::atomic::AtomicI64>),
    /// A store on the real clock: wait.
    Real,
}

impl Time {
    pub async fn pass(&self, by: Duration) {
        match self {
            Time::Fake(now) => {
                now.fetch_add(
                    i64::try_from(by.as_millis()).expect("small"),
                    std::sync::atomic::Ordering::SeqCst,
                );
            }
            Time::Real => tokio::time::sleep(by).await,
        }
    }
}

fn bytes(n: u8, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| n.wrapping_add(u8::try_from(i % 251).expect("small")))
        .collect()
}

/// `refresh_after` is the threshold the store under test was built with; `grain` is the finest
/// difference in last-modified times the store can report (S3 reports whole seconds).
pub async fn run(store: Arc<dyn BlobStore>, time: Time, refresh_after: Duration, grain: Duration) {
    identical_bytes_are_stored_once(&*store).await;
    concurrent_identical_writes_are_safe(store.clone()).await;
    a_hash_that_does_not_match_the_bytes_is_refused(&*store).await;
    reads_round_trip_and_unknown_blobs_are_none(&*store).await;
    info_agrees_with_the_listing_and_is_none_for_an_unknown_blob(&*store).await;
    delete_removes_and_reports(&*store).await;
    a_blob_older_than_the_refresh_threshold_is_refreshed_by_a_write(
        &*store,
        &time,
        refresh_after,
        grain,
    )
    .await;
}

async fn identical_bytes_are_stored_once(store: &dyn BlobStore) {
    let data = bytes(1, 2048);
    let a = store.put_if_absent(data.clone()).await.expect("put");
    let b = store.put_if_absent(data.clone()).await.expect("put again");
    assert_eq!(a, b);
    assert_eq!(a, Sha256Hash::of(&data));
    let listed = store.list().await.expect("list");
    let of_this: Vec<_> = listed.iter().filter(|i| i.hash == a).collect();
    assert_eq!(of_this.len(), 1, "one object for identical bytes");
    assert_eq!(of_this[0].size, 2048);
    assert!(
        of_this[0].last_modified_ms > 1_700_000_000_000,
        "a real time is reported"
    );
}

async fn concurrent_identical_writes_are_safe(store: Arc<dyn BlobStore>) {
    let data = bytes(2, 4096);
    let tasks: Vec<_> = (0..16)
        .map(|_| {
            let (store, data) = (store.clone(), data.clone());
            tokio::spawn(async move { store.put_if_absent(data).await })
        })
        .collect();
    for t in tasks {
        assert_eq!(
            t.await.expect("task").expect("every writer succeeds"),
            Sha256Hash::of(&data)
        );
    }
    let hash = Sha256Hash::of(&data);
    let count = store
        .list()
        .await
        .expect("list")
        .iter()
        .filter(|i| i.hash == hash)
        .count();
    assert_eq!(count, 1);
    assert_eq!(store.get(hash).await.expect("get"), Some(data));
}

async fn a_hash_that_does_not_match_the_bytes_is_refused(store: &dyn BlobStore) {
    let data = bytes(3, 100);
    let wrong = Sha256Hash::of(b"something else");
    assert_eq!(
        store.put_verified(wrong, data.clone()).await,
        Err(BlobError::HashMismatch)
    );
    assert_eq!(
        store.get(wrong).await.expect("get"),
        None,
        "nothing was stored under the wrong hash"
    );
    assert_eq!(
        store.get(Sha256Hash::of(&data)).await.expect("get"),
        None,
        "and nothing under the right one"
    );
    let ok = store
        .put_verified(Sha256Hash::of(&data), data.clone())
        .await
        .expect("matching hash");
    assert_eq!(store.get(ok).await.expect("get"), Some(data));
}

async fn reads_round_trip_and_unknown_blobs_are_none(store: &dyn BlobStore) {
    let data = bytes(4, 777);
    let hash = store.put_if_absent(data.clone()).await.expect("put");
    assert_eq!(store.get(hash).await.expect("get"), Some(data));
    assert_eq!(
        store
            .get(Sha256Hash::of(b"never stored"))
            .await
            .expect("get"),
        None
    );
}

async fn info_agrees_with_the_listing_and_is_none_for_an_unknown_blob(store: &dyn BlobStore) {
    let data = bytes(7, 123);
    let hash = store.put_if_absent(data).await.expect("put");
    let info = store.info(hash).await.expect("info").expect("it exists");
    assert_eq!((info.hash, info.size), (hash, 123));
    // A metadata read reports an HTTP date (whole seconds) on S3 while a listing reports
    // milliseconds, so the two agree to within a second, not exactly.
    let listed = modified(store, hash).await;
    assert!(
        (info.last_modified_ms - listed).abs() < 1000,
        "info {} vs listing {listed}",
        info.last_modified_ms
    );
    assert_eq!(
        store
            .info(Sha256Hash::of(b"never stored"))
            .await
            .expect("info"),
        None
    );
}

async fn delete_removes_and_reports(store: &dyn BlobStore) {
    let hash = store.put_if_absent(bytes(5, 50)).await.expect("put");
    assert!(store.delete(hash).await.expect("delete"), "it existed");
    assert!(
        !store.delete(hash).await.expect("delete again"),
        "deleting what is not there is not an error"
    );
    assert_eq!(store.get(hash).await.expect("get"), None);
    let listed: HashSet<_> = store
        .list()
        .await
        .expect("list")
        .into_iter()
        .map(|i| i.hash)
        .collect();
    assert!(!listed.contains(&hash));
}

async fn a_blob_older_than_the_refresh_threshold_is_refreshed_by_a_write(
    store: &dyn BlobStore,
    time: &Time,
    refresh_after: Duration,
    grain: Duration,
) {
    let data = bytes(6, 300);
    let hash = store.put_if_absent(data.clone()).await.expect("put");
    let first = modified(store, hash).await;
    // Younger than the threshold: a repeat write leaves the time alone.
    store.put_if_absent(data.clone()).await.expect("put again");
    assert_eq!(
        modified(store, hash).await,
        first,
        "a recent blob is not touched"
    );
    // Older than the threshold: a write refreshes it, so cleanup cannot mistake it for a leftover.
    time.pass(refresh_after + grain + Duration::from_millis(100))
        .await;
    store
        .put_if_absent(data)
        .await
        .expect("put after the threshold");
    let refreshed = modified(store, hash).await;
    assert!(
        refreshed > first,
        "the time moved forward: {first} -> {refreshed}"
    );
}

async fn modified(store: &dyn BlobStore, hash: Sha256Hash) -> i64 {
    store
        .list()
        .await
        .expect("list")
        .into_iter()
        .find(|i| i.hash == hash)
        .expect("the blob is listed")
        .last_modified_ms
}
