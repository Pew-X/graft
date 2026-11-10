#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The queue does not change the result. The same events go through the Postgres-only sink into one
//! database and through the queue (sink, queue, consumer) into another, and the rollups are equal, and
//! equal to the counts worked out by hand. That holds with a batch delivered twice, with messages that
//! cannot be read, and with a queue that refuses a send. Against real Postgres.

use graft_events::{Consumer, ConsumerSink, EventKind, Relay};
use graft_queue::{MemoryQueue, PollSettings, QueueConsumer, QueueSink, encode};
use graft_storage::testing::TestDb;
use graft_storage::{NewEvent, Origin, RollupRow};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

// An exact hour boundary (1,800,000,000,000 ms is 500,000 hours after the epoch).
const BASE_MS: i64 = 1_800_000_000_000;
const HOUR: i64 = 3_600_000;
const EVENTS: usize = 57;

/// Event `n`: its kind, hour and publication follow from `n` alone, so the expected counts can be
/// worked out without running anything.
fn spec(n: usize) -> (EventKind, i64, String) {
    (
        EventKind::ALL[n % 5],
        (n % 4) as i64,
        format!("pub-{}", n % 3),
    )
}

fn events() -> Vec<NewEvent> {
    (0..EVENTS)
        .map(|n| {
            let (kind, hour, publication) = spec(n);
            NewEvent {
                event_id: Some(format!("event-id-for-test-{n:06}")),
                kind,
                session_id: (kind.origin() == Origin::Client).then(|| "session-0001".to_owned()),
                occurred_at_ms: Some(BASE_MS + hour * HOUR + (n as i64) * 1_000),
                publication_id: Some(publication),
                detail: None,
            }
        })
        .collect()
}

