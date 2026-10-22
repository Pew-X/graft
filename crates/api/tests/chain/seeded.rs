//! The seeded chain: made through the publish pipeline, the same in every environment, and shipped
//! as a static snapshot that cannot drift. Each test names the guarantee it protects.

use super::common::Harness;
use graft_api::seed::{Manifest, parse_manifest, seed_chain};
use graft_api::snapshot::{self, AUDIO_DIR, DATA_FILE, Snapshot};
use graft_domain::hash::Sha256Hash;
use graft_render_host::{Method, Ratio, Render};
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn manifest() -> (Manifest, Vec<u8>) {
    let text = std::fs::read_to_string(root().join("seed/chain.json")).expect("manifest");
    let manifest = parse_manifest(&text).expect("a valid manifest");
    let audio =
        std::fs::read(root().join("seed").join(&manifest.source.audio_file)).expect("audio");
    (manifest, audio)
}

async fn seeded(
    h: &Harness,
    manifest: &Manifest,
    audio: &[u8],
) -> (Snapshot, Vec<snapshot::AudioFile>, Vec<String>) {
    let ids = seed_chain(&h.state, manifest, audio.to_vec())
        .await
        .expect("seeded");
    let leaf = ids.last().expect("a leaf");
    let (snap, files) = snapshot::build(&h.state, leaf).await.expect("snapshot");
    (snap, files, ids.iter().map(ToString::to_string).collect())
}

fn committed() -> Snapshot {
    serde_json::from_str(
        &std::fs::read_to_string(root().join("web").join(DATA_FILE)).expect("committed snapshot"),
    )
    .expect("a valid snapshot")
}

#[tokio::test]
async fn running_the_seed_twice_yields_exactly_one_chain() {
    let h = Harness::new().await;
    let (manifest, audio) = manifest();
    let (_, _, first) = seeded(&h, &manifest, &audio).await;
    let (_, _, second) = seeded(&h, &manifest, &audio).await;
    assert_eq!(first, second, "the same ids both times");
    assert_eq!(
        h.count("publications").await,
        4,
        "one source and three flips"
    );
    assert_eq!(h.count("content_records").await, 4);
    // Read back through the API: the chain is four stages, source first.
    let (status, _, chain) = h
        .send("GET", &format!("/v1/chains/{}", first[3]), &[], None)
        .await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(chain["stages"].as_array().expect("stages").len(), 4);
    h.finish().await;
}

/// The expected hashes in the manifest were worked out by the independent reference renderer, and
/// the publish path cross-checks against them, so a stage stored here was rendered by the real path
/// and equals what the independent implementation says it should be.
#[tokio::test]
async fn each_seeded_stage_equals_the_independent_reference_render_of_its_recorded_cut_and_ratio() {
    let h = Harness::new().await;
    let (manifest, audio) = manifest();
    let (snap, _, _) = seeded(&h, &manifest, &audio).await;
    for (flip, stage) in manifest.flips.iter().zip(&snap.stages[1..]) {
        assert_eq!(
            stage.output_blob, flip.expected_output_sha256,
            "{}: stored audio is the reference render",
            flip.key
        );
        assert_eq!(
            (stage.cut_start, stage.cut_end),
            (flip.cut.start, flip.cut.end)
        );
        assert_eq!(
            (stage.speed_p, stage.speed_q),
            (Some(flip.speed.p), Some(flip.speed.q))
        );
    }
    // And the manifest's own source file is the source stage, byte for byte.
    assert_eq!(snap.stages[0].output_blob, Sha256Hash::of(&audio).to_hex());
    h.finish().await;
}

#[tokio::test]
async fn a_flip_whose_render_differs_from_the_reference_is_not_seeded() {
    let h = Harness::new().await;
    let (mut manifest, audio) = manifest();
    manifest.flips[0].expected_output_sha256 = "0".repeat(64);
    let err = seed_chain(&h.state, &manifest, audio)
        .await
        .expect_err("refused");
    assert!(
        err.to_string()
            .contains("differs from the independent reference"),
        "{err}"
    );
    h.finish().await;
}

#[tokio::test]
async fn two_independent_fresh_databases_give_identical_ids_hashes_and_snapshot() {
    let (manifest, audio) = manifest();
    let a = Harness::new().await;
    let b = Harness::new().await;
    // Seed them at different times, in different order of other work.
    b.seed("seed:unrelated", 9).await;
    a.clock.advance(100_000.0);
    let (snap_a, files_a, ids_a) = seeded(&a, &manifest, &audio).await;
    let (snap_b, files_b, ids_b) = seeded(&b, &manifest, &audio).await;
    assert_eq!(ids_a, ids_b);
    assert_eq!(snapshot::to_text(&snap_a), snapshot::to_text(&snap_b));
    assert_eq!(files_a, files_b);
    a.finish().await;
    b.finish().await;
}

