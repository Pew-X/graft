#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The store against a real Postgres. Run with `cargo test -p graft-storage --features test-support`
//! (CI runs the whole workspace with all features); a server is expected at
//! `GRAFT_TEST_DATABASE_URL`, by default the local development container.

use graft_domain::chain::{Entry, SourceEvidence, Truncation};
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use graft_storage::testing::TestDb;
use graft_storage::{NewPublication, Outcome};

fn h(n: u8) -> Sha256Hash {
    Sha256Hash::from_bytes([n; 32])
}

fn renderer() -> RendererIdentity {
    RendererIdentity {
        name: "graft-render".into(),
        version: 1,
        wasm_sha256: h(0xcd),
    }
}

fn evidence() -> SourceEvidence {
    SourceEvidence {
        licence: "own recording".into(),
        work_title: Some("a door".into()),
        work_author: Some("pat".into()),
        url: None,
    }
}

fn source(key: &str, audio: u8) -> NewPublication {
    NewPublication {
        id: PublicationId::seeded(key),
        record: ContentRecord::source(h(audio), 48_000, renderer()).expect("valid"),
        retry_key: key.to_owned(),
        title: "door".into(),
        author: "pat".into(),
        evidence: Some(evidence()),
        manage_key_hash: None,
    }
}

fn flip(key: &str, parent: &NewPublication, out: u8) -> NewPublication {
    let t = Transform {
        p: 3,
        q: 2,
        method: METHOD_HERMITE,
    };
    NewPublication {
        id: PublicationId::seeded(key),
        record: ContentRecord::flip(
            parent.id.clone(),
            parent.record.output_blob(),
            Cut {
                start: 0,
                end: 24_000,
            },
            t,
            renderer(),
            h(out),
        )
        .expect("valid"),
        retry_key: key.to_owned(),
        title: "slower".into(),
        author: "jo".into(),
        evidence: None,
        manage_key_hash: None,
    }
}

fn created(o: Outcome) -> graft_domain::chain::StoredStage {
    match o {
        Outcome::Created(s) => *s,
        other => panic!("expected Created, got {other:?}"),
    }
}

#[tokio::test]
async fn creating_the_same_publication_twice_returns_the_first_and_writes_nothing_more() {
    let db = TestDb::create().await;
    let new = source("seed:a", 1);
    let first = created(db.store.create_publication(&new).await.expect("create"));
    let again = db.store.create_publication(&new).await.expect("retry");
    assert_eq!(again, Outcome::Existing(Box::new(first.clone())));
    let (publications, records): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM publications), (SELECT count(*) FROM content_records)",
    )
    .fetch_one(db.store.pool())
    .await
    .expect("counts");
    assert_eq!((publications, records), (1, 1));
    db.drop_db().await;
}

