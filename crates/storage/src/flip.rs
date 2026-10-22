//! Creating a flip: the transaction that makes concurrent forks of one stage safe.
//!
//! Parents are immutable and children only insert, so forks of one stage never contend on the
//! parent's row. What can still go wrong is the rules that look across children: the per-stage
//! fork cap, the parent's permission and hidden state, and the retry key. They are enforced inside
//! one SERIALIZABLE transaction that first takes a transaction-scoped advisory lock keyed on the
//! parent, so forks of the same stage mostly queue instead of aborting each other. The lock does
//! not remove every conflict (the transaction's snapshot is taken before the lock wait ends), so
//! serialization failures are expected, retried a bounded number of times, and reported as a
//! retryable error when they persist. Serializable isolation is what keeps the answer correct
//! either way.

use crate::gate::points;
use crate::postgres::{NewPublication, Store, StoreError, db, insert_publication, insert_record};
use graft_domain::chain::StoredStage;
use graft_domain::ids::PublicationId;
use sqlx::Row;
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
    pub async fn create_flip(&self, flip: &NewFlip) -> Result<FlipOutcome, StoreError> {
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
        let new = &flip.publication;
        let Some(parent) = new.record.parent() else {
            return Err(StoreError::Corrupt("a flip must name a parent".into()));
        };
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(parent.as_str())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        self.gate.reached(points::LOCKED).await;

        // An idempotent replay is answered before any rule is applied: a retry after the parent
        // revoked forking, or after the cap filled, must still return what was already created.
        if let Some(existing) = existing_by_key(&mut tx, &new.retry_key).await? {
            tx.rollback().await.map_err(db)?;
            return self.replay(existing, new).await;
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
            tx.rollback().await.map_err(db)?;
            let existing = self.existing_by_key_outside(&new.retry_key).await?;
            return self.replay(existing, new).await;
        }
        self.gate.reached(points::BEFORE_COMMIT).await;
        tx.commit().await.map_err(db)?;
        let stage = self.publication(&new.id).await?.ok_or_else(|| {
            StoreError::Corrupt("a publication vanished right after it was written".into())
        })?;
        Ok(FlipOutcome::Created(Box::new(stage)))
    }

    async fn existing_by_key_outside(
        &self,
        key: &str,
    ) -> Result<(PublicationId, Vec<u8>), StoreError> {
        let row: (String, Vec<u8>) =
            sqlx::query_as("SELECT id, content_id FROM publications WHERE retry_key = $1")
                .bind(key)
                .fetch_one(&self.pool)
                .await
                .map_err(db)?;
        let id = PublicationId::parse(&row.0).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        Ok((id, row.1))
    }

    async fn replay(
        &self,
        existing: (PublicationId, Vec<u8>),
        new: &NewPublication,
    ) -> Result<FlipOutcome, StoreError> {
        if existing.1 != new.record.id().as_bytes().as_slice() {
            return Ok(FlipOutcome::KeyConflict);
        }
        let stage = self.publication(&existing.0).await?.ok_or_else(|| {
            StoreError::Corrupt("a publication vanished while it was read".into())
        })?;
        Ok(FlipOutcome::Existing(Box::new(stage)))
    }
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
