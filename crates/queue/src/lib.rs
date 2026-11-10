//! The queue leg of the event path. The relay already delivers claimed ledger rows to an
//! [`EventSink`](graft_events::EventSink); here a sink sends each batch to a queue, and a consumer
//! long-polls the queue and hands what it receives to the same idempotent consumer the Postgres-only
//! path uses. The ledger stays the source of truth: the queue only carries.
//!
//! What this buys, plainly: a message that cannot be applied is set aside after a few tries instead of
//! blocking everything behind it, and another consumer can be added later without touching the code that
//! writes events. It is off unless a queue address is configured.

mod consumer;
mod envelope;
mod memory;
mod sink;
mod sqs;
mod transport;

pub use consumer::{PollReport, PollSettings, QueueConsumer};
pub use envelope::{EnvelopeError, MAX_MESSAGE_BYTES, VERSION, decode, encode};
pub use memory::MemoryQueue;
pub use sink::QueueSink;
pub use sqs::SqsTransport;
pub use transport::{QueueError, Received, Transport};
