//! Changes to a stage that its maker (and, later, the operator) may make: closing or reopening it
//! to new flips, and withdrawing it. Every one of them acquires the same lock on the stage as
//! creating a flip, so it serialises with the forks in flight: a fork that read the old flags
//! cannot commit after the change, and every fork after the change sees it.

use crate::lock::Locked;
use crate::postgres::{Store, StoreError, db};
use graft_domain::chain::HideReason;
use graft_domain::ids::PublicationId;
use sqlx::Row;
use std::time::Duration;

/// The flags of a stage after a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageFlags {
    /// The maker allows new flips.
    pub fork_permitted: bool,
    /// Set when the stage is hidden, and why.
    pub hidden: Option<HideReason>,
}

/// What setting a note did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteChange {
    /// The note was set, changed or cleared.
    Set,
    /// The publication is hidden (withdrawn, or held for rights): its note is left as it was.
    Hidden,
}

impl Store {
    /// SHA-256 of the manage key of a publication; `None` if it does not exist or has no key (a
    /// seeded source has none, so nobody can manage it).
    pub async fn manage_key_hash(
        &self,
        id: &PublicationId,
    ) -> Result<Option<[u8; 32]>, StoreError> {
        let bytes: Option<Option<Vec<u8>>> =
            sqlx::query_scalar("SELECT manage_key_hash FROM publications WHERE id = $1")
                .bind(id.as_str())
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?;
        match bytes.flatten() {
            None => Ok(None),
            Some(b) => b
                .try_into()
                .map(Some)
                .map_err(|_| StoreError::Corrupt("a manage key hash is not 32 bytes".into())),
        }
    }

    /// Close (`false`) or reopen (`true`) a stage to new flips. Existing flips are untouched.
    /// Idempotent: setting the state it already has changes nothing.
    pub async fn set_fork_permission(
        &self,
        id: &PublicationId,
        permitted: bool,
        wait: Duration,
    ) -> Result<StageFlags, StoreError> {
        self.change_flags(id, wait, Change::Permission(id.clone(), permitted))
            .await
    }

    /// Withdraw a stage: it stays in every chain as "no longer here" and its audio is no longer
    /// served, and stages built on it stay playable. A stage the operator hid for rights stays
    /// hidden for rights. Idempotent.
    pub async fn withdraw(
        &self,
        id: &PublicationId,
        wait: Duration,
    ) -> Result<StageFlags, StoreError> {
        self.change_flags(id, wait, Change::Withdraw(id.clone()))
            .await
    }

    /// Hide a stage for `reason`, or clear its hide (`None`). The operator's decision: it replaces
    /// whatever hide was there, including a maker's withdrawal, and it is reversible. Idempotent.
    pub async fn set_hidden(
        &self,
        id: &PublicationId,
        reason: Option<HideReason>,
        wait: Duration,
    ) -> Result<StageFlags, StoreError> {
        self.change_flags(id, wait, Change::Hide(id.clone(), reason))
            .await
    }

    /// Set the maker's note on a publication, or clear it with `None`. A hidden publication keeps the
    /// note it had. Takes the same lock as the flag changes, so a withdrawal and a note edit cannot
    /// interleave. Writing the text it already has changes nothing, not even the time.
    pub async fn set_note(
        &self,
        id: &PublicationId,
        note: Option<String>,
        wait: Duration,
    ) -> Result<NoteChange, StoreError> {
        let store = self.clone();
        let id = id.clone();
        tokio::spawn(async move { store.apply_note(&id, note, wait).await })
            .await
            .map_err(|_| StoreError::Db("the write task failed".into()))?
    }

    async fn apply_note(
        &self,
        id: &PublicationId,
        note: Option<String>,
        wait: Duration,
    ) -> Result<NoteChange, StoreError> {
        let mut locked = Locked::acquire(&self.pool, id, wait).await?;
        let result = async {
            let conn = locked.connection()?;
            let row = sqlx::query("SELECT hidden_reason, note FROM publications WHERE id = $1")
                .bind(id.as_str())
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?
                .ok_or(StoreError::NotFound)?;
            if row
                .try_get::<Option<String>, _>("hidden_reason")
                .map_err(db)?
                .is_some()
            {
                return Ok(NoteChange::Hidden);
            }
            let was: Option<String> = row.try_get("note").map_err(db)?;
            if was != note {
                sqlx::query(
                    "UPDATE publications SET note = $2, note_updated_at = now() WHERE id = $1",
                )
                .bind(id.as_str())
                .bind(note.as_deref())
                .execute(&mut *conn)
                .await
                .map_err(db)?;
            }
            Ok(NoteChange::Set)
        }
        .await;
        locked.release(id).await;
        result
    }

    async fn change_flags(
        &self,
        id: &PublicationId,
        wait: Duration,
        change: Change,
    ) -> Result<StageFlags, StoreError> {
        let store = self.clone();
        let id = id.clone();
        // Its own task, so a dropped request cannot abandon the change while the lock is held.
        tokio::spawn(async move { store.apply(change, &id, wait).await })
            .await
            .map_err(|_| StoreError::Db("the write task failed".into()))?
    }

    async fn apply(
        &self,
        change: Change,
        id: &PublicationId,
        wait: Duration,
    ) -> Result<StageFlags, StoreError> {
        let mut locked = Locked::acquire(&self.pool, id, wait).await?;
        let result = async {
            let conn = locked.connection()?;
            match &change {
                Change::Permission(id, permitted) => {
                    sqlx::query("UPDATE publications SET fork_permitted = $2 WHERE id = $1")
                        .bind(id.as_str())
                        .bind(permitted)
                        .execute(&mut *conn)
                        .await
                        .map_err(db)?;
                }
                Change::Hide(id, reason) => {
                    sqlx::query("UPDATE publications SET hidden_reason = $2 WHERE id = $1")
                        .bind(id.as_str())
                        .bind(reason.map(HideReason::as_str))
                        .execute(&mut *conn)
                        .await
                        .map_err(db)?;
                }
                Change::Withdraw(id) => {
                    sqlx::query(
                        "UPDATE publications SET hidden_reason = 'withdrawn' \
                         WHERE id = $1 AND hidden_reason IS NULL",
                    )
                    .bind(id.as_str())
                    .execute(&mut *conn)
                    .await
                    .map_err(db)?;
                }
            }
            let row =
                sqlx::query("SELECT fork_permitted, hidden_reason FROM publications WHERE id = $1")
                    .bind(id.as_str())
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(db)?
                    .ok_or(StoreError::NotFound)?;
            Ok(StageFlags {
                fork_permitted: row.try_get("fork_permitted").map_err(db)?,
                hidden: match row
                    .try_get::<Option<String>, _>("hidden_reason")
                    .map_err(db)?
                {
                    None => None,
                    Some(text) => Some(HideReason::parse(&text).ok_or_else(|| {
                        StoreError::Corrupt(format!("unknown hide reason {text}"))
                    })?),
                },
            })
        }
        .await;
        locked.release(id).await;
        result
    }
}

enum Change {
    Permission(PublicationId, bool),
    Hide(PublicationId, Option<HideReason>),
    Withdraw(PublicationId),
}
