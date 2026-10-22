#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Properties over generated inputs, against a real Postgres. Each property runs a small, bounded
//! number of cases because every case writes to the database.

use graft_domain::chain::Entry;
use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use graft_storage::testing::TestDb;
use graft_storage::{FlipOutcome, NewFlip, NewPublication, Store};
use proptest::prelude::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

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

fn source(key: &str) -> NewPublication {
    NewPublication {
        id: PublicationId::seeded(key),
        record: ContentRecord::source(h(1), 48_000, renderer()).expect("valid"),
        retry_key: key.to_owned(),
        title: "door".into(),
        author: "pat".into(),
        evidence: None,
        manage_key_hash: None,
    }
}

fn flip(parent: &NewPublication, key: &str, cut_end: u32, out: u8) -> NewFlip {
    NewFlip {
        publication: NewPublication {
            id: PublicationId::seeded(key),
            record: ContentRecord::flip(
                parent.id.clone(),
                parent.record.output_blob(),
                Cut {
                    start: 0,
                    end: cut_end,
                },
                Transform {
                    p: 3,
                    q: 2,
                    method: METHOD_HERMITE,
                },
                renderer(),
                h(out),
            )
            .expect("valid"),
            retry_key: key.to_owned(),
            title: "slower".into(),
            author: "jo".into(),
            evidence: None,
            manage_key_hash: Some([7; 32]),
        },
        max_forks_per_stage_per_hour: 10_000,
        serialization_retries: 8,
        lock_wait: Duration::from_secs(10),
    }
}

/// A runtime and one database shared by every case of a property.
fn setup() -> (tokio::runtime::Runtime, TestDb) {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let db = rt.block_on(TestDb::create());
    (rt, db)
}

fn config(cases: u32) -> ProptestConfig {
    // No regression file: it would be written into the repository.
    ProptestConfig {
        cases,
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

#[test]
fn in_any_generated_forest_every_chain_is_whole_ordered_loop_free_and_counts_are_exact() {
    static CASE: AtomicU32 = AtomicU32::new(0);
    let (rt, db) = setup();
    let store: Store = db.store.clone();
    // Node i (i >= 1) names an earlier node as its parent, so a forest is a list of choices.
    let strategy = prop::collection::vec(0usize..1000, 1..=9);
    proptest!(config(12), |(choices in strategy)| {
        let case = CASE.fetch_add(1, Ordering::SeqCst);
        rt.block_on(async {
            let root = source(&format!("c{case}:n0"));
            store.create_publication(&root).await.expect("seed");
            let mut nodes = vec![root];
            let mut parent_of: Vec<Option<usize>> = vec![None];
            for (offset, choice) in choices.iter().enumerate() {
                let i = offset + 1;
                let parent = choice % i;
                let f = flip(&nodes[parent], &format!("c{case}:n{i}"), 24_000 + u32::try_from(i).expect("small"), u8::try_from(i).expect("small") + 10);
                match store.create_flip(&f).await.expect("create") {
                    FlipOutcome::Created(_) => {}
                    other => panic!("unexpected {other:?}"),
                }
                parent_of.push(Some(parent));
                nodes.push(f.publication);
            }
            for (i, node) in nodes.iter().enumerate() {
                // The model's chain: walk the parent indices to the root.
                let mut expected = vec![i];
                while let Some(p) = parent_of[*expected.last().expect("non-empty")] {
                    expected.push(p);
                }
                expected.reverse();
                let chain = store.chain(&node.id, 12).await.expect("read").expect("found");
                prop_assert_eq!(chain.truncated, None);
                prop_assert_eq!(chain.entries.len(), expected.len());
                let mut seen = std::collections::HashSet::new();
                for (k, entry) in chain.entries.iter().enumerate() {
                    let Entry::Present(stage) = entry else { panic!("a gap in a whole forest") };
                    prop_assert_eq!(&stage.id, &nodes[expected[k]].id);
                    prop_assert!(seen.insert(stage.id.clone()), "an id repeated: the chain loops");
                    let children = parent_of.iter().filter(|p| **p == Some(expected[k])).count();
                    prop_assert_eq!(stage.flipped_count as usize, children);
                    prop_assert_eq!(stage.record.parent().is_none(), k == 0, "only the first entry is a source");
                }
            }
            Ok(())
        })?;
    });
    rt.block_on(db.drop_db());
}

#[test]
fn under_generated_concurrent_requests_each_key_has_one_winner_and_every_other_answer_agrees() {
    static CASE: AtomicU32 = AtomicU32::new(0);
    let (rt, db) = setup();
    let store: Store = db.store.clone();
    // Each request is (key index 0..3, payload index 0..3); the payload is the cut's end.
    let strategy = prop::collection::vec((0usize..3, 0usize..3), 2..=8);
    proptest!(config(10), |(requests in strategy)| {
        let case = CASE.fetch_add(1, Ordering::SeqCst);
        rt.block_on(async {
            let root = source(&format!("i{case}:root"));
            store.create_publication(&root).await.expect("seed");
            let tasks: Vec<_> = requests
                .iter()
                .map(|(key, payload)| {
                    let store = store.clone();
                    let f = flip(&root, &format!("i{case}:key{key}"), 24_000 + u32::try_from(*payload).expect("small"), u8::try_from(*payload).expect("small") + 10);
                    tokio::spawn(async move { store.create_flip(&f).await })
                })
                .collect();
            let mut outcomes = Vec::new();
            for t in tasks {
                outcomes.push(t.await.expect("task").expect("no request may fail"));
            }
            // Group by key and check the model: one Created per key used; its payload wins.
            let mut by_key: HashMap<usize, Vec<(usize, &FlipOutcome)>> = HashMap::new();
            for ((key, payload), outcome) in requests.iter().zip(&outcomes) {
                by_key.entry(*key).or_default().push((*payload, outcome));
            }
            for (key, entries) in &by_key {
                let created: Vec<_> = entries.iter().filter(|(_, o)| matches!(o, FlipOutcome::Created(_))).collect();
                prop_assert_eq!(created.len(), 1, "key {} must have exactly one winner: {:?}", key, entries);
                let winner = created[0].0;
                for (payload, outcome) in entries {
                    match outcome {
                        FlipOutcome::Created(_) => {}
                        FlipOutcome::Existing(_) => prop_assert_eq!(*payload, winner, "a replay must carry the winner's payload"),
                        FlipOutcome::KeyConflict => prop_assert_ne!(*payload, winner, "only a different payload may conflict"),
                        other => panic!("unexpected {other:?}"),
                    }
                }
                let stored: i32 = sqlx::query_scalar(
                    "SELECT c.cut_end FROM publications p JOIN content_records c ON c.id = p.content_id WHERE p.retry_key = $1",
                )
                .bind(format!("i{case}:key{key}"))
                .fetch_one(store.pool())
                .await
                .expect("stored");
                prop_assert_eq!(stored, 24_000 + i32::try_from(winner).expect("small"));
            }
            let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM publications WHERE retry_key LIKE $1")
                .bind(format!("i{case}:key%"))
                .fetch_one(store.pool())
                .await
                .expect("count");
            prop_assert_eq!(rows as usize, by_key.len(), "one publication per key used");
            Ok(())
        })?;
    });
    rt.block_on(db.drop_db());
}
