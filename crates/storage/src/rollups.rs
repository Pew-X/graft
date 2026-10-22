//! The read side of the event path: applying delivered events to hourly rollups exactly once, and
//! rebuilding the rollups from the ledger.
//!
//! The rollups are derived state. Applying an event is idempotent on its event id (a dedupe set
//! kept at least as long as the events), so duplicate, replayed and re-ordered delivery all give
//! the same counts. A rebuild writes fresh tables from the ledger and swaps them in inside one
//! transaction; consumers wait on a lock for that moment and then find their events already
//! counted or not, so nothing is lost and nothing is counted twice.

use crate::events::{EventKind, StoredEvent};
use crate::postgres::{Store, StoreError, db};
use sqlx::Row;
use std::collections::BTreeMap;

/// One row of the hourly rollups.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RollupRow {
    /// The start of the hour, milliseconds since the Unix epoch.
    pub hour_ms: i64,
    /// What happened.
    pub kind: EventKind,
    /// The publication or stage; empty when an event named none.
    pub publication_id: String,
    /// How many events.
    pub count: i64,
}

/// What applying a batch did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Applied {
    /// Events counted.
    pub applied: u64,
    /// Events already counted before, ignored.
    pub duplicates: u64,
}

/// What a rebuild did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rebuilt {
    /// Events in the ledger that the new rollups were counted from.
    pub events: i64,
    /// Rollup rows now in the live table.
    pub rows: i64,
}

/// How far behind the consumer is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lag {
    /// Events in the ledger the consumer has not counted.
    pub unapplied: i64,
    /// Age of the oldest of them in milliseconds at the time asked (0 when there is none).
    pub oldest_unapplied_age_ms: i64,
}

/// The setting that records how far back the ledger has been trimmed.
pub(crate) const FLOOR_KEY: &str = "events_floor_ms";

