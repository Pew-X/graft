//! The sink that sends each relay batch to the queue.

use crate::envelope::encode;
use crate::transport::{QueueError, Transport};
use graft_events::{EventSink, SinkError};
use graft_storage::StoredEvent;
use graft_storage::blob::BoxFuture;
use std::sync::Arc;
use std::time::Duration;

/// Sends a batch to the queue. The relay holds the claim on the rows (and a database connection)
/// while this runs, so the send has a hard time limit; a batch that is not sent in time is left
/// unsent and tried again, which is safe because the consumer counts each event once.
pub struct QueueSink {
    transport: Arc<dyn Transport>,
    limit: Duration,
}

impl QueueSink {
    /// A sink over `transport` that gives each send `limit` to finish.
    #[must_use]
    pub fn new(transport: Arc<dyn Transport>, limit: Duration) -> Self {
        Self { transport, limit }
    }

    async fn send(&self, batch: &[StoredEvent]) -> Result<(), QueueError> {
        let bodies = encode(batch)?;
        if bodies.is_empty() {
            return Ok(());
        }
        tokio::time::timeout(self.limit, self.transport.send(&bodies))
            .await
            .map_err(|_| QueueError::Timeout)?
    }
}

impl EventSink for QueueSink {
    fn deliver<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        Box::pin(async move { self.send(batch).await.map_err(|e| SinkError(e.to_string())) })
    }
}
