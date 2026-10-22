//! The event path after the ledger: the sink trait, the relay that delivers claimed rows to a
//! sink, and the retention job. The ledger itself and its SQL live in `graft-storage`; this crate
//! decides what to do with a claimed batch.
//!
//! Delivery is at least once. A sink must treat a repeated event id as a repeat.

mod relay;
mod sink;

pub use relay::{Relay, RelayError, Retention};
pub use sink::{BatchConsumer, ConsumerSink, EventSink, MemorySink, SinkError};
