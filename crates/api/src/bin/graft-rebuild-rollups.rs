//! Rebuilds the hourly rollups from the events ledger and swaps them in. Run it after a change to
//! how events are counted, or if the rollups are ever in doubt; the ledger is the source of truth.
//! Safe while the service runs: consumers wait for the swap and lose nothing. Hours older than the
//! raw events' retention window cannot be recounted and are kept as they are.
//! Reads the same configuration as the service (the database).
#![allow(clippy::print_stdout)] // a command-line tool: output is its interface

use graft_api::config::Config;
use graft_storage::Store;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let store = Store::connect(&config.database_url, 2).await?;
    store.migrate().await?;
    let rebuilt = store.rebuild_rollups().await?;
    println!(
        "rebuilt rollups from {} events: {} rows",
        rebuilt.events, rebuilt.rows
    );
    Ok(())
}
