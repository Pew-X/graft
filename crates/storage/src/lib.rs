//! Postgres and blob store access behind traits.

pub mod blob;
pub mod events;
pub mod flip;
pub mod gate;
pub mod guardrails;
mod lock;
pub mod maker;
pub mod orphans;
pub mod postgres;
pub mod reports;
pub mod rollups;
pub mod s3;
#[cfg(feature = "test-support")]
pub mod testing;

pub use blob::{BlobError, BlobInfo, BlobStore, FsBlobStore, MemoryBlobStore};
pub use events::{Backlog, Claimed, EventKind, NewEvent, Origin, StoredEvent};
pub use flip::{FlipOutcome, NewFlip, Refusal};
pub use gate::{Gate, NoGate};
pub use guardrails::PublishToken;
pub use maker::StageFlags;
pub use orphans::{CleanupError, CleanupReport, remove_orphans};
pub use postgres::{ForkFlags, NewPublication, Outcome, Store, StoreError};
pub use reports::{ReportCategory, ReportRow};
pub use rollups::{Applied, Lag, Rebuilt, RollupRow};
pub use s3::{S3BlobStore, S3Config};
