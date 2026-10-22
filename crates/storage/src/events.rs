//! The events ledger: how events are written, claimed for delivery and deleted when old.
//!
//! Server events (a publication was created, a report was filed) are written in the same
//! transaction as the write they describe, so there is no write without its event and no event
//! without its write. Client events are inserted by the guarded ingest path. Both land in one
//! append-only table whose rows carry a relay state.
//!
//! The relay claims unsent rows with row locks that skip locked rows. It never remembers "the last
//! id it saw": a transaction that took a lower id can commit after a higher id was already
//! delivered, so a cursor on the id sequence would skip that row for good. A claimed row that is
//! not acknowledged stays unsent, which is what makes delivery at-least-once.

use crate::blob::BoxFuture;
use crate::postgres::{Store, StoreError, db};
use sqlx::{PgConnection, Row};

/// The five events, named in graft vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EventKind {
    /// A publication was created (server). `detail` is `source` or `flip`.
    PublicationCreated,
    /// A report was filed (server). `detail` is the category.
    ReportFiled,
    /// The roll was opened (client).
    RollOpened,
    /// A stage was played (client).
    StagePlayed,
    /// A flip was started (client).
    FlipStarted,
}

impl EventKind {
    /// Every kind, in a fixed order.
    pub const ALL: [Self; 5] = [
        Self::PublicationCreated,
        Self::ReportFiled,
        Self::RollOpened,
        Self::StagePlayed,
        Self::FlipStarted,
    ];

    /// The name used in the database and on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PublicationCreated => "publication_created",
            Self::ReportFiled => "report_filed",
            Self::RollOpened => "roll_opened",
            Self::StagePlayed => "stage_played",
            Self::FlipStarted => "flip_started",
        }
    }

    /// Parse a name; `None` for anything not in the set.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == text)
    }

    /// Where events of this kind come from.
    #[must_use]
    pub fn origin(self) -> Origin {
        match self {
            Self::PublicationCreated | Self::ReportFiled => Origin::Server,
            Self::RollOpened | Self::StagePlayed | Self::FlipStarted => Origin::Client,
        }
    }
}

/// Where an event was written from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Origin {
    /// In the transaction of the write it describes.
    Server,
    /// Submitted by the browser: a best-effort count.
    Client,
}

impl Origin {
    /// The name used in the database.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Client => "client",
        }
    }
}

/// An event to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEvent {
    /// The dedupe key: a client-generated id for client events; `None` lets the database choose
    /// one, which is what server events do.
    pub event_id: Option<String>,
    /// What happened.
    pub kind: EventKind,
    /// The browser's per-page-load session id; only for client events.
    pub session_id: Option<String>,
    /// When it happened, in milliseconds since the Unix epoch; `None` is now.
    pub occurred_at_ms: Option<i64>,
    /// The publication or stage it is about.
    pub publication_id: Option<String>,
    /// A short qualifier: the kind of a created publication, the category of a report.
    pub detail: Option<String>,
}

impl NewEvent {
    /// A server event about a publication.
    #[must_use]
    pub fn server(kind: EventKind, publication_id: &str, detail: &str) -> Self {
        Self {
            event_id: None,
            kind,
            session_id: None,
            occurred_at_ms: None,
            publication_id: Some(publication_id.to_owned()),
            detail: Some(detail.to_owned()),
        }
    }
}

/// An event as the ledger holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    /// The ledger position. A scan order, never a delivery cursor.
    pub seq: i64,
    /// The dedupe key.
    pub event_id: String,
    /// What happened.
    pub kind: EventKind,
    /// Where it was written from.
    pub origin: Origin,
    /// The session id, for client events.
    pub session_id: Option<String>,
    /// When it happened, milliseconds since the Unix epoch.
    pub occurred_at_ms: i64,
    /// The publication or stage it is about.
    pub publication_id: Option<String>,
    /// The qualifier.
    pub detail: Option<String>,
}

/// Write one event on `conn`, which is the connection of the transaction it belongs to. Returns
/// whether it was written: an event id already in the ledger is not written twice.
pub(crate) async fn append(conn: &mut PgConnection, event: &NewEvent) -> Result<bool, StoreError> {
    let result = sqlx::query(
        "INSERT INTO events (event_id, kind, origin, session_id, occurred_at, publication_id, detail) \
         VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, \
                 COALESCE(to_timestamp($5::float8 / 1000.0), now()), $6, $7) \
         ON CONFLICT (event_id) DO NOTHING",
    )
    .bind(event.event_id.as_deref())
    .bind(event.kind.as_str())
    .bind(event.kind.origin().as_str())
    .bind(event.session_id.as_deref())
    .bind(event.occurred_at_ms.map(|ms| ms as f64))
    .bind(event.publication_id.as_deref())
    .bind(event.detail.as_deref())
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(result.rows_affected() == 1)
}

const EVENT_COLUMNS: &str = "seq, event_id, kind, origin, session_id, \
    (extract(epoch from occurred_at) * 1000)::bigint AS occurred_ms, publication_id, detail";