/// The rollups the events must produce, from the specs alone.
fn expected() -> Vec<RollupRow> {
    let mut counts: BTreeMap<(i64, &'static str, String), (EventKind, i64)> = BTreeMap::new();
    for n in 0..EVENTS {
        let (kind, hour, publication) = spec(n);
        counts
            .entry((BASE_MS + hour * HOUR, kind.as_str(), publication))
            .or_insert((kind, 0))
            .1 += 1;
    }
    counts
        .into_iter()
        .map(|((hour_ms, _, publication_id), (kind, count))| RollupRow {
            hour_ms,
            kind,
            publication_id,
            count,
        })
        .collect()
}

async fn through_postgres_only(db: &TestDb) {
    db.store.append_events(&events()).await.expect("append");
    let consumer = Consumer::new(db.store.clone());
    let relay = Relay::new(db.store.clone(), Arc::new(ConsumerSink(consumer)), 8);
    assert_eq!(relay.drain().await.expect("drain"), EVENTS);
}

fn consumer_for(db: &TestDb, queue: &Arc<MemoryQueue>) -> (QueueConsumer, Arc<Consumer>) {
    let applying = Arc::new(Consumer::new(db.store.clone()));
    (
        QueueConsumer::new(queue.clone(), applying.clone(), PollSettings::default()),
        applying,
    )
}

async fn poll_until_idle(consumer: &QueueConsumer) {
    loop {
        if consumer.poll_once().await.expect("poll").received == 0 {
            return;
        }
    }
}

async fn databases() -> (TestDb, TestDb) {
    (TestDb::create().await, TestDb::create().await)
}

#[tokio::test]
async fn the_same_events_through_the_queue_give_the_same_rollups_as_without_it() {
    let (plain, queued) = databases().await;
    through_postgres_only(&plain).await;

    queued.store.append_events(&events()).await.expect("append");
    let queue = Arc::new(MemoryQueue::new(5));
    // batches of 8 so the events travel in several messages
    let relay = Relay::new(
        queued.store.clone(),
        Arc::new(QueueSink::new(queue.clone(), Duration::from_secs(5))),
        8,
    );
    assert_eq!(relay.drain().await.expect("drain"), EVENTS);
    assert_eq!(
        queue.sent(),
        EVENTS.div_ceil(8),
        "one message per batch of eight"
    );
    let (consumer, _) = consumer_for(&queued, &queue);
    poll_until_idle(&consumer).await;

    let by_queue = queued.store.rollup_rows().await.expect("rows");
    assert_eq!(by_queue, plain.store.rollup_rows().await.expect("rows"));
    assert_eq!(
        by_queue,
        expected(),
        "and both are the counts worked out by hand"
    );
    assert_eq!(by_queue.iter().map(|r| r.count).sum::<i64>(), EVENTS as i64);
    assert_eq!(
        queue.ready() + queue.in_flight(),
        0,
        "everything applied was deleted"
    );
    plain.drop_db().await;
    queued.drop_db().await;
}

#[tokio::test]
async fn a_batch_delivered_twice_is_counted_once() {
    let (plain, queued) = databases().await;
    through_postgres_only(&plain).await;

    queued.store.append_events(&events()).await.expect("append");
    let stored = queued.store.all_events().await.expect("all");
    let queue = Arc::new(MemoryQueue::new(5));
    // the same messages put in twice, as a redelivery or a retried send would
    for body in encode(&stored).expect("encode") {
        queue.put(&body);
        queue.put(&body);
    }
    let (consumer, applying) = consumer_for(&queued, &queue);
    poll_until_idle(&consumer).await;

    assert_eq!(
        queued.store.rollup_rows().await.expect("rows"),
        plain.store.rollup_rows().await.expect("rows")
    );
    assert_eq!(applying.stats().applied(), EVENTS as u64);
    assert_eq!(
        applying.stats().duplicates(),
        EVENTS as u64,
        "the second copy of each was recognised"
    );
    plain.drop_db().await;
    queued.drop_db().await;
}

#[tokio::test]
async fn messages_that_cannot_be_read_end_in_the_dead_letter_queue_and_change_no_count() {
    let (plain, queued) = databases().await;
    through_postgres_only(&plain).await;

    queued.store.append_events(&events()).await.expect("append");
    let stored = queued.store.all_events().await.expect("all");
    let queue = Arc::new(MemoryQueue::new(3));
    queue.put("garbage that is not a message");
    for body in encode(&stored).expect("encode") {
        queue.put(&body);
    }
    queue.put(r#"{"v":9,"events":[]}"#);
    let (consumer, _) = consumer_for(&queued, &queue);
    poll_until_idle(&consumer).await;
    for _ in 0..3 {
        queue.expire_visibility();
        poll_until_idle(&consumer).await;
    }
    queue.expire_visibility();

    assert_eq!(
        queue.dead_letters().len(),
        2,
        "both unreadable messages, and only those"
    );
    assert_eq!(
        queued.store.rollup_rows().await.expect("rows"),
        plain.store.rollup_rows().await.expect("rows")
    );
    plain.drop_db().await;
    queued.drop_db().await;
}

#[tokio::test]
async fn a_queue_that_refuses_a_send_leaves_the_events_unsent_and_loses_none() {
    let db = TestDb::create().await;
    db.store.append_events(&events()).await.expect("append");
    let queue = Arc::new(MemoryQueue::new(5));
    let relay = Relay::new(
        db.store.clone(),
        Arc::new(QueueSink::new(queue.clone(), Duration::from_secs(5))),
        100,
    );
    queue.fail_next_sends(1);
    assert_eq!(
        relay.run_once().await.expect("pass"),
        0,
        "the refused batch is not delivered"
    );
    assert_eq!(
        db.store
            .event_backlog(BASE_MS)
            .await
            .expect("backlog")
            .unsent,
        EVENTS as i64
    );
    assert_eq!(queue.sent(), 0);
    assert_eq!(
        relay.drain().await.expect("drain"),
        EVENTS,
        "the next pass sends them"
    );
    let (consumer, _) = consumer_for(&db, &queue);
    poll_until_idle(&consumer).await;
    assert_eq!(db.store.rollup_rows().await.expect("rows"), expected());
    db.drop_db().await;
}
