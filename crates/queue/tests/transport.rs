#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The envelope, the sink and the queue consumer against an in-memory queue (no database): what a
//! message can hold and refuse, that nothing is deleted before it is applied, that a message that
//! cannot be applied is set aside after a bounded number of receives without holding up the rest,
//! and that an idle or failing queue is polled gently.

use graft_events::{BatchConsumer, EventSink, SinkError};
use graft_queue::{
    EnvelopeError, MAX_MESSAGE_BYTES, MemoryQueue, PollSettings, QueueConsumer, QueueError,
    QueueSink, Received, Transport, decode, encode,
};
use graft_storage::blob::BoxFuture;
use graft_storage::{EventKind, Origin, StoredEvent};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

fn event(n: i64, detail: Option<String>) -> StoredEvent {
    StoredEvent {
        seq: n,
        event_id: format!("event-id-for-test-{n:06}"),
        kind: EventKind::StagePlayed,
        origin: Origin::Client,
        session_id: Some("session-0001".to_owned()),
        occurred_at_ms: 1_800_000_000_000 + n,
        hour_ms: 1_800_000_000_000,
        publication_id: Some("pub-1".to_owned()),
        detail,
    }
}

/// A consumer that records what it applied and can be told to refuse.
#[derive(Default)]
struct Recorder {
    applied: Mutex<Vec<String>>,
    refuse: Mutex<bool>,
}

impl Recorder {
    fn ids(&self) -> Vec<String> {
        self.applied.lock().expect("lock").clone()
    }
    fn refuse(&self, on: bool) {
        *self.refuse.lock().expect("lock") = on;
    }
}

impl BatchConsumer for Recorder {
    fn apply<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        Box::pin(async move {
            if *self.refuse.lock().expect("lock") {
                return Err(SinkError("told to refuse".to_owned()));
            }
            self.applied
                .lock()
                .expect("lock")
                .extend(batch.iter().map(|e| e.event_id.clone()));
            Ok(())
        })
    }
}

fn consumer(queue: &Arc<MemoryQueue>, recorder: &Arc<Recorder>) -> QueueConsumer {
    QueueConsumer::new(queue.clone(), recorder.clone(), PollSettings::default())
}

// ---- the envelope ----

