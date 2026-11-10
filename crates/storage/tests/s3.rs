#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The S3-compatible client against a real S3-compatible server (a local container in
//! development, a service container in CI): the same contract as the fakes, plus what only a real
//! server can show: signed URLs, their expiry, refused credentials, and damaged objects.
//!
//! A server is expected at `GRAFT_TEST_S3_ENDPOINT` (default `http://127.0.0.1:59000`) with the
//! bucket `graft-test` and the credentials in `README.md`; each test works under its own random key
//! prefix, so tests never see each other's objects.

mod blob_contract;

use blob_contract::{Time, run};
use graft_domain::hash::Sha256Hash;
use graft_storage::{BlobError, BlobStore, S3BlobStore, S3Config};
use object_store::ObjectStoreExt;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ENDPOINT: &str = "http://127.0.0.1:59000";
const KEY_ID: &str = "graftaccess";
const SECRET: &str = "graftsecret12345";

fn endpoint() -> String {
    std::env::var("GRAFT_TEST_S3_ENDPOINT").unwrap_or_else(|_| ENDPOINT.to_owned())
}

fn prefix() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!(
        "t{nanos}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

fn config(prefix: &str) -> S3Config {
    let mut c = S3Config::new(Some(endpoint()), "graft-test", "us-east-1", KEY_ID, SECRET);
    c.allow_http = true;
    c.prefix = Some(prefix.to_owned());
    c.refresh_after = Duration::from_secs(1);
    c
}

fn store(prefix: &str) -> S3BlobStore {
    S3BlobStore::new(&config(prefix)).expect("build the client")
}

/// A minimal HTTP/1.1 GET over a plain socket, so the test needs no HTTP client: signed URLs are
/// meant for browsers, and this fetches one the way a browser would, with no credentials.
async fn http_get(url: &str) -> (u16, Vec<u8>) {
    let rest = url.strip_prefix("http://").expect("an http URL");
    let (host, path) = rest.split_once('/').expect("a path");
    let mut stream = tokio::net::TcpStream::connect(host).await.expect("connect");
    let request = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a header block");
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("a status");
    let mut body = raw[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    (status, body)
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let eol = data
            .windows(2)
            .position(|w| w == b"\r\n")
            .expect("chunk size line");
        let size =
            usize::from_str_radix(std::str::from_utf8(&data[..eol]).expect("utf-8").trim(), 16)
                .expect("hex size");
        data = &data[eol + 2..];
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

#[tokio::test]
async fn the_s3_store_meets_the_contract() {
    // S3 reports last-modified times in whole seconds, so the refresh test waits a little over one.
    run(
        Arc::new(store(&prefix())),
        Time::Real,
        Duration::from_secs(1),
        Duration::from_secs(1),
    )
    .await;
}

#[tokio::test]
async fn a_signed_url_serves_the_bytes_without_credentials_and_stops_working_after_its_lifetime() {
    let s = store(&prefix());
    let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    let hash = s.put_if_absent(data.clone()).await.expect("put");
    let url = s
        .signed_url(hash, Duration::from_secs(2))
        .await
        .expect("sign");

    assert!(
        !url.contains(SECRET),
        "the secret key must never be part of a URL"
    );
    let (status, body) = http_get(&url).await;
    assert_eq!(status, 200, "a fresh signed URL serves the audio");
    assert_eq!(body, data);

    // Another object's name under the same signature does not work: the URL grants one object.
    let other = Sha256Hash::of(b"another blob");
    let forged = url.replace(&hash.to_hex(), &other.to_hex());
    assert_ne!(
        http_get(&forged).await.0,
        200,
        "a signature covers exactly one object"
    );

    tokio::time::sleep(Duration::from_secs(3)).await;
    let (status, _) = http_get(&url).await;
    assert_ne!(
        status, 200,
        "an issued URL stops working after its lifetime (got {status})"
    );
}

#[tokio::test]
async fn refused_credentials_give_a_class_of_error_and_leak_nothing() {
    let mut bad = S3Config::new(
        Some(endpoint()),
        "graft-test",
        "us-east-1",
        KEY_ID,
        "the-wrong-secret-0000",
    );
    bad.allow_http = true;
    bad.prefix = Some(prefix());
    let s = S3BlobStore::new(&bad).expect("building does not contact the server");
    let err = s
        .put_if_absent(vec![1, 2, 3])
        .await
        .expect_err("the server refuses the credentials");
    assert_eq!(
        err,
        BlobError::Store("access denied".to_owned()),
        "a class of failure, nothing more"
    );
    let everything = format!("{err} {err:?} {s:?} {bad:?}");
    for secret in [
        "the-wrong-secret-0000",
        SECRET,
        KEY_ID,
        "127.0.0.1",
        "59000",
    ] {
        assert!(
            !everything.contains(secret),
            "{secret:?} leaked into: {everything}"
        );
    }
}

#[tokio::test]
async fn an_unreachable_server_is_an_error_that_does_not_name_it() {
    let mut c = config(&prefix());
    c.endpoint = Some("http://127.0.0.1:1".to_owned());
    let s = S3BlobStore::new(&c).expect("build");
    let err = s
        .get(Sha256Hash::of(b"x"))
        .await
        .expect_err("nothing listens there");
    assert!(matches!(err, BlobError::Store(_)));
    assert!(
        !format!("{err} {err:?}").contains("127.0.0.1"),
        "the endpoint must not appear in an error"
    );
}

#[tokio::test]
async fn an_object_whose_bytes_do_not_match_its_name_is_never_served() {
    let p = prefix();
    let s = store(&p);
    let hash = s.put_if_absent(vec![1, 2, 3]).await.expect("put");
    // Another client writes different bytes under the same name.
    let raw = AmazonS3Builder::new()
        .with_endpoint(endpoint())
        .with_bucket_name("graft-test")
        .with_region("us-east-1")
        .with_access_key_id(KEY_ID)
        .with_secret_access_key(SECRET)
        .with_allow_http(true)
        .with_virtual_hosted_style_request(false)
        .build()
        .expect("raw client");
    raw.put(
        &Path::from(format!("{p}/{}", hash.to_hex())),
        vec![9, 9, 9].into(),
    )
    .await
    .expect("tamper");
    assert_eq!(s.get(hash).await, Err(BlobError::Damaged));
}

#[tokio::test]
async fn stores_with_different_prefixes_do_not_see_each_other() {
    let (a, b) = (store(&prefix()), store(&prefix()));
    let in_a = a.put_if_absent(vec![4, 4, 4]).await.expect("put");
    let in_b = b.put_if_absent(vec![5, 5, 5]).await.expect("put");
    let seen_by_a: Vec<_> = a
        .list()
        .await
        .expect("list")
        .into_iter()
        .map(|i| i.hash)
        .collect();
    assert_eq!(seen_by_a, vec![in_a]);
    assert_eq!(a.get(in_b).await.expect("get"), None);
}

#[tokio::test]
async fn a_store_does_not_list_objects_that_belong_to_a_longer_prefix() {
    // One store at `p` and another at `p/inner`: a listing is recursive, so the first must not see
    // (and the cleanup must never try to delete) the second's objects.
    let outer = prefix();
    let (a, b) = (store(&outer), store(&format!("{outer}/inner")));
    let mine = a.put_if_absent(vec![1, 1, 1]).await.expect("put");
    let theirs = b.put_if_absent(vec![2, 2, 2]).await.expect("put");
    let seen_by_a: Vec<_> = a
        .list()
        .await
        .expect("list")
        .into_iter()
        .map(|i| i.hash)
        .collect();
    assert_eq!(seen_by_a, vec![mine]);
    let seen_by_b: Vec<_> = b
        .list()
        .await
        .expect("list")
        .into_iter()
        .map(|i| i.hash)
        .collect();
    assert_eq!(seen_by_b, vec![theirs]);
}

/// A stand-in for the container credentials endpoint (what ECS and EKS provide): it answers every
/// request with credentials and remembers the Authorization header it was sent. Its session token is
/// empty because the local test server checks tokens against its own store and refuses any other; a
/// real role's token travels with every request and is accepted by S3, which this test cannot show.
async fn fake_credentials_endpoint(
    access_key_id: &str,
    secret: &str,
) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let url = format!(
        "http://{}/credentials",
        listener.local_addr().expect("addr")
    );
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (key, secret, log) = (access_key_id.to_owned(), secret.to_owned(), seen.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let auth = request
                .lines()
                .find_map(|l| {
                    l.strip_prefix("authorization: ")
                        .or_else(|| l.strip_prefix("Authorization: "))
                })
                .unwrap_or("")
                .to_owned();
            log.lock().expect("lock").push(auth);
            let expiry = "2099-01-01T00:00:00Z";
            let body = format!(
                r#"{{"AccessKeyId":"{key}","SecretAccessKey":"{secret}","Token":"","Expiration":"{expiry}"}}"#
            );
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        }
    });
    (url, seen)
}

#[tokio::test]
async fn a_task_role_supplies_the_credentials_and_the_store_works_without_static_keys() {
    let (url, seen) = fake_credentials_endpoint(KEY_ID, SECRET).await;
    let token_file = std::env::temp_dir().join(format!("graft-token-{}", prefix()));
    std::fs::write(&token_file, "the-pod-token").expect("write the token file");
    let mut c = S3Config::container(
        Some(endpoint()),
        "graft-test",
        "us-east-1",
        None,
        Some(url),
        Some(token_file.to_string_lossy().into_owned()),
    );
    c.allow_http = true;
    c.prefix = Some(prefix());
    let store = S3BlobStore::new(&c).expect("build the client");
    let bytes = b"audio written with credentials the platform handed out".to_vec();
    let hash = store.put_if_absent(bytes.clone()).await.expect("put");
    assert_eq!(store.get(hash).await.expect("get"), Some(bytes));
    let asked = seen.lock().expect("lock").clone();
    assert!(
        !asked.is_empty(),
        "the store never asked the credentials endpoint"
    );
    assert!(
        asked.iter().all(|a| a == "the-pod-token"),
        "the endpoint was not given the token: {asked:?}"
    );
    let _ = std::fs::remove_file(token_file);
}
