#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The consumer and the rollups against a real Postgres: applying is idempotent whatever the
//! delivery, a rebuild reproduces the same counts, and a rebuild neither loses nor doubles events
//! that arrive while it runs.

use graft_events::{BatchConsumer, Consumer, EventKind, MemorySink, Relay, Retention};
use graft_storage::testing::TestDb;
use graft_storage::{NewEvent, RollupRow, StoreError, StoredEvent};
use proptest::prelude::*;
use std::collections::BTreeMap;
use std::sync::Arc;

// An exact hour boundary (1,800,000,000,000 ms is 500,000 hours after the epoch).
const BASE_MS: i64 = 1_800_000_000_000;
const HOUR: i64 = 3_600_000;

#[derive(Debug, Clone)]
struct Spec {
    kind: usize,
    hour: i64,
    offset_ms: i64,
    publication: u8,
}

fn event(n: usize, spec: &Spec) -> NewEvent {
    let kind = EventKind::ALL[spec.kind % 5];
    NewEvent {
        event_id: Some(format!("event-id-for-test-{n:06}")),
        kind,
        session_id: (kind.origin() == graft_storage::Origin::Client)
            .then(|| "session-0001".to_owned()),
        occurred_at_ms: Some(BASE_MS + spec.hour * HOUR + spec.offset_ms),
        publication_id: Some(format!("pub-{}", spec.publication)),
        detail: None,
    }
}

/// The expected rollups, worked out from the specs alone, independent of any code under test.
fn oracle(specs: &[Spec]) -> Vec<RollupRow> {
    let mut counts: BTreeMap<(i64, EventKind, String), i64> = BTreeMap::new();
    for s in specs {
        *counts
            .entry((
                BASE_MS + s.hour * HOUR,
                EventKind::ALL[s.kind % 5],
                format!("pub-{}", s.publication),
            ))
            .or_default() += 1;
    }
    let mut rows: Vec<RollupRow> = counts
        .into_iter()
        .map(|((hour_ms, kind, publication_id), count)| RollupRow {
            hour_ms,
            kind,
            publication_id,
            count,
        })
        .collect();
    // The database reads rows ordered by hour, then the kind's name, then the publication.
    rows.sort_by(|a, b| {
        (a.hour_ms, a.kind.as_str(), &a.publication_id).cmp(&(
            b.hour_ms,
            b.kind.as_str(),
            &b.publication_id,
        ))
    });
    rows
}

async fn reset(db: &TestDb) {
    sqlx::query("TRUNCATE events, processed_events, rollups")
        .execute(db.store.pool())
        .await
        .expect("reset");
}

async fn load(db: &TestDb, specs: &[Spec]) -> Vec<StoredEvent> {
    let events: Vec<NewEvent> = specs.iter().enumerate().map(|(n, s)| event(n, s)).collect();
    db.store.append_events(&events).await.expect("append");
    db.store.all_events().await.expect("all")
}

async fn apply_all(consumer: &Consumer, batches: &[&[StoredEvent]]) {
    for b in batches {
        consumer.apply(b).await.expect("apply");
    }
}

fn spec_strategy() -> impl Strategy<Value = Spec> {
    (0usize..5, 0i64..4, 0i64..HOUR, 0u8..3).prop_map(|(kind, hour, offset_ms, publication)| Spec {
        kind,
        hour,
        offset_ms,
        publication,
    })
}

