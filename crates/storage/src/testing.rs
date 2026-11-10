//! Throwaway databases for tests: each test gets its own freshly migrated database on a server
//! named by `GRAFT_TEST_DATABASE_URL` (default: the local development container), so tests never
//! share state and never touch real data.

use crate::postgres::Store;
use sqlx::Connection;
use sqlx::postgres::PgConnection;

const DEFAULT_URL: &str = "postgres://postgres:graft@127.0.0.1:55432/postgres";

/// A migrated, private database.
pub struct TestDb {
    /// Connection string for this database.
    pub url: String,
    /// A store connected to it.
    pub store: Store,
    admin_url: String,
    name: String,
}

impl TestDb {
    /// Create and migrate a new database.
    ///
    /// # Panics
    /// Panics when the server is unreachable: a test that needs Postgres must not pass without it.
    #[allow(clippy::expect_used)]
    pub async fn create() -> Self {
        let admin_url =
            std::env::var("GRAFT_TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_owned());
        let mut bytes = [0u8; 8];
        getrandom_fill(&mut bytes);
        let name = format!(
            "graft_test_{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let mut admin = PgConnection::connect(&admin_url).await.expect(
            "a test Postgres must be reachable (GRAFT_TEST_DATABASE_URL, default 127.0.0.1:55432)",
        );
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&mut admin)
            .await
            .expect("create database");
        let url = match admin_url.rsplit_once('/') {
            Some((base, _)) => format!("{base}/{name}"),
            None => admin_url.clone(),
        };
        let store = Store::connect(&url, 16)
            .await
            .expect("connect to the test database");
        store.migrate().await.expect("migrate");
        Self {
            url,
            store,
            admin_url,
            name,
        }
    }

    /// Drop the database. Call at the end of a test; a panic before it leaves one database behind,
    /// which the next run's name makes harmless.
    #[allow(clippy::expect_used)]
    pub async fn drop_db(self) {
        self.store.pool().close().await;
        let mut admin = PgConnection::connect(&self.admin_url)
            .await
            .expect("admin connection");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        )))
        .execute(&mut admin)
        .await
        .expect("drop database");
    }
}

fn getrandom_fill(bytes: &mut [u8; 8]) {
    // Process-unique enough for a database name: time and a counter, no extra dependency.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    let n = nanos ^ (COUNTER.fetch_add(1, Ordering::Relaxed) << 48) ^ u64::from(std::process::id());
    bytes.copy_from_slice(&n.to_be_bytes());
}
