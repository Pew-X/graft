//! Where delivered events go. The deployed environment adds a queue; tests and local runs use the
//! Postgres-only sink, which hands each batch to the consumer in the same process.

use graft_storage::StoredEvent;
use graft_storage::blob::BoxFuture;
use std::sync::Mutex;

/// A delivery that did not complete. The relay leaves the batch unsent and tries it again.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("delivery failed: {0}")]
pub struct SinkError(pub String);

/// Where the relay sends a claimed batch. Returning `Ok` is the acknowledgement: the rows are
/// marked sent. Anything else leaves them unsent.
pub trait EventSink: Send + Sync {
    /// Deliver one batch.
    fn deliver<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>>;
}

/// Applies delivered events: the idempotent consumer implements this.
pub trait BatchConsumer: Send + Sync {
    /// Apply one batch. Must be idempotent on the event id.
    fn apply<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>>;
}

/// A consumer shared between the relay's sink and a queue reader applies the same way.
impl<T: BatchConsumer + ?Sized> BatchConsumer for std::sync::Arc<T> {
    fn apply<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        (**self).apply(batch)
    }
}

/// The Postgres-only sink: the batch goes straight to a consumer in the same process, with no
/// queue between them. It is the default for tests and local runs; a queue-backed sink replaces it
/// where one is deployed, and the consumer is the same either way.
pub struct ConsumerSink<C>(pub C);

impl<C: BatchConsumer> EventSink for ConsumerSink<C> {
    fn deliver<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        self.0.apply(batch)
    }
}

/// A sink that records what it was given, for tests. Repeats are kept: at-least-once delivery can
/// deliver a row twice and the record shows it.
#[derive(Default)]
pub struct MemorySink {
    delivered: Mutex<Vec<StoredEvent>>,
    fail_next: Mutex<u32>,
}

impl MemorySink {
    /// Fail the next `n` deliveries, so a test can watch the relay leave rows unsent.
    pub fn fail_next(&self, n: u32) {
        if let Ok(mut f) = self.fail_next.lock() {
            *f = n;
        }
    }

    /// Everything delivered so far, in delivery order, repeats included.
    #[must_use]
    pub fn delivered(&self) -> Vec<StoredEvent> {
        self.delivered.lock().map(|d| d.clone()).unwrap_or_default()
    }
}

impl EventSink for MemorySink {
    fn deliver<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        Box::pin(async move {
            if let Ok(mut f) = self.fail_next.lock()
                && *f > 0
            {
                *f -= 1;
                return Err(SinkError("told to fail".to_owned()));
            }
            if let Ok(mut d) = self.delivered.lock() {
                d.extend_from_slice(batch);
            }
            Ok(())
        })
    }
}