/// The guarantee, not a convention: the snapshot committed with the web app is exactly what a freshly
/// seeded database produces, audio included.
#[tokio::test]
async fn the_committed_snapshot_equals_what_a_freshly_seeded_database_produces() {
    let h = Harness::new().await;
    let (manifest, audio) = manifest();
    let (fresh, files, _) = seeded(&h, &manifest, &audio).await;
    let diff = snapshot::differences(&committed(), &fresh);
    assert!(
        diff.is_empty(),
        "the snapshot has drifted; run `graft-seed-chain --write-snapshot web` and commit it:\n{}",
        diff.join("\n")
    );
    let on_disk = std::fs::read_to_string(root().join("web").join(DATA_FILE)).expect("file");
    assert_eq!(on_disk, snapshot::to_text(&fresh), "byte for byte");
    for f in &files {
        let bytes = std::fs::read(root().join("web").join(AUDIO_DIR).join(&f.name))
            .unwrap_or_else(|_| panic!("the audio file {} is committed", f.name));
        assert_eq!(bytes, f.bytes, "{}", f.name);
    }
    h.finish().await;
}

/// Change a seeded flip's cut and the check fails, naming the stage; the real manifest passes.
#[tokio::test]
async fn changing_a_seeded_flips_cut_makes_the_check_fail_naming_the_stage() {
    let h = Harness::new().await;
    let (mut manifest, audio) = manifest();
    // The last flip (stage 4) cuts a different range. Its expected hash must follow, or the seed
    // refuses first (which is its own guard): work it out with the renderer directly.
    let parent = &manifest.flips[1];
    let parent_audio = std::fs::read(
        root()
            .join("web")
            .join(AUDIO_DIR)
            .join(format!("{}.pcm", parent.expected_output_sha256)),
    )
    .expect("stage 3 audio");
    let samples: Vec<i16> = parent_audio
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let (start, end) = (4_800usize, 33_000usize);
    let out = super::common::host()
        .render(&samples[start..end], Ratio { p: 1, q: 2 }, Method::Hermite)
        .expect("render");
    let bytes: Vec<u8> = out.iter().flat_map(|s| s.to_le_bytes()).collect();
    manifest.flips[2].cut.end = end as u32;
    manifest.flips[2].expected_output_sha256 = Sha256Hash::of(&bytes).to_hex();
    let (fresh, _, _) = seeded(&h, &manifest, &audio).await;
    let diff = snapshot::differences(&committed(), &fresh);
    assert!(!diff.is_empty(), "the drift must be seen");
    assert!(
        diff.iter()
            .any(|l| l.starts_with("stage 4 ") && l.contains("cut")),
        "the message names the stage and what changed: {diff:#?}"
    );
    assert!(
        !diff
            .iter()
            .any(|l| l.starts_with("stage 1 ") || l.starts_with("stage 2 ")),
        "stages before the change are untouched: {diff:#?}"
    );
    h.finish().await;
}

#[tokio::test]
async fn the_snapshot_holds_no_manage_key_no_secret_and_no_time_that_varies() {
    let h = Harness::new().await;
    let (manifest, audio) = manifest();
    let (fresh, _, _) = seeded(&h, &manifest, &audio).await;
    let text = snapshot::to_text(&fresh);
    let value: serde_json::Value = serde_json::from_str(&text).expect("json");
    // Exactly the documented fields, so nothing else can slip in unnoticed.
    let allowed = [
        "id",
        "kind",
        "title",
        "author",
        "parent_id",
        "lines",
        "record_id",
        "source_blob",
        "output_blob",
        "cut_start",
        "cut_end",
        "speed_p",
        "speed_q",
        "renderer",
        "renderer_wasm_sha256",
        "frames",
        "audio_path",
    ];
    for stage in value["stages"].as_array().expect("stages") {
        let mut keys: Vec<&str> = stage
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut want = allowed.to_vec();
        want.sort_unstable();
        assert_eq!(keys, want);
    }
    for needle in [
        "manage", "secret", "admin", "key", "created", "expires", "http",
    ] {
        assert!(!text.contains(needle), "{needle} appears in the snapshot");
    }
    // The seeded stages have no manage key at all: nobody can manage them.
    let keyed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM publications WHERE manage_key_hash IS NOT NULL")
            .fetch_one(h.db.store.pool())
            .await
            .expect("count");
    assert_eq!(keyed, 0);
    h.finish().await;
}
