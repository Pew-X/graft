//! The operator's read of the event path: hourly rollups, relay backlog and consumer lag, and the
//! pipeline's metrics. Counts only; the reports say "sessions' events", never "people".

use crate::http::AppState;
use crate::problem::Problem;
use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Most hours one read returns: 30 days, the length of the ledger's retention.
pub const MAX_HOURS: u32 = 24 * 30;

/// Which hours to read.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollupsQuery {
    /// How many of the most recent hours, counting the current one; default 24.
    pub hours: Option<u32>,
}

/// Events counted in one hour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HourView {
    /// The start of the hour, milliseconds since the Unix epoch.
    pub hour_ms: i64,
    /// Counts by event kind; a kind with no events that hour is absent.
    pub counts: BTreeMap<String, i64>,
}

/// How far behind delivery is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RelayView {
    /// Events not yet delivered.
    pub unsent: i64,
    /// Age of the oldest of them in milliseconds; 0 when there is none.
    pub oldest_unsent_age_ms: i64,
}

/// How far behind counting is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ConsumerView {
    /// Events in the ledger not yet counted.
    pub unapplied: i64,
    /// Age of the oldest of them in milliseconds; 0 when there is none: the event-to-rollup lag.
    pub oldest_unapplied_age_ms: i64,
    /// Events this process counted since it started.
    pub applied_since_start: u64,
    /// Repeats this process ignored since it started.
    pub duplicates_since_start: u64,
}

/// What the operator reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RollupsView {
    /// When this was read, milliseconds since the Unix epoch.
    pub generated_at_ms: i64,
    /// Hourly counts, oldest first.
    pub hours: Vec<HourView>,
    /// Delivery backlog.
    pub relay: RelayView,
    /// Counting lag.
    pub consumer: ConsumerView,
    /// How to read the numbers.
    pub note: &'static str,
}

fn now_ms(state: &AppState) -> i64 {
    (state.guards.clock.now_secs() * 1000.0) as i64
}

/// The most recent hourly rollups with the relay backlog and the consumer lag.
pub async fn get_rollups(
    State(state): State<AppState>,
    Query(query): Query<RollupsQuery>,
) -> Result<Json<RollupsView>, Problem> {
    let hours = query.hours.unwrap_or(24);
    if hours == 0 || hours > MAX_HOURS {
        return Err(Problem::invalid(
            "hours",
            "out_of_range",
            format!("hours must be between 1 and {MAX_HOURS}"),
        ));
    }
    let now = now_ms(&state);
    let current_hour = now - now.rem_euclid(3_600_000);
    let since = current_hour - i64::from(hours - 1) * 3_600_000;
    let fail = |what: &str, e: &graft_storage::StoreError| {
        tracing::error!(error = %e, what, "reading the event path failed");
        Problem::internal()
    };
    let rows = state
        .store
        .rollup_rows_since(since)
        .await
        .map_err(|e| fail("rollups", &e))?;
    let backlog = state
        .store
        .event_backlog(now)
        .await
        .map_err(|e| fail("backlog", &e))?;
    let lag = state
        .store
        .consumer_lag(now)
        .await
        .map_err(|e| fail("lag", &e))?;
    let mut by_hour: BTreeMap<i64, BTreeMap<String, i64>> = BTreeMap::new();
    for row in rows {
        *by_hour
            .entry(row.hour_ms)
            .or_default()
            .entry(row.kind.as_str().to_owned())
            .or_default() += row.count;
    }
    Ok(Json(RollupsView {
        generated_at_ms: now,
        hours: by_hour
            .into_iter()
            .map(|(hour_ms, counts)| HourView { hour_ms, counts })
            .collect(),
        relay: RelayView {
            unsent: backlog.unsent,
            oldest_unsent_age_ms: backlog.oldest_unsent_age_ms,
        },
        consumer: ConsumerView {
            unapplied: lag.unapplied,
            oldest_unapplied_age_ms: lag.oldest_unapplied_age_ms,
            applied_since_start: state.consumer_stats.applied(),
            duplicates_since_start: state.consumer_stats.duplicates(),
        },
        note: "Counts of events. Client events are best-effort; only server events can never diverge from their write. Sessions are not counted individually.",
    }))
}

/// The pipeline's metrics in the Prometheus text format. A failed read leaves its line out; a
/// metrics scrape never fails because the database is slow.
pub async fn metrics_text(state: &AppState) -> String {
    let now = now_ms(state);
    let mut out = String::new();
    out.push_str("# TYPE graft_events_applied_total counter\n");
    out.push_str(&format!(
        "graft_events_applied_total {}\n",
        state.consumer_stats.applied()
    ));
    out.push_str("# TYPE graft_events_duplicates_total counter\n");
    out.push_str(&format!(
        "graft_events_duplicates_total {}\n",
        state.consumer_stats.duplicates()
    ));
    if let Ok(backlog) = state.store.event_backlog(now).await {
        out.push_str("# TYPE graft_relay_backlog gauge\n");
        out.push_str(&format!("graft_relay_backlog {}\n", backlog.unsent));
        out.push_str("# TYPE graft_relay_oldest_unsent_age_seconds gauge\n");
        out.push_str(&format!(
            "graft_relay_oldest_unsent_age_seconds {}\n",
            backlog.oldest_unsent_age_ms / 1000
        ));
    }
    if let Ok(lag) = state.store.consumer_lag(now).await {
        out.push_str("# TYPE graft_consumer_lag_seconds gauge\n");
        out.push_str(&format!(
            "graft_consumer_lag_seconds {}\n",
            lag.oldest_unapplied_age_ms / 1000
        ));
    }
    out
}
