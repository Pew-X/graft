#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The real SDK against a real queue service (an emulator, so no AWS account is touched): sends are
//! received, a receive waits (a long poll, not a busy loop), a message that is received and never
//! deleted comes back and then lands in the dead-letter queue, and what is applied is deleted.
//!
//! These tests are ignored in a plain `cargo test`; they run when an emulator is up:
//!   GRAFT_TEST_SQS_ENDPOINT=http://127.0.0.1:59324 AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x \
//!   AWS_REGION=us-east-1 cargo test -p graft-queue --test emulator -- --ignored
//! An ignored test that finds no emulator fails, so a CI job that forgot to start one cannot pass.

use aws_sdk_sqs::Client;
use aws_sdk_sqs::types::QueueAttributeName;
use graft_events::{BatchConsumer, EventSink, SinkError};
use graft_queue::{PollSettings, QueueConsumer, QueueSink, SqsTransport, Transport};
use graft_storage::blob::BoxFuture;
use graft_storage::{EventKind, Origin, StoredEvent};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn endpoint() -> String {
    std::env::var("GRAFT_TEST_SQS_ENDPOINT")
        .expect("GRAFT_TEST_SQS_ENDPOINT must name an SQS emulator (see the file's header)")
}

fn event(n: i64) -> StoredEvent {
    StoredEvent {
        seq: n,
        event_id: format!("event-id-for-test-{n:06}"),
        kind: EventKind::RollOpened,
        origin: Origin::Client,
        session_id: Some("session-0001".to_owned()),
        occurred_at_ms: 1_800_000_000_000 + n,
        hour_ms: 1_800_000_000_000,
        publication_id: Some("pub-1".to_owned()),
        detail: None,
    }
}

#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);
impl BatchConsumer for Recorder {
    fn apply<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        Box::pin(async move {
            self.0
                .lock()
                .expect("lock")
                .extend(batch.iter().map(|e| e.event_id.clone()));
            Ok(())
        })
    }
}

struct Queues {
    client: Client,
    url: String,
    dead_url: String,
}

/// A queue with a dead-letter queue behind it (three receives), as the module makes in AWS, with a
/// one-second visibility timeout so a test does not wait long.
async fn make_queues() -> Queues {
    let endpoint = endpoint();
    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .endpoint_url(&endpoint)
        .load()
        .await;
    let client = Client::new(&config);
    let tag = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    );
    let dead = client
        .create_queue()
        .queue_name(format!("graft-test-dead-{tag}"))
        .send()
        .await
        .expect("create dead-letter queue");
    let dead_url = dead.queue_url().expect("url").to_owned();
    let arn = client
        .get_queue_attributes()
        .queue_url(&dead_url)
        .attribute_names(QueueAttributeName::QueueArn)
        .send()
        .await
        .expect("attributes")
        .attributes()
        .and_then(|a| a.get(&QueueAttributeName::QueueArn))
        .cloned()
        .expect("arn");
    let redrive = format!(r#"{{"deadLetterTargetArn":"{arn}","maxReceiveCount":"3"}}"#);
    let main = client
        .create_queue()
        .queue_name(format!("graft-test-events-{tag}"))
        .set_attributes(Some(HashMap::from([
            (QueueAttributeName::RedrivePolicy, redrive),
            (QueueAttributeName::VisibilityTimeout, "1".to_owned()),
        ])))
        .send()
        .await
        .expect("create queue");
    // the emulator reports its own host name in the address; the test reaches it where it was told to
    let reachable = |u: &str| {
        format!(
            "{}/{}",
            endpoint.trim_end_matches('/'),
            u.rsplit('/')
                .take(2)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("/")
        )
    };
    Queues {
        client,
        url: reachable(main.queue_url().expect("url")),
        dead_url: reachable(&dead_url),
    }
}

#[tokio::test]
#[ignore = "needs an SQS emulator: see the file's header"]
async fn events_go_through_a_real_queue_and_are_applied_then_deleted() {
    let q = make_queues().await;
    let transport = Arc::new(SqsTransport::connect(&q.url, Some(&endpoint())).await);
    let sink = QueueSink::new(transport.clone(), Duration::from_secs(10));
    let batch: Vec<StoredEvent> = (0..25).map(event).collect();
    sink.deliver(&batch).await.expect("sent");

    let recorder = Arc::new(Recorder::default());
    let settings = PollSettings {
        wait: Duration::from_secs(1),
        ..PollSettings::default()
    };
    let consumer = QueueConsumer::new(transport.clone(), recorder.clone(), settings);
    let report = consumer.poll_once().await.expect("poll");
    assert_eq!(report.applied, report.received);
    assert_eq!(
        recorder.0.lock().expect("lock").len(),
        25,
        "all 25 events, once"
    );

    // deleted: after the visibility timeout nothing comes back
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let again = consumer.poll_once().await.expect("poll");
    assert_eq!(
        again.received, 0,
        "applied messages were deleted, not left to return"
    );
}

#[tokio::test]
#[ignore = "needs an SQS emulator: see the file's header"]
async fn a_receive_waits_on_an_empty_queue_instead_of_answering_at_once() {
    let q = make_queues().await;
    let transport = SqsTransport::connect(&q.url, Some(&endpoint())).await;
    let started = Instant::now();
    let got = transport
        .receive(Duration::from_secs(2), 10)
        .await
        .expect("receive");
    assert!(got.is_empty());
    assert!(
        started.elapsed() >= Duration::from_millis(1_500),
        "a long poll waits; this answered in {:?}",
        started.elapsed()
    );
}

#[tokio::test]
#[ignore = "needs an SQS emulator: see the file's header"]
async fn a_message_nobody_can_read_is_received_three_times_and_then_set_aside() {
    let q = make_queues().await;
    let transport = Arc::new(SqsTransport::connect(&q.url, Some(&endpoint())).await);
    transport
        .send(&["this is not an event message".to_owned()])
        .await
        .expect("sent");
    let recorder = Arc::new(Recorder::default());
    let settings = PollSettings {
        wait: Duration::from_secs(1),
        ..PollSettings::default()
    };
    let consumer = QueueConsumer::new(transport.clone(), recorder.clone(), settings);
    let mut counts = Vec::new();
    for _ in 0..3 {
        let got = transport
            .receive(Duration::from_secs(2), 1)
            .await
            .expect("receive");
        assert_eq!(got.len(), 1, "it comes back each time it is not deleted");
        counts.push(got[0].receive_count);
        tokio::time::sleep(Duration::from_millis(1_300)).await; // the visibility timeout
    }
    assert_eq!(counts, vec![1, 2, 3], "the queue counts the receives");
    // the consumer, given the same message, leaves it too and reports it unreadable
    let report = consumer.poll_once().await.expect("poll");
    assert_eq!(report.applied, 0);
    // and the queue has set it aside: the main queue is empty, the dead-letter queue holds it
    tokio::time::sleep(Duration::from_millis(1_300)).await;
    let main = transport
        .receive(Duration::from_secs(1), 1)
        .await
        .expect("receive");
    assert!(main.is_empty(), "nothing left to block the queue");
    let dead = q
        .client
        .receive_message()
        .queue_url(&q.dead_url)
        .wait_time_seconds(2)
        .send()
        .await
        .expect("receive from the dead-letter queue");
    assert_eq!(dead.messages().len(), 1);
    assert_eq!(
        dead.messages()[0].body(),
        Some("this is not an event message")
    );
    assert!(recorder.0.lock().expect("lock").is_empty());
}
