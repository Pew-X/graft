//! State the abuse guardrails keep in the database so that every service instance agrees on it:
//! settings the operator changes at run time (the kill switch), and the global publish budget.
//!
//! Neither holds anything about a visitor. The per-visitor limits live in memory in the api crate
//! and never reach this file.

use crate::postgres::{Store, StoreError, db};

/// The answer to a request for one publish token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishToken {
    /// A token was taken: the publish may go on.
    Taken,
    /// The budget is empty. The wait is when one token will next be available.
    Empty {
        /// Whole seconds, at least 1.
        retry_after_secs: u64,
    },
}

impl Store {
    /// The value stored for a setting, or `None` when the operator has not set it.
    pub async fn setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        sqlx::query_scalar("SELECT value FROM runtime_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)
    }

    /// Set a setting, replacing any earlier value.
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO runtime_settings (key, value) VALUES ($1, $2) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await
        .map_err(db)?;
        Ok(())
    }

    /// Take one token from the global publish budget.
    ///
    /// The budget is a token bucket: it holds at most `burst` tokens and gains `per_hour / 3600`
    /// tokens a second. `now_secs` is the time in seconds since the Unix epoch, passed in so a test
    /// can move it. The take is one conditional update of one row, so any number of concurrent
    /// callers, on any number of instances, are admitted exactly as often as there are tokens.
    pub async fn take_publish_token(
        &self,
        now_secs: f64,
        per_hour: u32,
        burst: u32,
    ) -> Result<PublishToken, StoreError> {
        let rate = f64::from(per_hour) / 3600.0;
        let burst = f64::from(burst);
        sqlx::query(
            "INSERT INTO publish_budget (id, tokens, updated_at) VALUES (1, $1, to_timestamp($2)) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(burst)
        .bind(now_secs)
        .execute(&self.pool)
        .await
        .map_err(db)?;
        let taken = sqlx::query(
            "UPDATE publish_budget SET \
               tokens = LEAST($1, tokens + GREATEST(0, $2 - extract(epoch from updated_at)) * $3) - 1, \
               updated_at = to_timestamp($2) \
             WHERE id = 1 \
               AND LEAST($1, tokens + GREATEST(0, $2 - extract(epoch from updated_at)) * $3) >= 1",
        )
        .bind(burst)
        .bind(now_secs)
        .bind(rate)
        .execute(&self.pool)
        .await
        .map_err(db)?
        .rows_affected();
        if taken == 1 {
            return Ok(PublishToken::Taken);
        }
        let (tokens, updated): (f64, f64) = sqlx::query_as(
            "SELECT tokens, extract(epoch from updated_at)::float8 FROM publish_budget WHERE id = 1",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db)?;
        let available = (tokens + (now_secs - updated).max(0.0) * rate).min(burst);
        let wait = if rate > 0.0 {
            ((1.0 - available) / rate).ceil()
        } else {
            3600.0
        };
        Ok(PublishToken::Empty {
            retry_after_secs: wait.clamp(1.0, 86_400.0) as u64,
        })
    }
}
