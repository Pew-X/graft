#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The relay against a real Postgres: at-least-once delivery, no skipped rows under concurrent
//! relays and out-of-order commits, redelivery after a crash, and retention that never discards an
//! undelivered event.

use graft_events::{EventSink, MemorySink, Relay, Retention, SinkError};
use graft_storage::blob::BoxFuture;
use graft_storage::testing::TestDb;
use graft_storage::{EventKind, NewEvent, StoredEvent};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

fn client_event(n: u32, at_ms: Option<i64>) -> NewEvent {
    NewEvent {
        event_id: Some(format!("event-id-for-test-{n:06}")),
        kind: EventKind::StagePlayed,
        session_id: Some("session-0001".into()),
        occurred_at_ms: at_ms,
        publication_id: Some("pub".into()),
        detail: None,
    }
}

async fn fill(db: &TestDb, n: u32) {
    let events: Vec<NewEvent> = (0..n).map(|i| client_event(i, None)).collect();
    assert_eq!(
        db.store.append_events(&events).await.expect("append"),
        u64::from(n)
    );
}

fn ids(events: &[StoredEvent]) -> HashSet<String> {
    events.iter().map(|e| e.event_id.clone()).collect()
}

#[tokio::test]
async fn a_relay_delivers_every_unsent_event_once_in_bounded_batches_and_marks_them_sent() {
    let db = TestDb::create().await;
    fill(&db, 25).await;
    let sink = Arc::new(MemorySink::default());
    let relay = Relay::new(db.store.clone(), sink.clone(), 10);
    assert_eq!(
        relay.run_once().await.expect("pass"),
        10,
        "a batch is bounded"
    );
    assert_eq!(relay.drain().await.expect("drain"), 15);
    assert_eq!(sink.delivered().len(), 25);
    assert_eq!(ids(&sink.delivered()).len(), 25);
    let backlog = db.store.event_backlog().await.expect("backlog");
    assert_eq!(backlog.unsent, 0);
    assert_eq!(relay.run_once().await.expect("pass"), 0, "nothing left");
    db.drop_db().await;
}

/// A sink slow enough that the relays overlap.
struct Slow(MemorySink);

impl EventSink for Slow {
    fn deliver<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.0.deliver(batch).await
        })
    }
}

#[tokio::test]
async fn two_relays_over_one_backlog_deliver_every_row_and_skip_none() {
    let db = TestDb::create().await;
    fill(&db, 200).await;
    let sink = Arc::new(Slow(MemorySink::default()));
    let a = Relay::new(db.store.clone(), sink.clone(), 7);
    let b = Relay::new(db.store.clone(), sink.clone(), 11);
    let (ra, rb) = tokio::join!(a.drain(), b.drain());
    let (ra, rb) = (ra.expect("a"), rb.expect("b"));
    let delivered = sink.0.delivered();
    assert_eq!(ids(&delivered).len(), 200, "every row was delivered");
    assert!(ra > 0 && rb > 0, "both relays did work: {ra} and {rb}");
    assert_eq!(
        delivered.len(),
        200,
        "claims skip rows another relay holds, so nothing is delivered twice either"
    );
    assert_eq!(db.store.event_backlog().await.expect("backlog").unsent, 0);
    db.drop_db().await;
}