/// Applying a stream, applying it twice, applying it shuffled, applying it in random batch sizes
/// and rebuilding from the ledger all give identical rollups, and they equal the counts worked out
/// by hand from the specs.
#[test]
fn applying_once_twice_shuffled_in_any_batches_and_rebuilding_give_identical_rollups() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let db = rt.block_on(TestDb::create());
    let consumer = Consumer::new(db.store.clone());
    let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig::with_cases(40));
    let strategy = (
        prop::collection::vec(spec_strategy(), 1..40),
        any::<u64>(),
        1usize..9,
    );
    runner
        .run(&strategy, |(specs, seed, chunk)| {
            rt.block_on(async {
                reset(&db).await;
                let stored = load(&db, &specs).await;
                let expected = oracle(&specs);

                // Once, as one batch.
                apply_all(&consumer, &[&stored]).await;
                prop_assert_eq!(
                    &db.store.rollup_rows().await.expect("rows"),
                    &expected,
                    "once"
                );

                // Twice more: the same ids again change nothing.
                apply_all(&consumer, &[&stored, &stored]).await;
                prop_assert_eq!(
                    &db.store.rollup_rows().await.expect("rows"),
                    &expected,
                    "twice"
                );

                // Shuffled, in random batch sizes, from nothing.
                sqlx::query("TRUNCATE processed_events, rollups")
                    .execute(db.store.pool())
                    .await
                    .expect("clear");
                let mut shuffled = stored.clone();
                let mut state = seed | 1;
                for i in (1..shuffled.len()).rev() {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    shuffled.swap(i, (state % (i as u64 + 1)) as usize);
                }
                let batches: Vec<&[StoredEvent]> = shuffled.chunks(chunk).collect();
                apply_all(&consumer, &batches).await;
                prop_assert_eq!(
                    &db.store.rollup_rows().await.expect("rows"),
                    &expected,
                    "shuffled in batches of {}",
                    chunk
                );

                // Rebuilt from the ledger, from nothing.
                sqlx::query("TRUNCATE processed_events, rollups")
                    .execute(db.store.pool())
                    .await
                    .expect("clear");
                db.store.rebuild_rollups().await.expect("rebuild");
                prop_assert_eq!(
                    &db.store.rollup_rows().await.expect("rows"),
                    &expected,
                    "rebuilt"
                );
                // And a rebuild over live rollups changes nothing either.
                db.store.rebuild_rollups().await.expect("rebuild again");
                prop_assert_eq!(
                    &db.store.rollup_rows().await.expect("rows"),
                    &expected,
                    "twice rebuilt"
                );
                Ok(())
            })
        })
        .expect("the property holds");
    rt.block_on(db.drop_db());
}

fn spec(kind: usize, hour: i64, publication: u8) -> Spec {
    Spec {
        kind,
        hour,
        offset_ms: 1000,
        publication,
    }
}

