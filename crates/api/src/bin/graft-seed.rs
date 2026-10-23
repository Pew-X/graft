//! Seeds one source: `graft-seed --audio FILE --key KEY --title T --author A --licence L [--work-title T]
//! [--work-author A] [--url U]`. Reads GRAFT_DATABASE_URL, GRAFT_RENDERER_WASM and a blob store
//! (GRAFT_BLOB_DIR, or the GRAFT_BLOB_S3_* settings).
//! Running it again with the same key and audio changes nothing.
#![allow(clippy::print_stdout)]

use graft_api::config::Config;
use graft_api::seed::{SeedSource, seed_source};
use graft_domain::chain::SourceEvidence;
use graft_domain::hash::Sha256Hash;
use graft_domain::record::RendererIdentity;
use graft_render_host::{Limits as HostLimits, Render, RenderHost};
use graft_storage::{Outcome, Store};
use std::collections::HashMap;

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
    let need = |k: &str| {
        a.get(k)
            .cloned()
            .ok_or_else(|| format!("--{k} is required"))
    };
    let config = Config::from_env()?;
    let wasm_path =
        std::env::var("GRAFT_RENDERER_WASM").map_err(|_| "GRAFT_RENDERER_WASM is required")?;
    if config.s3.is_none() && config.blob_dir.is_none() {
        return Err("configure GRAFT_BLOB_DIR or the GRAFT_BLOB_S3_* settings: seeding into memory would keep nothing".into());
    }
    let host = RenderHost::load(&std::fs::read(wasm_path)?, HostLimits::default())?;
    let id = host.identity();
    let renderer = RendererIdentity {
        name: id.name.to_owned(),
        version: id.version,
        wasm_sha256: Sha256Hash::parse(&id.wasm_sha256)?,
    };
    let store = Store::connect_waiting(
        &config.database_url,
        2,
        std::time::Duration::from_secs(config.db_startup_wait_secs),
    )
    .await?;
    store.migrate().await?;
    let blobs = graft_api::blobs::build_blob_store(&config)?;
    let source = SeedSource {
        key: need("key")?,
        title: need("title")?,
        author: need("author")?,
        evidence: SourceEvidence {
            licence: need("licence")?,
            work_title: a.get("work-title").cloned(),
            work_author: a.get("work-author").cloned(),
            url: a.get("url").cloned(),
            declaration: None,
        },
        audio: std::fs::read(need("audio")?)?,
        renderer,
    };
    let outcome = seed_source(&store, blobs.as_ref(), &config.limits, source).await?;
    match outcome {
        Outcome::Created(s) => println!("created {}", s.id),
        Outcome::Existing(s) => println!("already there {}", s.id),
        Outcome::KeyConflict => println!("conflict"),
    }
    Ok(())
}