fn stored(row: &sqlx::postgres::PgRow) -> Result<StoredEvent, StoreError> {
    let kind: String = row.try_get("kind").map_err(db)?;
    let origin: String = row.try_get("origin").map_err(db)?;
    Ok(StoredEvent {
        seq: row.try_get("seq").map_err(db)?,
        event_id: row.try_get("event_id").map_err(db)?,
        kind: EventKind::parse(&kind)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown event kind {kind}")))?,
        origin: match origin.as_str() {
            "server" => Origin::Server,
            "client" => Origin::Client,
            other => return Err(StoreError::Corrupt(format!("unknown event origin {other}"))),
        },
        session_id: row.try_get("session_id").map_err(db)?,
        occurred_at_ms: row.try_get("occurred_ms").map_err(db)?,
        publication_id: row.try_get("publication_id").map_err(db)?,
        detail: row.try_get("detail").map_err(db)?,
    })
}

/// What a relay did with one claimed batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claimed<E> {
    /// No unsent rows were available to claim.
    Nothing,
    /// A batch was delivered and acknowledged: this many rows.
    Delivered(usize),
    /// The delivery failed; the rows stay unsent.
    Failed(E),
}

/// How far behind the relay is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backlog {
    /// Events not yet delivered.
    pub unsent: i64,
    /// Age of the oldest undelivered event, in milliseconds (0 when there is none), by the
    /// database clock.
    pub oldest_unsent_age_ms: i64,
}

impl Store {
    /// Write events that are not part of a business transaction (the client ingest path). Events
    /// whose id is already in the ledger are not written again; returns how many were written.
    pub async fn append_events(&self, events: &[NewEvent]) -> Result<u64, StoreError> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let mut written = 0;
        for event in events {
            if append(&mut tx, event).await? {
                written += 1;
            }
        }
        tx.commit().await.map_err(db)?;
        Ok(written)
    }

    /// Claim up to `limit` unsent events, hand them to `deliver`, and mark them sent if it
    /// succeeds.
    ///
    /// Rows are claimed with `FOR UPDATE SKIP LOCKED`, so any number of relays can run over the
    /// same backlog without waiting for or duplicating each other, and the claim lasts exactly as
    /// long as the transaction: if the process dies or `deliver` fails, the rows are released
    /// still unsent and are delivered again. Delivery is therefore at least once.
    pub async fn relay_batch<E, F>(&self, limit: u32, deliver: F) -> Result<Claimed<E>, StoreError>
    where
        F: for<'a> FnOnce(&'a [StoredEvent]) -> BoxFuture<'a, Result<(), E>>,
    {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT {EVENT_COLUMNS} FROM events WHERE relay_state = 'unsent' \
             ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED"
        )))
        .bind(i64::from(limit))
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        if rows.is_empty() {
            tx.rollback().await.map_err(db)?;
            return Ok(Claimed::Nothing);
        }
        let batch: Vec<StoredEvent> = rows.iter().map(stored).collect::<Result<_, _>>()?;
        if let Err(e) = deliver(&batch).await {
            tx.rollback().await.map_err(db)?;
            return Ok(Claimed::Failed(e));
        }
        let seqs: Vec<i64> = batch.iter().map(|e| e.seq).collect();
        sqlx::query("UPDATE events SET relay_state = 'sent', sent_at = now() WHERE seq = ANY($1)")
            .bind(&seqs)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(Claimed::Delivered(batch.len()))
    }

    /// Delete events that happened before `cutoff_ms`, up to `limit` of them, never an unsent one
    /// and never one a relay is working on. Safe to run alongside the relay. Returns how many were
    /// deleted.
    pub async fn delete_old_sent_events(
        &self,
        cutoff_ms: i64,
        limit: u32,
    ) -> Result<u64, StoreError> {
        let result = sqlx::query(
            "DELETE FROM events WHERE seq IN ( \
               SELECT seq FROM events \
               WHERE relay_state = 'sent' AND occurred_at < to_timestamp($1::float8 / 1000.0) \
               ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)",
        )
        .bind(cutoff_ms as f64)
        .bind(i64::from(limit))
        .execute(&self.pool)
        .await
        .map_err(db)?;
        Ok(result.rows_affected())
    }

    /// How far behind delivery is, by the database clock.
    pub async fn event_backlog(&self) -> Result<Backlog, StoreError> {
        let row = sqlx::query(
            "SELECT count(*)::bigint AS unsent, \
                    COALESCE((extract(epoch from now() - min(occurred_at)) * 1000)::bigint, 0) AS age \
             FROM events WHERE relay_state = 'unsent'",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db)?;
        Ok(Backlog {
            unsent: row.try_get("unsent").map_err(db)?,
            oldest_unsent_age_ms: row.try_get("age").map_err(db)?,
        })
    }

    /// Every event in the ledger in ledger order, for tests and the rebuild.
    pub async fn all_events(&self) -> Result<Vec<StoredEvent>, StoreError> {
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT {EVENT_COLUMNS} FROM events ORDER BY seq"
        )))
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        rows.iter().map(stored).collect()
    }
}