#[test]
fn a_batch_survives_a_message_unchanged() {
    let batch = vec![event(1, None), event(2, Some("a detail".to_owned()))];
    let bodies = encode(&batch).expect("encode");
    assert_eq!(bodies.len(), 1);
    assert!(
        bodies[0].starts_with(r#"{"v":1,"events":["#),
        "the version leads the message"
    );
    assert_eq!(decode(&bodies[0]).expect("decode"), batch);
}

#[test]
fn an_empty_batch_makes_no_message() {
    assert!(encode(&[]).expect("encode").is_empty());
}

#[test]
fn a_big_batch_is_split_in_order_and_every_message_fits() {
    // each event carries about 2,000 bytes of detail, so a 24 KiB message holds about eleven
    let batch: Vec<StoredEvent> = (0..60).map(|n| event(n, Some("d".repeat(2_000)))).collect();
    let bodies = encode(&batch).expect("encode");
    assert!(
        bodies.len() >= 5 && bodies.len() <= 8,
        "got {} messages",
        bodies.len()
    );
    assert!(bodies.iter().all(|b| b.len() <= MAX_MESSAGE_BYTES));
    let back: Vec<StoredEvent> = bodies
        .iter()
        .flat_map(|b| decode(b).expect("decode"))
        .collect();
    assert_eq!(back, batch, "nothing lost, nothing repeated, same order");
}

#[test]
fn ten_messages_always_fit_the_queues_limit_for_one_request() {
    // the queue allows 256 KiB for the ten messages of one request
    const { assert!(10 * MAX_MESSAGE_BYTES <= 256 * 1024) };
}

#[test]
fn one_event_too_big_for_a_message_is_refused_by_name_not_dropped() {
    let big = event(7, Some("d".repeat(MAX_MESSAGE_BYTES)));
    assert_eq!(
        encode(&[event(1, None), big]),
        Err(EnvelopeError::TooLarge(
            "event-id-for-test-000007".to_owned()
        ))
    );
}

#[test]
fn a_message_of_another_version_or_shape_is_refused_not_guessed_at() {
    assert_eq!(
        decode(r#"{"v":2,"events":[]}"#),
        Err(EnvelopeError::UnknownVersion(2))
    );
    assert!(matches!(
        decode("not json"),
        Err(EnvelopeError::Unreadable(_))
    ));
    assert!(matches!(
        decode(r#"{"v":1}"#),
        Err(EnvelopeError::Unreadable(_))
    ));
    let odd = r#"{"v":1,"events":[{"seq":1,"event_id":"e","kind":"teleported","origin":"client","occurred_at_ms":1,"hour_ms":0}]}"#;
    assert!(matches!(decode(odd), Err(EnvelopeError::UnknownEvent(_))));
}

#[test]
fn a_field_added_later_does_not_break_an_older_reader() {
    let body = r#"{"v":1,"events":[{"seq":1,"event_id":"e","kind":"roll_opened","origin":"client","occurred_at_ms":1,"hour_ms":0,"added_later":true}]}"#;
    assert_eq!(decode(body).expect("decode").len(), 1);
}

// ---- the sink ----

#[tokio::test]
async fn the_sink_sends_a_batch_and_reports_a_refusal_so_the_rows_stay_unsent() {
    let queue = Arc::new(MemoryQueue::new(5));
    let sink = QueueSink::new(queue.clone(), Duration::from_secs(5));
    sink.deliver(&[event(1, None), event(2, None)])
        .await
        .expect("sent");
    assert_eq!(queue.sent(), 1);
    queue.fail_next_sends(1);
    assert!(sink.deliver(&[event(3, None)]).await.is_err());
    assert_eq!(queue.sent(), 1, "the refused batch is not in the queue");
    sink.deliver(&[])
        .await
        .expect("an empty batch is nothing to send");
    assert_eq!(queue.sent(), 1);
}

struct Slow;
impl Transport for Slow {
    fn send<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        })
    }
    fn receive(&self, _: Duration, _: u32) -> BoxFuture<'_, Result<Vec<Received>, QueueError>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn delete<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn a_send_that_hangs_is_cut_off_so_the_relay_never_holds_its_claim_for_long() {
    let sink = QueueSink::new(Arc::new(Slow), Duration::from_millis(50));
    let started = std::time::Instant::now();
    let result = sink.deliver(&[event(1, None)]).await;
    assert!(
        result
            .expect_err("timed out")
            .0
            .contains("did not answer in time")
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

// ---- the consumer ----

#[tokio::test]
async fn a_message_is_deleted_only_after_its_events_were_applied() {
    let queue = Arc::new(MemoryQueue::new(5));
    let recorder = Arc::new(Recorder::default());
    for body in encode(&[event(1, None), event(2, None)]).expect("encode") {
        queue.put(&body);
    }
    recorder.refuse(true);
    let report = consumer(&queue, &recorder).poll_once().await.expect("poll");
    assert_eq!((report.received, report.applied, report.failed), (1, 0, 1));
    assert_eq!(
        queue.in_flight(),
        1,
        "refused: still in the queue, not deleted"
    );
    queue.expire_visibility();
    recorder.refuse(false);
    let report = consumer(&queue, &recorder).poll_once().await.expect("poll");
    assert_eq!((report.applied, report.failed), (1, 0));
    assert_eq!(queue.in_flight() + queue.ready(), 0, "applied: deleted");
    assert_eq!(recorder.ids().len(), 2);
}

#[tokio::test]
async fn a_message_that_cannot_be_applied_is_set_aside_after_three_receives_and_the_rest_flow() {
    let queue = Arc::new(MemoryQueue::new(3));
    let recorder = Arc::new(Recorder::default());
    let c = consumer(&queue, &recorder);
    queue.put("this is not an event message");
    queue.put(r#"{"v":2,"events":[]}"#);
    for body in encode(&[event(1, None)]).expect("encode") {
        queue.put(&body);
    }
    let first = c.poll_once().await.expect("poll");
    assert_eq!((first.received, first.applied, first.unreadable), (3, 1, 2));
    assert_eq!(
        recorder.ids(),
        vec!["event-id-for-test-000001".to_owned()],
        "the good one flowed past"
    );
    for _ in 0..2 {
        queue.expire_visibility();
        c.poll_once().await.expect("poll");
    }
    queue.expire_visibility();
    assert_eq!(
        queue.dead_letters().len(),
        2,
        "both set aside after the third receive"
    );
    assert_eq!(queue.ready() + queue.in_flight(), 0);
    assert_eq!(recorder.ids().len(), 1, "and nothing was applied twice");
}

#[tokio::test]
async fn a_message_delivered_twice_is_applied_twice_by_this_layer_and_counted_once_below_it() {
    // this layer is at-least-once; the idempotent consumer (tested against Postgres) makes it once
    let queue = Arc::new(MemoryQueue::new(5));
    let recorder = Arc::new(Recorder::default());
    let body = encode(&[event(1, None)]).expect("encode").remove(0);
    queue.put(&body);
    queue.put(&body);
    let report = consumer(&queue, &recorder).poll_once().await.expect("poll");
    assert_eq!(report.applied, 2);
    assert_eq!(
        recorder.ids().len(),
        2,
        "both handed down; dedupe is the consumer's job"
    );
}

/// Counts receives, and answers at once with nothing: a short poll by mistake.
struct Counting(AtomicU32);
impl Transport for Counting {
    fn send<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async { Ok(()) })
    }
    fn receive(&self, _: Duration, _: u32) -> BoxFuture<'_, Result<Vec<Received>, QueueError>> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { Ok(vec![]) })
    }
    fn delete<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn an_idle_queue_that_answers_at_once_is_not_polled_in_a_busy_loop() {
    let transport = Arc::new(Counting(AtomicU32::new(0)));
    let settings = PollSettings {
        empty_pause: Duration::from_millis(50),
        ..PollSettings::default()
    };
    let c = QueueConsumer::new(transport.clone(), Arc::new(Recorder::default()), settings);
    let (stop, rx) = tokio::sync::watch::channel(false);
    let run = tokio::spawn(async move { c.run(rx).await });
    tokio::time::sleep(Duration::from_millis(520)).await;
    stop.send(true).expect("stop");
    run.await.expect("stopped");
    let polls = transport.0.load(Ordering::Relaxed);
    // one every 50 ms is about ten; a busy loop would be thousands
    assert!(
        (5..=14).contains(&polls),
        "{polls} receives in half a second"
    );
}

/// Fails every receive.
struct Failing(AtomicU32);
impl Transport for Failing {
    fn send<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async { Ok(()) })
    }
    fn receive(&self, _: Duration, _: u32) -> BoxFuture<'_, Result<Vec<Received>, QueueError>> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { Err(QueueError::Request("down".to_owned())) })
    }
    fn delete<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn a_failing_queue_is_retried_with_growing_pauses_not_in_a_loop() {
    let transport = Arc::new(Failing(AtomicU32::new(0)));
    let settings = PollSettings {
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(160),
        ..PollSettings::default()
    };
    let c = QueueConsumer::new(transport.clone(), Arc::new(Recorder::default()), settings);
    let (stop, rx) = tokio::sync::watch::channel(false);
    let run = tokio::spawn(async move { c.run(rx).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    stop.send(true).expect("stop");
    run.await.expect("stopped");
    // pauses of 20, 40, 80, 160, 160 ms: the sixth try is after about 460 ms
    let tries = transport.0.load(Ordering::Relaxed);
    assert!((4..=7).contains(&tries), "{tries} tries in half a second");
}

#[tokio::test]
async fn the_consumer_stops_at_once_even_while_waiting_on_a_slow_queue() {
    struct Hang;
    impl Transport for Hang {
        fn send<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
            Box::pin(async { Ok(()) })
        }
        fn receive(&self, _: Duration, _: u32) -> BoxFuture<'_, Result<Vec<Received>, QueueError>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(vec![])
            })
        }
        fn delete<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>> {
            Box::pin(async { Ok(()) })
        }
    }
    let c = QueueConsumer::new(
        Arc::new(Hang),
        Arc::new(Recorder::default()),
        PollSettings::default(),
    );
    let (stop, rx) = tokio::sync::watch::channel(false);
    let run = tokio::spawn(async move { c.run(rx).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let started = std::time::Instant::now();
    stop.send(true).expect("stop");
    run.await.expect("stopped");
    assert!(started.elapsed() < Duration::from_secs(1));
}
