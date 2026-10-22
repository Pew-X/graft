//! Creating a flip: the transaction that makes concurrent forks of one stage safe.
//!
//! Parents are immutable and children only insert, so forks of one stage never contend on the
//! parent's row. What can still go wrong is the rules that look across children: the per-stage
//! fork cap, the parent's permission and hidden state, and the retry key. They are enforced inside
//! one SERIALIZABLE transaction, which keeps the answer correct whatever the interleaving.
//!
//! To make forks of the same stage queue instead of aborting each other, a lock keyed on the
//! parent is taken *before* the transaction begins. It has to be a session-level advisory lock on
//! the same connection: a transaction-scoped lock taken inside a serializable transaction is
//! acquired after the transaction's snapshot, so every waiter would read stale data and be
//! aborted (measured: 24 concurrent forks took 65 attempts that way). Everything in the critical
//! section uses that one connection, because a holder that needed a second connection from a full
//! pool of waiters would deadlock. The write runs in its own task so a dropped request cannot
//! leave the lock held, and the lock is always released, with the connection discarded if
//! releasing it fails.
//!
//! Serialization failures can still happen (a concurrent hide, a replayed key); they are retried a
//! bounded number of times and surfaced as a retryable error if they persist.

use crate::gate::points;
use crate::lock::Locked;
use crate::postgres::{
    NewPublication, Store, StoreError, db, fetch_stage, insert_publication, insert_record,
};
use graft_domain::chain::StoredStage;
use graft_domain::ids::PublicationId;
use sqlx::{Connection, PgConnection, Row};
use std::time::Duration;

/// A flip to create.
#[derive(Debug, Clone)]
pub struct NewFlip {
    /// The publication to write. Its record must be a flip; `manage_key_hash` must be set.
    pub publication: NewPublication,
    /// Most publications that may name one parent as their parent within an hour.
    pub max_forks_per_stage_per_hour: u32,
    /// How many times a conflicted transaction is retried before the error is surfaced.
    pub serialization_retries: u32,
    /// How long to wait for the lock on the parent before giving up with [`StoreError::Busy`].
    pub lock_wait: Duration,
}

/// Why a flip was refused. Nothing was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The parent publication does not exist.
    ParentMissing,
    /// The parent's maker has revoked forking.
    ForkNotPermitted,
    /// The parent is hidden.
    ParentHidden,
    /// The parent already has the most forks it may have this hour.
    ForkCapReached {
        /// The configured limit.
        limit: u32,
    },
}

/// What creating a flip did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlipOutcome {
    /// A new publication was written.
    Created(Box<StoredStage>),
    /// The retry key already belongs to a publication of the same content; nothing was written.
    Existing(Box<StoredStage>),
    /// The retry key belongs to a publication of different content; nothing was written.
    KeyConflict,
    /// A rule refused the flip; nothing was written.
    Refused(Refusal),
}

impl Store {
    /// Create a flip, idempotently by retry key, enforcing the rules that look across children.
    ///
    /// The work runs in its own task, so dropping the returned future does not abandon a
    /// transaction half way.
    pub async fn create_flip(&self, flip: &NewFlip) -> Result<FlipOutcome, StoreError> {
        let store = self.clone();
        let flip = flip.clone();
        tokio::spawn(async move { store.create_flip_with_retries(&flip).await })
            .await
            .map_err(|_| StoreError::Db("the write task failed".into()))?
    }

    async fn create_flip_with_retries(&self, flip: &NewFlip) -> Result<FlipOutcome, StoreError> {
        let mut attempt = 0;
        loop {
            match self.try_create_flip(flip).await {
                Err(StoreError::Serialization) if attempt < flip.serialization_retries => {
                    attempt += 1;
                    // A short, growing pause so retrying work does not all collide again.
                    tokio::time::sleep(Duration::from_millis(5 * u64::from(attempt))).await;
                }
                Err(StoreError::Serialization) => return Err(StoreError::RetryExhausted),
                other => return other,
            }
        }
    }

    async fn try_create_flip(&self, flip: &NewFlip) -> Result<FlipOutcome, StoreError> {
        let Some(parent) = flip.publication.record.parent() else {
            return Err(StoreError::Corrupt("a flip must name a parent".into()));
        };
        let mut locked = Locked::acquire(&self.pool, parent, flip.lock_wait).await?;
        self.gate.reached(points::LOCKED).await;
        let outcome = self.flip_in_transaction(locked.connection()?, flip).await;
        locked.release(parent).await;
        outcome
    }