/// The case a cursor on the id sequence gets wrong: a transaction took a lower id and commits after
/// a higher id was already delivered.
#[tokio::test]
async fn a_row_that_commits_after_a_higher_id_was_delivered_is_still_delivered() {
    let db = TestDb::create().await;
    let sink = Arc::new(MemorySink::default());
    let relay = Relay::new(db.store.clone(), sink.clone(), 100);

    // A long transaction takes the lower id and stays open.
    let mut slow = db.store.pool().begin().await.expect("begin");
    sqlx::query(
        "INSERT INTO events (event_id, kind, origin, session_id, publication_id) \
         VALUES ('event-id-low-0000001', 'stage_played', 'client', 'session-0001', 'p')",
    )
    .execute(&mut *slow)
    .await
    .expect("insert low");
    // A later transaction takes a higher id and commits.
    db.store
        .append_events(&[client_event(2, None)])
        .await
        .expect("append high");

    assert_eq!(
        relay.drain().await.expect("drain"),
        1,
        "only the committed row is there"
    );
    assert_eq!(sink.delivered()[0].event_id, "event-id-for-test-000002");

    slow.commit().await.expect("commit low");
    let low: i64 =
        sqlx::query_scalar("SELECT seq FROM events WHERE event_id = 'event-id-low-0000001'")
            .fetch_one(db.store.pool())
            .await
            .expect("low");
    let high: i64 =
        sqlx::query_scalar("SELECT seq FROM events WHERE event_id = 'event-id-for-test-000002'")
            .fetch_one(db.store.pool())
            .await
            .expect("high");
    assert!(
        low < high,
        "the late commit has the lower id ({low} < {high})"
    );
    assert_eq!(relay.drain().await.expect("drain"), 1);
    assert!(
        ids(&sink.delivered()).contains("event-id-low-0000001"),
        "a cursor on the id sequence would have skipped it for good"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_sink_that_refuses_leaves_the_rows_unsent_and_the_next_pass_delivers_them() {
    let db = TestDb::create().await;
    fill(&db, 5).await;
    let sink = Arc::new(MemorySink::default());
    sink.fail_next(1);
    let relay = Relay::new(db.store.clone(), sink.clone(), 100);
    assert_eq!(relay.run_once().await.expect("pass"), 0);
    assert_eq!(db.store.event_backlog().await.expect("backlog").unsent, 5);
    assert_eq!(relay.run_once().await.expect("pass"), 5);
    assert_eq!(db.store.event_backlog().await.expect("backlog").unsent, 0);
    db.drop_db().await;
}

/// Receives the batch, then never answers.
struct Hang {
    received: tokio::sync::mpsc::UnboundedSender<usize>,
    delivered: MemorySink,
}

impl EventSink for Hang {
    fn deliver<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        Box::pin(async move {
            let _ = self.delivered.deliver(batch).await;
            let _ = self.received.send(batch.len());
            std::future::pending::<()>().await;
            Ok(())
        })
    }
}

#[tokio::test]
async fn a_relay_killed_between_claim_and_acknowledgement_loses_nothing_and_its_rows_are_redelivered()
 {
    let db = TestDb::create().await;
    fill(&db, 9).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let hanging = Arc::new(Hang {
        received: tx,
        delivered: MemorySink::default(),
    });
    let doomed = Relay::new(db.store.clone(), hanging.clone(), 100);
    let task = tokio::spawn(async move { doomed.run_once().await });
    assert_eq!(
        rx.recv().await,
        Some(9),
        "the batch was claimed and handed to the sink"
    );
    task.abort();
    let _ = task.await;
    assert_eq!(
        hanging.delivered.delivered().len(),
        9,
        "the sink had the batch, but it was never acknowledged"
    );

    // The claim ends with the dead transaction; a fresh relay delivers the same rows.
    let sink = Arc::new(MemorySink::default());
    let relay = Relay::new(db.store.clone(), sink.clone(), 100);
    let mut got = 0;
    for _ in 0..100 {
        got += relay.drain().await.expect("drain");
        if got == 9 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(got, 9, "every row was redelivered");
    assert_eq!(ids(&sink.delivered()), ids(&hanging.delivered.delivered()));
    db.drop_db().await;
}

#[tokio::test]
async fn retention_deletes_old_sent_events_and_never_an_unsent_one() {
    let db = TestDb::create().await;
    let day = 86_400_000_i64;
    let now = 1_800_000_000_000_i64;
    // Four old events (40 days), two recent ones.
    let mut events: Vec<NewEvent> = (0..4)
        .map(|i| client_event(i, Some(now - 40 * day)))
        .collect();
    events.extend((4..6).map(|i| client_event(i, Some(now - day))));
    db.store.append_events(&events).await.expect("append");
    // Two of the old ones are delivered; the rest are not.
    sqlx::query(
        "UPDATE events SET relay_state = 'sent', sent_at = now() \
         WHERE event_id IN ('event-id-for-test-000000', 'event-id-for-test-000001')",
    )
    .execute(db.store.pool())
    .await
    .expect("mark");
    let retention = Retention::new(db.store.clone(), 30);
    assert_eq!(retention.drain(now).await.expect("retention"), 2);
    let left: Vec<String> = sqlx::query_scalar("SELECT event_id FROM events ORDER BY seq")
        .fetch_all(db.store.pool())
        .await
        .expect("left");
    assert_eq!(
        left,
        [
            "event-id-for-test-000002",
            "event-id-for-test-000003",
            "event-id-for-test-000004",
            "event-id-for-test-000005"
        ],
        "the old unsent events and the recent ones stay"
    );
    // Once delivered, the old ones can go.
    let sink = Arc::new(MemorySink::default());
    Relay::new(db.store.clone(), sink, 100)
        .drain()
        .await
        .expect("drain");
    assert_eq!(retention.drain(now).await.expect("retention"), 2);
    assert_eq!(db.store.all_events().await.expect("all").len(), 2);
    db.drop_db().await;
}

#[tokio::test]
async fn retention_running_alongside_the_relay_loses_and_duplicates_nothing() {
    let db = TestDb::create().await;
    let day = 86_400_000_i64;
    let now = 1_800_000_000_000_i64;
    let events: Vec<NewEvent> = (0..300)
        .map(|i| client_event(i, Some(now - 40 * day)))
        .collect();
    db.store.append_events(&events).await.expect("append");
    let sink = Arc::new(Slow(MemorySink::default()));
    let relay = Relay::new(db.store.clone(), sink.clone(), 13);
    let retention = Retention::new(db.store.clone(), 30);
    let purge = async {
        let mut deleted = 0;
        for _ in 0..40 {
            deleted += retention.run_once(now, 25).await.expect("retention");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        deleted
    };
    let (delivered, _deleted) = tokio::join!(relay.drain(), purge);
    assert_eq!(delivered.expect("drain"), 300);
    assert_eq!(
        ids(&sink.0.delivered()).len(),
        300,
        "every event was delivered before it could be deleted"
    );
    db.drop_db().await;
}
