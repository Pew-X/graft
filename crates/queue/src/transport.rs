//! What the sink and the consumer need from a queue, and nothing more.

use crate::envelope::EnvelopeError;
use graft_storage::blob::BoxFuture;
use std::time::Duration;

/// A queue request that did not complete.
#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    /// The queue refused or failed a request.
    #[error("the queue failed: {0}")]
    Request(String),
    /// The queue did not answer within the time allowed.
    #[error("the queue did not answer in time")]
    Timeout,
    /// A batch could not be put in messages.
    #[error(transparent)]
    Envelope(#[from] EnvelopeError),
}

/// One message received from the queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Received {
    /// What deleting it needs. A new one is issued each time the message is received.
    pub receipt: String,
    /// The message body.
    pub body: String,
    /// How many times the queue has handed this message out, this time included.
    pub receive_count: u32,
}

/// A queue with at-least-once delivery: a message that is received and not deleted comes back, and
/// after enough receives the queue sets it aside (its dead-letter queue), which is configured on the
/// queue and not here.
pub trait Transport: Send + Sync {
    /// Send every body, or fail. A failure may leave some of them sent: sending them again is safe
    /// because the consumer counts each event once.
    fn send<'a>(&'a self, bodies: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>>;

    /// Wait up to `wait` for messages and return up to `max` of them. An empty answer is normal.
    fn receive(&self, wait: Duration, max: u32)
    -> BoxFuture<'_, Result<Vec<Received>, QueueError>>;

    /// Delete messages by receipt once they have been applied.
    fn delete<'a>(&'a self, receipts: &'a [String]) -> BoxFuture<'a, Result<(), QueueError>>;
}
