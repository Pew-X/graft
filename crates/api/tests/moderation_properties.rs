#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Moved here from the concurrency ticket, because the rule it checks exists here: for generated
//! forests and generated hide patterns, the real read path (router, store, view) equals a trivial
//! reference implementation of the rule, the chain is never shortened, audio is issued only for
//! stages that may be heard, and clearing every hide restores every stage.
//!
//! The reference model is written from the rule's wording, not from the implementation:
//! a hidden stage is "no longer here" with its own reason; otherwise a stage with any ancestor
//! hidden for rights is held; otherwise it is available.

mod common;

use common::Harness;
use graft_domain::ids::PublicationId;
use proptest::prelude::*;
use std::sync::atomic::{AtomicU32, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Flag {
    None,
    Withdrawn,
    Rights,
}

fn flag() -> impl Strategy<Value = Flag> {
    prop_oneof![
        3 => Just(Flag::None),
        1 => Just(Flag::Withdrawn),
        1 => Just(Flag::Rights),
    ]
}

/// What the rule says about stage `k` of a chain whose stages carry `flags` (source first).
fn reference(flags: &[Flag], k: usize) -> (&'static str, Option<&'static str>) {
    match flags[k] {
        Flag::Withdrawn => ("no_longer_here", Some("withdrawn")),
        Flag::Rights => ("no_longer_here", Some("rights")),
        Flag::None if flags[..k].contains(&Flag::Rights) => ("held", Some("rights")),
        Flag::None => ("available", None),
    }
}

#[test]
fn the_real_read_path_equals_the_reference_rule_for_any_forest_and_any_hide_pattern() {
    static CASE: AtomicU32 = AtomicU32::new(0);
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let h = rt.block_on(Harness::new());
    // Node i (i >= 1) names an earlier node as its parent; every node gets a flag.
    let strategy = (
        prop::collection::vec(0usize..1000, 1..=7),
        prop::collection::vec(flag(), 8),
    );
    let config = ProptestConfig {
        cases: 12,
        failure_persistence: None,
        ..ProptestConfig::default()
    };
    proptest!(config, |((choices, flags) in strategy)| {
        let case = CASE.fetch_add(1, Ordering::SeqCst);
        rt.block_on(async {
            let root = match h.seed(&format!("p{case}:n0"), 0).await {
                graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => s.id,
                graft_storage::Outcome::KeyConflict => panic!("conflict"),
            };
            let mut ids: Vec<PublicationId> = vec![root];
            let mut parent_of: Vec<Option<usize>> = vec![None];
            for (offset, choice) in choices.iter().enumerate() {
                let i = offset + 1;
                let parent = choice % i;
                let id = h.flip(&format!("p{case}:n{i}"), &ids[parent], u8::try_from(i).expect("small") + 10).await;
                ids.push(id);
                parent_of.push(Some(parent));
            }
            let flags = &flags[..ids.len()];
            for (id, f) in ids.iter().zip(flags) {
                let reason = match f {
                    Flag::None => None,
                    Flag::Withdrawn => Some("withdrawn"),
                    Flag::Rights => Some("rights"),
                };
                sqlx::query("UPDATE publications SET hidden_reason = $2 WHERE id = $1")
                    .bind(id.as_str())
                    .bind(reason)
                    .execute(h.db.store.pool())
                    .await
                    .expect("set the flag");
            }
            for (i, id) in ids.iter().enumerate() {
                // The model's chain: walk the parent indices to the root, then read source first.
                let mut path = vec![i];
                while let Some(p) = parent_of[*path.last().expect("non-empty")] {
                    path.push(p);
                }
                path.reverse();
                let path_flags: Vec<Flag> = path.iter().map(|k| flags[*k]).collect();
                let (_, _, chain) = h.get(&format!("/v1/chains/{id}")).await;
                let stages = chain["stages"].as_array().expect("stages");
                prop_assert_eq!(stages.len(), path.len(), "a hide must never shorten a chain");
                for (k, stage) in stages.iter().enumerate() {
                    let (state, reason) = reference(&path_flags, k);
                    prop_assert_eq!(stage["state"].as_str(), Some(state), "stage {} of node {}", k, i);
                    prop_assert_eq!(stage["reason"].as_str(), reason);
                    prop_assert_eq!(stage["id"].as_str(), Some(ids[path[k]].as_str()));
                    prop_assert_eq!(stage["audio"]["url"].is_string(), state == "available", "audio only for stages that may be heard");
                    prop_assert!(stage["title"].is_string(), "the credit text is always visible");
                }
            }
            // Reversible: with every hide cleared, every stage of every chain is available again.
            sqlx::query("UPDATE publications SET hidden_reason = NULL").execute(h.db.store.pool()).await.expect("clear");
            for id in &ids {
                let (_, _, chain) = h.get(&format!("/v1/chains/{id}")).await;
                let all_available = chain["stages"].as_array().expect("stages").iter().all(|s| s["state"] == "available");
                prop_assert!(all_available, "clearing the hides restores everything");
            }
            Ok(())
        })?;
    });
}
