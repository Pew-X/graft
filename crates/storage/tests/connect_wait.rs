#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! A paused database (Aurora Serverless v2 at zero capacity) takes a while to resume, and a start that
//! gives up at the first refused connection would crash-loop instead of waiting for it. Connecting
//! waits, for a bounded time, only for a database that is not answering yet; a wrong password or a
//! malformed address is answered at once, because waiting cannot fix either.

use graft_storage::Store;
use std::time::{Duration, Instant};

fn url() -> String {
    std::env::var("GRAFT_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:graft@127.0.0.1:55432/postgres".to_owned())
}

/// An address on this machine that nothing is listening on.
async fn unused_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    listener.local_addr().expect("addr").port()
}

#[tokio::test]
async fn a_wait_of_zero_makes_one_attempt_and_fails() {
    let port = unused_port().await;
    let started = Instant::now();
    let result = Store::connect_waiting(
        &format!("postgres://postgres:graft@127.0.0.1:{port}/postgres"),
        1,
        Duration::ZERO,
    )
    .await;
    assert!(result.is_err());
    // One attempt lasts up to five seconds; a second attempt would take it past eight.
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "it made more than one attempt: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn an_unreachable_database_is_waited_for_and_then_given_up_on() {
    let port = unused_port().await;
    let started = Instant::now();
    let result = Store::connect_waiting(
        &format!("postgres://postgres:graft@127.0.0.1:{port}/postgres"),
        1,
        Duration::from_secs(3),
    )
    .await;
    assert!(
        result.is_err(),
        "nothing is listening, so it must fail in the end"
    );
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(2),
        "it gave up after {took:?}, before its wait"
    );
    assert!(
        took < Duration::from_secs(10),
        "it waited far past its limit: {took:?}"
    );
}

#[tokio::test]
async fn a_database_that_starts_answering_late_is_connected_to() {
    // A forwarder that starts listening after a second and a half, in front of the real server.
    let port = unused_port().await;
    let real = url();
    let target = real
        .split('@')
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .expect("host and port")
        .to_owned();
    let forwarder = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("bind late");
        loop {
            let Ok((mut inbound, _)) = listener.accept().await else {
                return;
            };
            let target = target.clone();
            tokio::spawn(async move {
                if let Ok(mut outbound) = tokio::net::TcpStream::connect(target).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    });
    let started = Instant::now();
    let via = format!("postgres://postgres:graft@127.0.0.1:{port}/postgres");
    let store = Store::connect_waiting(&via, 1, Duration::from_secs(20)).await;
    forwarder.abort();
    assert!(
        store.is_ok(),
        "it should have connected once the database answered"
    );
    assert!(
        started.elapsed() >= Duration::from_millis(1200),
        "it cannot have connected before the listener existed"
    );
}

#[tokio::test]
async fn a_wrong_password_is_refused_at_once_not_waited_for() {
    let bad = url().replace("graft@", "not-the-password@");
    let started = Instant::now();
    let result = Store::connect_waiting(&bad, 1, Duration::from_secs(30)).await;
    assert!(result.is_err());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "it waited on a refusal that waiting cannot fix: {:?}",
        started.elapsed()
    );
}