#[tokio::test]
async fn a_duplicate_is_a_no_op_including_one_that_arrives_after_a_rebuild() {
    let db = TestDb::create().await;
    let consumer = Consumer::new(db.store.clone());
    let specs = [spec(2, 0, 0), spec(2, 0, 0), spec(3, 1, 1)];
    let stored = load(&db, &specs).await;
    apply_all(&consumer, &[&stored[..2]]).await;
    let before = db.store.rollup_rows().await.expect("rows");
    apply_all(&consumer, &[&stored[..2]]).await;
    assert_eq!(db.store.rollup_rows().await.expect("rows"), before);
    assert_eq!(consumer.stats().applied(), 2);
    assert_eq!(consumer.stats().duplicates(), 2);

    // The rebuild counts all three events from the ledger; the third, delivered now, is a repeat.
    db.store.rebuild_rollups().await.expect("rebuild");
    let rebuilt = db.store.rollup_rows().await.expect("rows");
    assert_eq!(rebuilt, oracle(&specs));
    apply_all(&consumer, &[&stored]).await;
    assert_eq!(
        db.store.rollup_rows().await.expect("rows"),
        rebuilt,
        "a delivery that repeats events counted by the rebuild changes nothing"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn events_arriving_while_a_rebuild_runs_are_counted_exactly_once() {
    let db = TestDb::create().await;
    let consumer = Arc::new(Consumer::new(db.store.clone()));
    let early = [spec(2, 0, 0), spec(3, 0, 1), spec(4, 1, 0)];
    let stored = load(&db, &early).await;
    apply_all(&consumer, &[&stored]).await;

    // While the rebuild holds the tables, five more events are written to the ledger (it is not
    // locked) and a consumer starts applying them: it must wait for the swap and then count each
    // once.
    let late_specs = [
        spec(2, 1, 0),
        spec(2, 1, 0),
        spec(0, 2, 2),
        spec(1, 2, 2),
        spec(4, 0, 1),
    ];
    let late: Vec<NewEvent> = late_specs
        .iter()
        .enumerate()
        .map(|(n, s)| event(100 + n, s))
        .collect();
    let (store, consumer2) = (db.store.clone(), consumer.clone());
    let (applier_tx, applier_rx) = tokio::sync::oneshot::channel();
    let report = db
        .store
        .rebuild_rollups_with(move || {
            Box::pin(async move {
                store.append_events(&late).await?;
                let batch: Vec<StoredEvent> = store
                    .all_events()
                    .await?
                    .into_iter()
                    .filter(|e| e.event_id.starts_with("event-id-for-test-0001"))
                    .collect();
                // Started now, blocked on the lock until the swap commits.
                let handle = tokio::spawn(async move { consumer2.apply(&batch).await });
                let _ = applier_tx.send(handle);
                Ok(())
            })
        })
        .await
        .expect("rebuild");
    assert_eq!(report.events, 3, "the snapshot held the three early events");
    applier_rx
        .await
        .expect("handle")
        .await
        .expect("join")
        .expect("apply");

    let all: Vec<Spec> = early.iter().chain(late_specs.iter()).cloned().collect();
    assert_eq!(
        db.store.rollup_rows().await.expect("rows"),
        oracle(&all),
        "every event is in the rollups exactly once"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_failed_rebuild_leaves_the_live_rollups_untouched() {
    let db = TestDb::create().await;
    let consumer = Consumer::new(db.store.clone());
    let specs = [spec(2, 0, 0), spec(3, 1, 1)];
    let stored = load(&db, &specs).await;
    apply_all(&consumer, &[&stored]).await;
    let live = db.store.rollup_rows().await.expect("rows");
    // Make the ledger differ from the live rollups, so an applied rebuild would show.
    db.store
        .append_events(&[event(50, &spec(4, 3, 2))])
        .await
        .expect("append");
    let failed = db
        .store
        .rebuild_rollups_with(|| Box::pin(async { Err(StoreError::Db("told to fail".into())) }))
        .await;
    assert!(failed.is_err());
    assert_eq!(db.store.rollup_rows().await.expect("rows"), live);
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_name LIKE 'rollups%' ORDER BY 1",
    )
    .fetch_all(db.store.pool())
    .await
    .expect("tables");
    assert_eq!(tables, ["rollups"], "the half-built table is gone");
    // The consumer still works, and the unapplied event is counted when it arrives.
    let all = db.store.all_events().await.expect("all");
    apply_all(&consumer, &[&all]).await;
    assert_eq!(
        db.store.rollup_rows().await.expect("rows").len(),
        3,
        "{:?}",
        db.store.rollup_rows().await
    );
    db.drop_db().await;
}

/// Rollups older than the retention window cannot be rebuilt: the ledger no longer holds their
/// events, so a rebuild carries those hours over as they are instead of erasing them.
#[tokio::test]
async fn a_rebuild_keeps_hours_older_than_the_window_that_the_ledger_can_no_longer_recount() {
    let db = TestDb::create().await;
    let consumer = Consumer::new(db.store.clone());
    let day = 24 * HOUR;
    // Old events, 40 days before the recent ones.
    let old = NewEvent {
        event_id: Some("event-id-old-000000001".into()),
        kind: EventKind::StagePlayed,
        session_id: Some("session-0001".into()),
        occurred_at_ms: Some(BASE_MS - 40 * day),
        publication_id: Some("pub-0".into()),
        detail: None,
    };
    db.store.append_events(&[old]).await.expect("append");
    let recent = load(&db, &[spec(2, 0, 0)]).await;
    apply_all(&consumer, &[&recent]).await;
    let sink = Arc::new(MemorySink::default());
    Relay::new(db.store.clone(), sink, 100)
        .drain()
        .await
        .expect("relay");
    // The old event is counted (it is in the ledger), then retention removes it from the ledger.
    db.store.rebuild_rollups().await.expect("rebuild");
    let before = db.store.rollup_rows().await.expect("rows");
    assert_eq!(before.len(), 2);
    Retention::new(db.store.clone(), 30)
        .drain(BASE_MS)
        .await
        .expect("retention");
    assert_eq!(db.store.all_events().await.expect("all").len(), 1);
    db.store.rebuild_rollups().await.expect("rebuild");
    assert_eq!(
        db.store.rollup_rows().await.expect("rows"),
        before,
        "the old hour survives the rebuild"
    );
    db.drop_db().await;
}

/// The rollup tables can only hold counts.
#[tokio::test]
async fn the_rollup_tables_hold_no_session_id_address_or_agent() {
    let db = TestDb::create().await;
    let consumer = Consumer::new(db.store.clone());
    let stored = load(&db, &[spec(2, 0, 0), spec(3, 0, 1)]).await;
    apply_all(&consumer, &[&stored]).await;
    let columns: Vec<(String, String)> = sqlx::query_as(
        "SELECT table_name::text, column_name::text FROM information_schema.columns \
         WHERE table_name IN ('rollups', 'processed_events') ORDER BY table_name, ordinal_position",
    )
    .fetch_all(db.store.pool())
    .await
    .expect("columns");
    let names: Vec<String> = columns.iter().map(|(t, c)| format!("{t}.{c}")).collect();
    assert_eq!(
        names,
        [
            "processed_events.event_id",
            "processed_events.occurred_at",
            "rollups.hour",
            "rollups.kind",
            "rollups.publication_id",
            "rollups.count"
        ]
    );
    for table in ["rollups", "processed_events"] {
        let rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT t::text FROM {table} t"
        )))
        .fetch_all(db.store.pool())
        .await
        .expect("rows");
        assert!(!rows.is_empty());
        assert!(
            rows.iter().all(|r| !r.contains("session")),
            "{table}: {rows:?}"
        );
    }
    db.drop_db().await;
}

