//! The idempotent consumer: applies delivered events to the hourly rollups.

use crate::sink::{BatchConsumer, SinkError};
use graft_storage::blob::BoxFuture;
use graft_storage::{Store, StoredEvent};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Counters the metrics read.
#[derive(Default)]
pub struct ConsumerStats {
    applied: AtomicU64,
    duplicates: AtomicU64,
}

impl ConsumerStats {
    /// Events counted since the process started.
    #[must_use]
    pub fn applied(&self) -> u64 {
        self.applied.load(Ordering::Relaxed)
    }

    /// Events recognised as already counted and ignored since the process started.
    #[must_use]
    pub fn duplicates(&self) -> u64 {
        self.duplicates.load(Ordering::Relaxed)
    }
}

/// Counts each delivered event once, whatever the delivery order, batching or repeats.
pub struct Consumer {
    store: Store,
    stats: Arc<ConsumerStats>,
}

impl Consumer {
    /// A consumer over `store`.
    #[must_use]
    pub fn new(store: Store) -> Self {
        Self {
            store,
            stats: Arc::new(ConsumerStats::default()),
        }
    }

    /// The counters, shared with whatever reports them.
    #[must_use]
    pub fn stats(&self) -> Arc<ConsumerStats> {
        self.stats.clone()
    }
}

impl BatchConsumer for Consumer {
    fn apply<'a>(&'a self, batch: &'a [StoredEvent]) -> BoxFuture<'a, Result<(), SinkError>> {
        Box::pin(async move {
            let applied = self
                .store
                .apply_events(batch)
                .await
                .map_err(|e| SinkError(e.to_string()))?;
            self.stats
                .applied
                .fetch_add(applied.applied, Ordering::Relaxed);
            self.stats
                .duplicates
                .fetch_add(applied.duplicates, Ordering::Relaxed);
            Ok(())
        })
    }
}