    async fn flip_in_transaction(
        &self,
        conn: &mut PgConnection,
        flip: &NewFlip,
    ) -> Result<FlipOutcome, StoreError> {
        let new = &flip.publication;
        let Some(parent) = new.record.parent() else {
            return Err(StoreError::Corrupt("a flip must name a parent".into()));
        };
        let mut tx = conn.begin().await.map_err(db)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *tx)
            .await
            .map_err(db)?;

        // An idempotent replay is answered before any rule is applied: a retry after the parent
        // revoked forking, or after the cap filled, must still return what was already created.
        if let Some(existing) = existing_by_key(&mut tx, &new.retry_key).await? {
            let outcome = replay(&mut tx, existing, new).await;
            tx.rollback().await.map_err(db)?;
            return outcome;
        }
        let row =
            sqlx::query("SELECT fork_permitted, hidden_reason FROM publications WHERE id = $1")
                .bind(parent.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        let Some(row) = row else {
            return refuse(tx, Refusal::ParentMissing).await;
        };
        if row
            .try_get::<Option<String>, _>("hidden_reason")
            .map_err(db)?
            .is_some()
        {
            return refuse(tx, Refusal::ParentHidden).await;
        }
        if !row.try_get::<bool, _>("fork_permitted").map_err(db)? {
            return refuse(tx, Refusal::ForkNotPermitted).await;
        }
        let recent: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM content_records c JOIN publications p ON p.content_id = c.id \
             WHERE c.parent_publication_id = $1 AND p.created_at > now() - interval '1 hour'",
        )
        .bind(parent.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if recent >= i64::from(flip.max_forks_per_stage_per_hour) {
            let limit = flip.max_forks_per_stage_per_hour;
            return refuse(tx, Refusal::ForkCapReached { limit }).await;
        }
        self.gate.reached(points::CHECKED).await;

        insert_record(&mut tx, &new.record).await?;
        if !insert_publication(&mut tx, new).await? {
            // The key was taken between the check and the insert; answer as a replay.
            let existing = existing_by_key(&mut tx, &new.retry_key)
                .await?
                .ok_or_else(|| StoreError::Corrupt("a conflicting key vanished".into()))?;
            let outcome = replay(&mut tx, existing, new).await;
            tx.rollback().await.map_err(db)?;
            return outcome;
        }
        // The event commits with the publication or not at all.
        crate::events::append(&mut tx, &created_event(new)).await?;
        self.gate.reached(points::BEFORE_COMMIT).await;
        tx.commit().await.map_err(db)?;
        // Read on the same connection, still under the lock: asking the pool for another
        // connection here could wait behind the very requests that are waiting for this lock.
        let stage = fetch_stage(&mut *conn, &new.id).await?.ok_or_else(|| {
            StoreError::Corrupt("a publication vanished right after it was written".into())
        })?;
        Ok(FlipOutcome::Created(Box::new(stage)))
    }
}

/// The event that records a publication, written in the transaction that creates it.
pub(crate) fn created_event(new: &NewPublication) -> crate::events::NewEvent {
    let kind = if new.record.parent().is_some() {
        "flip"
    } else {
        "source"
    };
    crate::events::NewEvent::server(
        crate::events::EventKind::PublicationCreated,
        new.id.as_str(),
        kind,
    )
}

async fn replay(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    existing: (PublicationId, Vec<u8>),
    new: &NewPublication,
) -> Result<FlipOutcome, StoreError> {
    if existing.1 != new.record.id().as_bytes().as_slice() {
        return Ok(FlipOutcome::KeyConflict);
    }
    let stage = fetch_stage(&mut **tx, &existing.0)
        .await?
        .ok_or_else(|| StoreError::Corrupt("a publication vanished while it was read".into()))?;
    Ok(FlipOutcome::Existing(Box::new(stage)))
}

async fn existing_by_key(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    key: &str,
) -> Result<Option<(PublicationId, Vec<u8>)>, StoreError> {
    let row: Option<(String, Vec<u8>)> =
        sqlx::query_as("SELECT id, content_id FROM publications WHERE retry_key = $1")
            .bind(key)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?;
    row.map(|(id, content)| {
        PublicationId::parse(&id)
            .map(|id| (id, content))
            .map_err(|e| StoreError::Corrupt(e.to_string()))
    })
    .transpose()
}

async fn refuse(
    tx: sqlx::Transaction<'_, sqlx::Postgres>,
    why: Refusal,
) -> Result<FlipOutcome, StoreError> {
    tx.rollback().await.map_err(db)?;
    Ok(FlipOutcome::Refused(why))
}
