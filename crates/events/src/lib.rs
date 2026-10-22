//! Outbox writer, relay, consumer and rollups behind an event-sink trait.
//!
//! Only the seam exists so far: writes call a sink, and the default sink does nothing. The ledger,
//! relay and idempotent consumer arrive with their own tickets.

/// Where events go. Tests and local runs use the Postgres-only sink; the deployed environment adds
/// the queue leg.
pub trait EventSink: Send + Sync {
    /// Record that something happened. Must not fail the write that caused it.
    fn record(&self, event: &Event);
}

/// The five events the service knows, named in graft vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A publication was created (server event, transactional once the ledger exists).
    PublicationCreated,
}

/// A sink that discards everything: the default until the ledger exists.
pub struct NoopSink;

impl EventSink for NoopSink {
    fn record(&self, _event: &Event) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_noop_sink_accepts_events_without_effect() {
        let sink: &dyn EventSink = &NoopSink;
        sink.record(&Event::PublicationCreated);
    }
}
