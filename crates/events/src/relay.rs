//! The relay and the retention job.

use crate::sink::EventSink;
use graft_storage::{Claimed, Store, StoreError};
use std::sync::Arc;
use std::time::Duration;

/// Why a relay pass could not finish.
#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    /// The database failed.
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Delivers unsent events to a sink in bounded batches.
pub struct Relay {
    store: Store,
    sink: Arc<dyn EventSink>,
    batch: u32,
}

impl Relay {
    /// A relay over `store` delivering to `sink`, `batch` events at a time.
    #[must_use]
    pub fn new(store: Store, sink: Arc<dyn EventSink>, batch: u32) -> Self {
        Self {
            store,
            sink,
            batch: batch.max(1),
        }
    }

    /// Claim and deliver one batch. Returns how many events were delivered; 0 when there was
    /// nothing to claim or the sink refused (the rows stay unsent and the next pass retries them).
    pub async fn run_once(&self) -> Result<usize, RelayError> {
        use tracing::Instrument;
        self.run_once_inner()
            .instrument(tracing::info_span!("relay.batch"))
            .await
    }

    async fn run_once_inner(&self) -> Result<usize, RelayError> {
        let sink = self.sink.clone();
        let claimed = self
            .store
            .relay_batch(self.batch, move |batch| {
                Box::pin(async move { sink.deliver(batch).await })
            })
            .await?;
        Ok(match claimed {
            Claimed::Nothing => 0,
            Claimed::Delivered(n) => n,
            Claimed::Failed(error) => {
                tracing::warn!(%error, "the sink refused a batch; its events stay unsent");
                0
            }
        })
    }

    /// Deliver until a pass finds nothing to deliver. Returns the total.
    pub async fn drain(&self) -> Result<usize, RelayError> {
        let mut total = 0;
        loop {
            let n = self.run_once().await?;
            if n == 0 {
                return Ok(total);
            }
            total += n;
        }
    }

    /// Run passes every `interval` until `stop` resolves.
    pub async fn run(&self, interval: Duration, mut stop: tokio::sync::watch::Receiver<bool>) {
        loop {
            if let Err(error) = self.drain().await {
                tracing::error!(%error, "a relay pass failed");
            }
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                _ = stop.changed() => return,
            }
        }
    }
}

/// Deletes raw events past the retention window. It deletes only events already sent, and skips
/// any a relay is working on, so it is safe to run alongside the relay and can never discard an
/// event that was not delivered.
pub struct Retention {
    store: Store,
    days: u32,
}

impl Retention {
    /// Keep raw events for `days`.
    #[must_use]
    pub fn new(store: Store, days: u32) -> Self {
        Self { store, days }
    }

    /// Delete one bounded batch of events older than the window as of `now_ms`. Returns how many.
    pub async fn run_once(&self, now_ms: i64, limit: u32) -> Result<u64, RelayError> {
        let cutoff = now_ms - i64::from(self.days) * 86_400_000;
        Ok(self.store.delete_old_sent_events(cutoff, limit).await?)
    }

    /// Delete until nothing old and sent is left.
    pub async fn drain(&self, now_ms: i64) -> Result<u64, RelayError> {
        let mut total = 0;
        loop {
            let n = self.run_once(now_ms, 1000).await?;
            if n == 0 {
                return Ok(total);
            }
            total += n;
        }
    }
}