#[tokio::test]
async fn the_same_retry_key_with_different_content_is_a_conflict_and_leaves_no_trace() {
    let db = TestDb::create().await;
    db.store
        .create_publication(&source("seed:a", 1))
        .await
        .expect("create");
    let different = NewPublication {
        id: PublicationId::from_bits(7),
        ..source("seed:a", 2)
    };
    assert_eq!(
        db.store.create_publication(&different).await.expect("call"),
        Outcome::KeyConflict
    );
    let records: i64 = sqlx::query_scalar("SELECT count(*) FROM content_records")
        .fetch_one(db.store.pool())
        .await
        .expect("count");
    assert_eq!(
        records, 1,
        "the rejected request must not leave its content record behind"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_source_reads_back_as_a_chain_of_one_with_its_declared_evidence() {
    let db = TestDb::create().await;
    let new = source("seed:a", 1);
    db.store.create_publication(&new).await.expect("create");
    let chain = db
        .store
        .chain(&new.id, 12)
        .await
        .expect("read")
        .expect("found");
    assert_eq!(chain.entries.len(), 1);
    let Entry::Present(stage) = &chain.entries[0] else {
        panic!("expected a stage")
    };
    assert_eq!(stage.evidence, new.evidence);
    assert_eq!(stage.record, new.record);
    assert_eq!(stage.author, "pat");
    assert!(
        stage.created_at_ms > 1_700_000_000_000,
        "created_at is set by the database"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn an_unknown_publication_is_none_not_an_error() {
    let db = TestDb::create().await;
    assert_eq!(
        db.store
            .chain(&PublicationId::from_bits(1), 12)
            .await
            .expect("read"),
        None
    );
    assert_eq!(
        db.store
            .publication(&PublicationId::from_bits(1))
            .await
            .expect("read"),
        None
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_chain_reads_source_first_and_counts_how_often_each_stage_was_flipped() {
    let db = TestDb::create().await;
    let s = source("seed:a", 1);
    let f1 = flip("seed:b", &s, 2);
    let f2 = flip("seed:c", &f1, 3);
    let sibling = flip("seed:d", &f1, 4);
    for n in [&s, &f1, &f2, &sibling] {
        db.store.create_publication(n).await.expect("create");
    }
    let chain = db
        .store
        .chain(&f2.id, 12)
        .await
        .expect("read")
        .expect("found");
    let seen: Vec<(String, u32)> = chain
        .entries
        .iter()
        .map(|e| match e {
            Entry::Present(s) => (s.id.to_string(), s.flipped_count),
            Entry::Unavailable(id) => panic!("unexpected gap {id}"),
        })
        .collect();
    assert_eq!(
        seen,
        vec![
            (s.id.to_string(), 1),
            (f1.id.to_string(), 2),
            (f2.id.to_string(), 0)
        ],
        "source first; the middle stage was flipped twice, the source once"
    );
    assert_eq!(chain.truncated, None);
    db.drop_db().await;
}

#[tokio::test]
async fn a_deliberately_orphaned_parent_shows_as_unavailable_never_a_shorter_chain() {
    let db = TestDb::create().await;
    let s = source("seed:a", 1);
    let f = flip("seed:b", &s, 2);
    db.store.create_publication(&s).await.expect("create");
    db.store.create_publication(&f).await.expect("create");
    // Fixture: break the link the way a damaged restore could.
    sqlx::query("ALTER TABLE content_records DROP CONSTRAINT content_records_parent_fk")
        .execute(db.store.pool())
        .await
        .expect("drop fk");
    sqlx::query("DELETE FROM publications WHERE id = $1")
        .bind(s.id.as_str())
        .execute(db.store.pool())
        .await
        .expect("delete");
    let chain = db
        .store
        .chain(&f.id, 12)
        .await
        .expect("read")
        .expect("found");
    assert_eq!(chain.entries.len(), 2);
    assert_eq!(chain.entries[0], Entry::Unavailable(s.id.clone()));
    assert!(matches!(chain.entries[1], Entry::Present(_)));
    db.drop_db().await;
}

#[tokio::test]
async fn a_chain_deeper_than_the_cap_is_cut_short_with_a_stated_reason() {
    let db = TestDb::create().await;
    let mut parent = source("seed:0", 1);
    db.store.create_publication(&parent).await.expect("create");
    let mut last = parent.id.clone();
    for n in 1..=5u8 {
        let f = flip(&format!("seed:{n}"), &parent, n + 1);
        db.store.create_publication(&f).await.expect("create");
        last = f.id.clone();
        parent = f;
    }
    let chain = db
        .store
        .chain(&last, 4)
        .await
        .expect("read")
        .expect("found");
    assert_eq!(chain.entries.len(), 4);
    assert_eq!(chain.truncated, Some(Truncation::DepthCap));
    let whole = db
        .store
        .chain(&last, 6)
        .await
        .expect("read")
        .expect("found");
    assert_eq!((whole.entries.len(), whole.truncated), (6, None));
    db.drop_db().await;
}

#[tokio::test]
async fn a_row_whose_content_does_not_hash_to_its_id_is_reported_as_damaged() {
    let db = TestDb::create().await;
    let s = source("seed:a", 1);
    db.store.create_publication(&s).await.expect("create");
    sqlx::query("UPDATE content_records SET cut_end = cut_end + 1")
        .execute(db.store.pool())
        .await
        .expect("tamper");
    let err = db
        .store
        .publication(&s.id)
        .await
        .expect_err("must not be served");
    assert!(
        matches!(err, graft_storage::StoreError::Corrupt(_)),
        "got {err:?}"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn the_database_refuses_a_source_with_a_parent_even_if_the_application_did_not() {
    let db = TestDb::create().await;
    let s = source("seed:a", 1);
    db.store.create_publication(&s).await.expect("create");
    let bad = sqlx::query(
        "INSERT INTO content_records (id, format, kind, parent_publication_id, source_blob, cut_start, \
         cut_end, renderer_name, renderer_version, renderer_sha256, output_blob, canonical) \
         VALUES ($1, 1, 'source', $2, $3, 0, 10, 'x', 1, $3, $3, ''::bytea)",
    )
    .bind(vec![9u8; 32])
    .bind(s.id.as_str())
    .bind(vec![1u8; 32])
    .execute(db.store.pool())
    .await;
    assert!(bad.is_err(), "the CHECK constraint must refuse it");
    db.drop_db().await;
}

#[tokio::test]
async fn a_value_too_large_for_the_database_is_refused_and_never_wrapped_into_a_different_one() {
    let db = TestDb::create().await;
    // 3,000,000,000 frames fits a u32 but not a signed 32-bit column.
    let huge = NewPublication {
        id: PublicationId::seeded("seed:huge"),
        record: ContentRecord::source(h(1), 3_000_000_000, renderer()).expect("a valid record"),
        retry_key: "seed:huge".into(),
        title: "huge".into(),
        author: "pat".into(),
        evidence: None,
        manage_key_hash: None,
    };
    let err = db
        .store
        .create_publication(&huge)
        .await
        .expect_err("must be refused");
    assert!(
        matches!(err, graft_storage::StoreError::Corrupt(_)),
        "got {err:?}"
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM content_records")
        .fetch_one(db.store.pool())
        .await
        .expect("count");
    assert_eq!(
        rows, 0,
        "nothing was written, in particular nothing that wrapped"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_setting_is_absent_until_set_and_set_again_replaces_it() {
    let db = TestDb::create().await;
    assert_eq!(db.store.setting("publishing").await.expect("read"), None);
    db.store
        .set_setting("publishing", "off")
        .await
        .expect("set");
    assert_eq!(
        db.store
            .setting("publishing")
            .await
            .expect("read")
            .as_deref(),
        Some("off")
    );
    db.store.set_setting("publishing", "on").await.expect("set");
    assert_eq!(
        db.store
            .setting("publishing")
            .await
            .expect("read")
            .as_deref(),
        Some("on")
    );
    db.drop_db().await;
}

/// The guarantee behind the global publish cap: however many publishers ask at once, exactly the
/// burst is admitted and every other one is refused with a wait, none lost and none counted twice.
#[tokio::test]
async fn the_publish_budget_admits_exactly_the_burst_under_concurrent_demand() {
    use graft_storage::PublishToken;
    let db = TestDb::create().await;
    let now = 1_800_000_000.0;
    let tasks: Vec<_> = (0..40)
        .map(|_| {
            let store = db.store.clone();
            tokio::spawn(async move { store.take_publish_token(now, 3600, 7).await })
        })
        .collect();
    let (mut taken, mut refused) = (0, 0);
    for task in tasks {
        match task.await.expect("task").expect("a decision") {
            PublishToken::Taken => taken += 1,
            PublishToken::Empty { retry_after_secs } => {
                assert!(retry_after_secs >= 1, "a refusal says how long to wait");
                refused += 1;
            }
        }
    }
    assert_eq!(
        (taken, refused),
        (7, 33),
        "accepted plus refused is every request"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn the_publish_budget_refills_at_its_rate_and_never_beyond_the_burst() {
    use graft_storage::PublishToken;
    let db = TestDb::create().await;
    let t0 = 1_800_000_000.0;
    // 3600 an hour is one a second; the burst is 2.
    for _ in 0..2 {
        assert_eq!(
            db.store
                .take_publish_token(t0, 3600, 2)
                .await
                .expect("take"),
            PublishToken::Taken
        );
    }
    assert_eq!(
        db.store
            .take_publish_token(t0, 3600, 2)
            .await
            .expect("take"),
        PublishToken::Empty {
            retry_after_secs: 1
        }
    );
    // Half a second later there is still not a whole token, and the wait shrinks to one second.
    assert_eq!(
        db.store
            .take_publish_token(t0 + 0.5, 3600, 2)
            .await
            .expect("take"),
        PublishToken::Empty {
            retry_after_secs: 1
        }
    );
    // A second later there is one.
    assert_eq!(
        db.store
            .take_publish_token(t0 + 1.0, 3600, 2)
            .await
            .expect("take"),
        PublishToken::Taken
    );
    // A long quiet spell refills to the burst and no further.
    let later = t0 + 100_000.0;
    for _ in 0..2 {
        assert_eq!(
            db.store
                .take_publish_token(later, 3600, 2)
                .await
                .expect("take"),
            PublishToken::Taken
        );
    }
    assert!(matches!(
        db.store
            .take_publish_token(later, 3600, 2)
            .await
            .expect("take"),
        PublishToken::Empty { .. }
    ));
    db.drop_db().await;
}
