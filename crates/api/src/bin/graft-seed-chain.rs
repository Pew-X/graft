//! Seeds the chain the roll opens on and writes or checks its static snapshot.
//!
//!   graft-seed-chain [--manifest seed/chain.json] [--sources seed/sources.json] [--write-snapshot web | --check-snapshot web]
//!
//! The chain is seeded through the publish pipeline every visitor uses (see ARCHITECTURE.md, "First open and the static snapshot"), into
//! the database and blob store the usual settings name, so it needs a renderer artefact too
//! (`GRAFT_RENDERER_WASM`). Running it again changes nothing. `--check-snapshot` exits with an
//! error naming the stage if the committed snapshot differs from what this database produced: point
//! it at a freshly created database to ask whether the snapshot has drifted.
//!
//! It also seeds the curated sources (`seed/sources.json` beside the manifest, unless `--sources`
//! names another file); the chain's own source is one of them, so it is not made twice.
#![allow(clippy::print_stdout, clippy::print_stderr)] // a command-line tool: output is its interface

use graft_api::config::Config;
use graft_api::http::AppState;
use graft_api::seed::{parse_curated, parse_manifest, seed_chain, seed_curated};
use graft_api::snapshot::{self, AUDIO_DIR, DATA_FILE, SOURCES_FILE};
use graft_render_host::{Limits as HostLimits, RenderHost};
use graft_storage::Store;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn args() -> Result<HashMap<String, String>, String> {
    let mut map = HashMap::new();
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let name = flag
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {flag}"))?;
        let value = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
        map.insert(name.to_owned(), value);
    }
    Ok(map)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a = args()?;
    let manifest_path = PathBuf::from(a.get("manifest").map_or("seed/chain.json", String::as_str));
    let config = Config::from_env()?;
    if config.s3.is_none() && config.blob_dir.is_none() {
        return Err("configure GRAFT_BLOB_DIR or the GRAFT_BLOB_S3_* settings: seeding into memory would keep nothing".into());
    }
    let wasm_path =
        std::env::var("GRAFT_RENDERER_WASM").map_err(|_| "GRAFT_RENDERER_WASM is required")?;
    let host = RenderHost::load(&std::fs::read(wasm_path)?, HostLimits::default())?;
    let store = Store::connect_waiting(
        &config.database_url,
        4,
        std::time::Duration::from_secs(config.db_startup_wait_secs),
    )
    .await?;
    store.migrate().await?;
    let blobs = graft_api::blobs::build_blob_store(&config)?;
    let state = AppState::new(&config, store, blobs, Arc::new(host));

    let manifest = parse_manifest(&std::fs::read_to_string(&manifest_path)?)?;
    let dir = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let audio = std::fs::read(dir.join(&manifest.source.audio_file))?;
    let ids = seed_chain(&state, &manifest, audio).await?;
    println!(
        "seeded {} stages: {}",
        ids.len(),
        ids.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(" ")
    );
    let sources_path = a
        .get("sources")
        .map_or_else(|| dir.join("sources.json"), PathBuf::from);
    let mut curated_ids = None;
    if sources_path.exists() {
        let curated = parse_curated(&std::fs::read_to_string(&sources_path)?)?;
        let ids = seed_curated(&state, &curated, dir).await?;
        println!("seeded {} curated sources", ids.len());
        curated_ids = Some(ids);
    }
    let leaf = ids.last().ok_or("the manifest seeds nothing")?;
    let (fresh, mut files) = snapshot::build(&state, leaf).await?;
    // The curated sources, when there are any: the same format, each stage a source.
    let sources = match &curated_ids {
        Some(ids) => {
            let (snap, found) = snapshot::build_sources(&state, ids).await?;
            for f in found {
                if !files.iter().any(|g| g.name == f.name) {
                    files.push(f);
                }
            }
            Some(snap)
        }
        None => None,
    };
    let snapshots: Vec<(&str, &snapshot::Snapshot)> = std::iter::once((DATA_FILE, &fresh))
        .chain(sources.iter().map(|s| (SOURCES_FILE, s)))
        .collect();

    if let Some(web) = a.get("write-snapshot") {
        let web = Path::new(web);
        for (file, snap) in &snapshots {
            let data = web.join(file);
            std::fs::create_dir_all(data.parent().unwrap_or(web))?;
            std::fs::write(&data, snapshot::to_text(snap))?;
            println!("wrote {}", data.display());
        }
        let audio_dir = web.join(AUDIO_DIR);
        std::fs::create_dir_all(&audio_dir)?;
        for old in std::fs::read_dir(&audio_dir)? {
            let old = old?;
            if old.path().extension().is_some_and(|e| e == "pcm")
                && !files
                    .iter()
                    .any(|f| old.file_name().to_string_lossy() == f.name)
            {
                std::fs::remove_file(old.path())?;
            }
        }
        for f in &files {
            std::fs::write(audio_dir.join(&f.name), &f.bytes)?;
        }
        println!("wrote {} audio files", files.len());
    }
    if let Some(web) = a.get("check-snapshot") {
        let web = Path::new(web);
        let mut problems = Vec::new();
        for (file, snap) in &snapshots {
            let committed: snapshot::Snapshot =
                serde_json::from_str(&std::fs::read_to_string(web.join(file))?)?;
            problems.extend(snapshot::differences(&committed, snap));
        }
        for f in &files {
            match std::fs::read(web.join(AUDIO_DIR).join(&f.name)) {
                Ok(bytes) if bytes == f.bytes => {}
                _ => problems.push(format!("the audio file {} is missing or differs", f.name)),
            }
        }
        if !problems.is_empty() {
            for p in &problems {
                eprintln!("snapshot drift: {p}");
            }
            return Err("the committed snapshot differs from a freshly seeded database".into());
        }
        println!("the committed snapshot matches a freshly seeded database");
    }
    Ok(())
}
