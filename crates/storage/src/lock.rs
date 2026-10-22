//! The session-level advisory lock on one stage, shared by everything that must serialise with
//! forks of that stage: creating a flip, and every change to the stage's fork-relevant flags.

use crate::postgres::{StoreError, db};
use graft_domain::ids::PublicationId;
use sqlx::pool::PoolConnection;
use sqlx::{PgConnection, PgPool, Postgres};
use std::time::Duration;

/// A pooled connection holding the session-level advisory lock for one parent.
///
/// Every way out releases the lock or closes the connection. A normal exit unlocks, resets the
/// setting this type changed and returns the connection to the pool. Any other exit, including an
/// error while waiting, a timeout, or a panic in the task that owns it, drops the value with the
/// connection still inside; `Drop` then detaches the connection and closes it, which ends the
/// session and with it every lock and setting the session had. A lock can therefore never outlive
/// the work that took it, and a changed setting can never leak into the pool.
pub(crate) struct Locked {
    conn: Option<PoolConnection<Postgres>>,
}

impl Locked {
    pub(crate) async fn acquire(
        pool: &PgPool,
        parent: &PublicationId,
        wait: Duration,
    ) -> Result<Self, StoreError> {
        let conn = pool.acquire().await.map_err(db)?;
        // From here the guard owns the connection, so an early return closes it.
        let mut locked = Self { conn: Some(conn) };
        let millis = wait.as_millis();
        sqlx::query(sqlx::AssertSqlSafe(format!("SET lock_timeout = {millis}")))
            .execute(locked.connection()?)
            .await
            .map_err(db)?;
        // Taken outside any transaction, so the snapshot of the transaction that follows is taken
        // after every earlier fork of this parent has committed.
        sqlx::query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
            .bind(parent.as_str())
            .execute(locked.connection()?)
            .await
            .map_err(db)?;
        Ok(locked)
    }

    pub(crate) fn connection(&mut self) -> Result<&mut PgConnection, StoreError> {
        self.conn
            .as_deref_mut()
            .ok_or_else(|| StoreError::Corrupt("the locked connection is gone".into()))
    }

    /// Unlock, reset the setting and give the connection back; close it if that fails.
    pub(crate) async fn release(mut self, parent: &PublicationId) {
        let Some(mut conn) = self.conn.take() else {
            return;
        };
        let unlock = sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
            .bind(parent.as_str())
            .execute(&mut *conn)
            .await;
        let reset = sqlx::query("RESET lock_timeout").execute(&mut *conn).await;
        if unlock.is_err() || reset.is_err() {
            drop(conn.detach());
        }
    }
}

impl Drop for Locked {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            drop(conn.detach());
        }
    }
}
