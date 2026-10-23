#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The database client can speak TLS. RDS (PostgreSQL 15 and later) and Neon refuse a connection
//! that does not, so a build without TLS support cannot connect to either. The local development
//! server does not offer TLS, which is what makes this check possible without a certificate: when
//! the URL says `sslmode=require`, a client that can speak TLS asks the server, hears "no", and says
//! so; a client built without TLS support stops before it asks and says that instead.
//! `scripts/tls-database-check.sh` runs the same client against a server that does offer TLS.

use graft_storage::Store;

fn url() -> String {
    std::env::var("GRAFT_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:graft@127.0.0.1:55432/postgres".to_owned())
}

#[tokio::test]
async fn the_client_is_built_with_tls_and_asks_the_server_for_it() {
    let required = format!("{}?sslmode=require", url());
    let Err(err) = Store::connect(&required, 1).await else {
        panic!("a server without TLS must be refused when TLS is required");
    };
    let said = err.to_string();
    assert!(
        !said.contains("without TLS support"),
        "the client was built without TLS support, so it cannot reach a database that requires it: {said}"
    );
    assert!(
        said.to_lowercase().contains("tls"),
        "expected the refusal to be about TLS, got: {said}"
    );
}