impl Store {
    /// Count each event not yet counted. The dedupe insert and the counts are one transaction, so
    /// an event is counted exactly once however often, and in whatever order, it is delivered.
    pub async fn apply_events(&self, batch: &[StoredEvent]) -> Result<Applied, StoreError> {
        let mut first: BTreeMap<&str, &StoredEvent> = BTreeMap::new();
        for event in batch {
            first.entry(event.event_id.as_str()).or_insert(event);
        }
        let in_batch_duplicates = (batch.len() - first.len()) as u64;
        if first.is_empty() {
            return Ok(Applied::default());
        }
        let ids: Vec<&str> = first.keys().copied().collect();
        let times: Vec<f64> = first.values().map(|e| e.occurred_at_ms as f64).collect();
        let mut tx = self.pool.begin().await.map_err(db)?;
        let fresh: Vec<String> = sqlx::query_scalar(
            "INSERT INTO processed_events (event_id, occurred_at) \
             SELECT t.id, to_timestamp(t.ms / 1000.0) FROM unnest($1::text[], $2::float8[]) AS t(id, ms) \
             ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
        )
        .bind(&ids)
        .bind(&times)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        let mut counts: BTreeMap<(i64, &'static str, String), i64> = BTreeMap::new();
        for id in &fresh {
            if let Some(e) = first.get(id.as_str()) {
                *counts
                    .entry((
                        e.hour_ms,
                        e.kind.as_str(),
                        e.publication_id.clone().unwrap_or_default(),
                    ))
                    .or_default() += 1;
            }
        }
        // A fixed order, so concurrent consumers lock rollup rows in the same order.
        for ((hour_ms, kind, publication_id), n) in &counts {
            sqlx::query(
                "INSERT INTO rollups (hour, kind, publication_id, count) \
                 VALUES (to_timestamp($1::float8 / 1000.0), $2, $3, $4) \
                 ON CONFLICT (hour, kind, publication_id) \
                 DO UPDATE SET count = rollups.count + EXCLUDED.count",
            )
            .bind(*hour_ms as f64)
            .bind(kind)
            .bind(publication_id)
            .bind(n)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(Applied {
            applied: fresh.len() as u64,
            duplicates: in_batch_duplicates + (first.len() - fresh.len()) as u64,
        })
    }

    /// Every rollup row, ordered. For tests, the rebuild command and the admin read.
    pub async fn rollup_rows(&self) -> Result<Vec<RollupRow>, StoreError> {
        self.rollup_rows_from(None).await
    }

    /// Rollup rows from the hour starting at `since_ms` on.
    pub async fn rollup_rows_since(&self, since_ms: i64) -> Result<Vec<RollupRow>, StoreError> {
        self.rollup_rows_from(Some(since_ms)).await
    }

    async fn rollup_rows_from(&self, since_ms: Option<i64>) -> Result<Vec<RollupRow>, StoreError> {
        let rows = sqlx::query(
            "SELECT (extract(epoch from hour) * 1000)::bigint AS hour_ms, kind, publication_id, count \
             FROM rollups WHERE $1::float8 IS NULL OR hour >= to_timestamp($1::float8 / 1000.0) \
             ORDER BY hour, kind, publication_id",
        )
        .bind(since_ms.map(|ms| ms as f64))
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        rows.iter()
            .map(|r| {
                let kind: String = r.try_get("kind").map_err(db)?;
                Ok(RollupRow {
                    hour_ms: r.try_get("hour_ms").map_err(db)?,
                    kind: EventKind::parse(&kind).ok_or_else(|| {
                        StoreError::Corrupt(format!("unknown rollup kind {kind}"))
                    })?,
                    publication_id: r.try_get("publication_id").map_err(db)?,
                    count: r.try_get("count").map_err(db)?,
                })
            })
            .collect()
    }

    /// How far behind the consumer is at `now_ms`.
    pub async fn consumer_lag(&self, now_ms: i64) -> Result<Lag, StoreError> {
        let row = sqlx::query(
            "SELECT count(*)::bigint AS unapplied, \
                    COALESCE(($1::float8 - min(extract(epoch from e.occurred_at) * 1000))::bigint, 0) AS age \
             FROM events e \
             WHERE NOT EXISTS (SELECT 1 FROM processed_events p WHERE p.event_id = e.event_id)",
        )
        .bind(now_ms as f64)
        .fetch_one(&self.pool)
        .await
        .map_err(db)?;
        Ok(Lag {
            unapplied: row.try_get("unapplied").map_err(db)?,
            oldest_unapplied_age_ms: row.try_get::<i64, _>("age").map_err(db)?.max(0),
        })
    }

    /// Rebuild the rollups from the ledger and swap them in.
    pub async fn rebuild_rollups(&self) -> Result<Rebuilt, StoreError> {
        self.rebuild_rollups_with(|| Box::pin(async { Ok(()) }))
            .await
    }

    /// As [`Store::rebuild_rollups`], running `before_swap` after the new tables are built and
    /// before they replace the live ones. A test uses it to force the interleaving it wants to
    /// examine; returning an error abandons the rebuild and leaves the live rollups untouched.
    pub async fn rebuild_rollups_with<F>(&self, before_swap: F) -> Result<Rebuilt, StoreError>
    where
        F: FnOnce() -> crate::blob::BoxFuture<'static, Result<(), StoreError>>,
    {
        let mut tx = self.pool.begin().await.map_err(db)?;
        // Consumers wait here until the swap commits. Events keep being appended to the ledger,
        // which this does not lock: those arrive after the snapshot below, are not in the dedupe
        // set, and are counted once by the consumer when it gets its turn.
        sqlx::query("LOCK TABLE processed_events, rollups IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        // One statement is one snapshot: the counts and the dedupe set come from the same ledger.
        sqlx::query(
            "CREATE TEMP TABLE ledger_snapshot ON COMMIT DROP AS \
             SELECT event_id, kind, COALESCE(publication_id, '') AS publication_id, occurred_at, \
                    to_timestamp(floor(extract(epoch from occurred_at) / 3600) * 3600) AS hour \
             FROM events",
        )
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        // Hours older than the ledger's floor have had events deleted; they cannot be rebuilt and
        // are carried over as they are.
        let floor: Option<String> =
            sqlx::query_scalar("SELECT value FROM runtime_settings WHERE key = $1")
                .bind(FLOOR_KEY)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        let floor_ms: f64 = floor
            .and_then(|v| v.parse::<i64>().ok())
            .map_or(f64::MIN, |v| v as f64);
        let rebuildable_from_hour = if floor_ms == f64::MIN {
            f64::MIN
        } else {
            ((floor_ms / 3_600_000.0).floor() + 1.0) * 3600.0
        };
        sqlx::query("CREATE TABLE rollups_rebuild (LIKE rollups INCLUDING ALL)")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query(
            "INSERT INTO rollups_rebuild (hour, kind, publication_id, count) \
             SELECT hour, kind, publication_id, count(*) FROM ledger_snapshot \
             WHERE extract(epoch from hour) >= $1 GROUP BY hour, kind, publication_id",
        )
        .bind(rebuildable_from_hour)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query(
            "INSERT INTO rollups_rebuild (hour, kind, publication_id, count) \
             SELECT hour, kind, publication_id, count FROM rollups \
             WHERE extract(epoch from hour) < $1",
        )
        .bind(rebuildable_from_hour)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        before_swap().await?;
        sqlx::query("ALTER TABLE rollups RENAME TO rollups_replaced")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("ALTER TABLE rollups_rebuild RENAME TO rollups")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("DROP TABLE rollups_replaced")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        // The dedupe set gains exactly the events the new counts were made from. Events older than
        // the floor were not recounted, so their ids stay as they were: an old event that was never
        // counted (still unsent) must still be countable when it is finally delivered.
        sqlx::query(
            "DELETE FROM processed_events WHERE event_id IN \
             (SELECT event_id FROM ledger_snapshot WHERE extract(epoch from hour) >= $1)",
        )
        .bind(rebuildable_from_hour)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query(
            "INSERT INTO processed_events (event_id, occurred_at) \
             SELECT event_id, occurred_at FROM ledger_snapshot \
             WHERE extract(epoch from hour) >= $1 ON CONFLICT (event_id) DO NOTHING",
        )
        .bind(rebuildable_from_hour)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        let events: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_snapshot")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM rollups")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(Rebuilt { events, rows })
    }
}