#[tokio::test]
async fn consumer_lag_counts_events_not_yet_applied_with_the_age_of_the_oldest() {
    let db = TestDb::create().await;
    let consumer = Consumer::new(db.store.clone());
    let stored = load(&db, &[spec(2, 0, 0), spec(3, 1, 1), spec(4, 2, 1)]).await;
    let now = BASE_MS + 3 * HOUR;
    let lag = db.store.consumer_lag(now).await.expect("lag");
    assert_eq!(lag.unapplied, 3);
    assert_eq!(lag.oldest_unapplied_age_ms, 3 * HOUR - 1000);
    apply_all(&consumer, &[&stored[..1]]).await;
    let lag = db.store.consumer_lag(now).await.expect("lag");
    assert_eq!(lag.unapplied, 2);
    assert_eq!(lag.oldest_unapplied_age_ms, 2 * HOUR - 1000);
    apply_all(&consumer, &[&stored]).await;
    let lag = db.store.consumer_lag(now).await.expect("lag");
    assert_eq!((lag.unapplied, lag.oldest_unapplied_age_ms), (0, 0));
    db.drop_db().await;
}

/// The Postgres-only path end to end: the relay claims ledger rows, the sink hands them to the
/// consumer in the same process, the rollups come out right, and nothing is left behind.
#[tokio::test]
async fn the_relay_through_the_in_process_sink_fills_the_rollups_and_leaves_no_backlog() {
    use graft_events::ConsumerSink;
    let db = TestDb::create().await;
    let specs = [spec(2, 0, 0), spec(2, 0, 0), spec(3, 1, 1), spec(0, 1, 2)];
    load(&db, &specs).await;
    let relay = Relay::new(
        db.store.clone(),
        Arc::new(ConsumerSink(Consumer::new(db.store.clone()))),
        3,
    );
    assert_eq!(relay.drain().await.expect("drain"), 4);
    assert_eq!(db.store.rollup_rows().await.expect("rows"), oracle(&specs));
    assert_eq!(
        db.store
            .event_backlog(BASE_MS)
            .await
            .expect("backlog")
            .unsent,
        0
    );
    assert_eq!(
        db.store.consumer_lag(BASE_MS).await.expect("lag").unapplied,
        0
    );
    db.drop_db().await;
}
