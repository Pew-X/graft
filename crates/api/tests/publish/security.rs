//! The service as an attacker meets it, over HTTP, against a real Postgres: what every route
//! answers with no credentials, what hostile bodies get, what leaks in an error, how long a stalled
//! client may hold a request, and what the public text rules do with look-alike and control text.
//! Each test names the guarantee it protects.

use super::common::Harness;
use super::{body, source};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

/// One probe: a method, an address, headers and a body.
type Probe = (String, String, Vec<(&'static str, &'static str)>, Vec<u8>);
/// A route to walk: a method, an address with the id filled in, and the headers it needs.
type Walk = (&'static str, String, Vec<(&'static str, &'static str)>);

const SECRET: &str = "an-operator-secret-0123456789";
const ADMIN: &str = "x-graft-admin-secret";
const MANAGE: &str = "x-graft-manage-key";

async fn harness(tweak: impl FnOnce(&mut graft_api::config::Config)) -> Harness {
    Harness::configured(|c| {
        c.admin_secret = Some(SECRET.to_owned());
        tweak(c);
    })
    .await
}

/// Every route the service has: the public interface document's, and the operator's, which that
/// document leaves out on purpose. The cross-check below reads `http.rs`, so a route added there
/// without a row here fails.
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/health"),
    ("GET", "/ready"),
    ("GET", "/metrics"),
    ("GET", "/openapi.json"),
    ("GET", "/v1/chains/{id}"),
    ("GET", "/v1/publications/{id}"),
    ("GET", "/v1/publications/{id}/flips"),
    ("POST", "/v1/publications"),
    ("GET", "/v1/features"),
    ("POST", "/v1/sources"),
    ("POST", "/v1/reports"),
    ("POST", "/v1/events"),
    ("PUT", "/v1/publications/{id}/fork-permission"),
    ("PUT", "/v1/publications/{id}/note"),
    ("POST", "/v1/publications/{id}/withdraw"),
    ("GET", "/admin/reports"),
    ("GET", "/admin/rollups"),
    ("GET", "/admin/switch"),
    ("PUT", "/admin/switch"),
    ("POST", "/admin/publications/{id}/hide"),
    ("DELETE", "/admin/publications/{id}/hide"),
];

/// The routes that need the operator's secret.
fn is_admin(path: &str) -> bool {
    // `/metrics` is the operator's too: it runs a database query on every read.
    path.starts_with("/admin/") || path == "/metrics"
}
/// The routes that need a publication's manage key.
fn is_maker(path: &str) -> bool {
    path.ends_with("/fork-permission") || path.ends_with("/withdraw") || path.ends_with("/note")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn every_route_in_the_router_and_the_interface_document_has_a_row() {
    // The public document: every path and method.
    let doc = graft_api::openapi::document();
    for (path, item) in doc["paths"].as_object().expect("paths") {
        for method in item.as_object().expect("operations").keys() {
            assert!(
                ROUTES
                    .iter()
                    .any(|(m, p)| m.eq_ignore_ascii_case(method) && p == path),
                "{method} {path} is in the interface document and has no row in ROUTES"
            );
        }
    }
    // The operator's routes are not in that document, so read them from the router's source: each
    // `"/admin/..."` path literal must be in the table.
    let source = include_str!("../../src/http.rs");
    for literal in source.split('"').filter(|s| s.starts_with("/admin/")) {
        assert!(
            ROUTES.iter().any(|(_, p)| p == &literal),
            "{literal} is a route in http.rs and has no row in ROUTES"
        );
    }
}

#[tokio::test]
async fn no_operator_route_answers_without_the_secret_and_every_refusal_is_the_same() {
    // Raise the failed-attempt limit so the whole table can be walked from one address.
    let h = harness(|c| c.guardrails.admin_failures_per_ip.count = 1_000_000).await;
    let parent = source(&h).await;
    for (method, template) in ROUTES.iter().filter(|(_, p)| is_admin(p)) {
        let uri = template.replace("{id}", &parent);
        let mut seen: Vec<(StatusCode, Vec<u8>)> = Vec::new();
        for headers in [
            vec![],
            vec![(ADMIN, "")],
            vec![(ADMIN, "wrong")],
            vec![(ADMIN, "an-operator-secret-012345678")], // one character short
            vec![(ADMIN, "an-operator-secret-01234567890")], // one character over
            vec![(MANAGE, SECRET)],                        // the right value in the wrong header
        ] {
            let (status, _, bytes) = h
                .send_bytes(
                    method,
                    &uri,
                    &headers,
                    Some("application/json"),
                    b"{}".to_vec(),
                )
                .await;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "{method} {uri} with {headers:?}"
            );
            seen.push((status, bytes));
        }
        assert!(
            seen.windows(2).all(|w| w[0] == w[1]),
            "{method} {uri}: a missing, empty, wrong, short or long secret must read the same"
        );
    }
    h.finish().await;
}

#[tokio::test]
async fn no_maker_route_answers_without_the_right_manage_key_and_does_not_confirm_a_key() {
    let h = harness(|_| {}).await;
    let parent = source(&h).await;
    let real = h
        .post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 1))
        .await
        .2;
    let id = real["publication"]["id"].as_str().expect("id").to_owned();
    for (method, template) in ROUTES.iter().filter(|(_, p)| is_maker(p)) {
        let uri = template.replace("{id}", &id);
        let payload = json!({ "permitted": false });
        let mut seen: Vec<(StatusCode, Value)> = Vec::new();
        for headers in [
            vec![],
            vec![(MANAGE, "")],
            vec![(MANAGE, "not-the-key")],
            vec![(MANAGE, &"a".repeat(64)[..])],
            vec![(ADMIN, SECRET)], // the operator's secret is not a maker's key
        ] {
            let (status, _, res) = h.send(method, &uri, &headers, Some(&payload)).await;
            assert!(
                status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED,
                "{method} {uri} with {headers:?} answered {status}: {res}"
            );
            seen.push((status, res));
        }
        assert!(
            seen.windows(2).all(|w| w[0] == w[1]),
            "{method} {uri}: a missing key and any wrong key must read the same"
        );
    }
    // Nothing changed.
    let (_, _, after) = h.get(&format!("/v1/publications/{id}")).await;
    assert_eq!(after["fork_permitted"], true);
    h.finish().await;
}

#[tokio::test]
async fn every_response_from_every_route_carries_the_security_headers_and_errors_are_problem_details()
 {
    let h = harness(|_| {}).await;
    let parent = source(&h).await;
    let mut probes: Vec<Probe> = Vec::new();
    for (method, template) in ROUTES {
        let uri = template.replace("{id}", &parent);
        // Once with nothing, once with a body that will not parse, once with the operator's secret.
        probes.push(((*method).into(), uri.clone(), vec![], Vec::new()));
        probes.push(((*method).into(), uri.clone(), vec![], b"{not json".to_vec()));
        probes.push(((*method).into(), uri, vec![(ADMIN, SECRET)], b"{}".to_vec()));
    }
    // Things that are not routes at all.
    for (method, uri) in [
        ("GET", "/"),
        ("GET", "/nope"),
        ("GET", "/v1"),
        ("GET", "/v1/chains/"),
        ("GET", "/admin"),
        ("PATCH", "/v1/publications"),
        ("DELETE", "/health"),
        ("OPTIONS", "/v1/publications"),
        ("TRACE", "/health"),
    ] {
        probes.push((method.into(), uri.into(), vec![], Vec::new()));
    }
    for (method, uri, headers, bytes) in &probes {
        let (status, response, payload) = h
            .send_bytes(
                method,
                uri,
                headers,
                Some("application/json"),
                bytes.clone(),
            )
            .await;
        let at = format!("{method} {uri} ({status})");
        let get = |name: &str| {
            response
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
        };
        assert_eq!(get("x-content-type-options"), "nosniff", "{at}");
        assert_eq!(get("referrer-policy"), "no-referrer", "{at}");
        assert_eq!(
            get("content-security-policy"),
            "default-src 'none'; frame-ancestors 'none'",
            "{at}"
        );
        assert!(
            get("strict-transport-security").starts_with("max-age="),
            "{at}: no transport security header"
        );
        assert!(!get("x-request-id").is_empty(), "{at}: no request id");
        assert!(response.get("server").is_none(), "{at}: names its server");
        assert!(
            response.get("x-powered-by").is_none(),
            "{at}: names its stack"
        );
        if uri != "/metrics" && uri != "/health" && uri != "/ready" && uri != "/openapi.json" {
            assert!(
                get("cache-control").contains("no-store") || status.is_success(),
                "{at}: an error may not be cached"
            );
        }
        // An error is a problem document with the fields the contract names, and nothing else.
        if (status.is_client_error() || status.is_server_error())
            && status != StatusCode::METHOD_NOT_ALLOWED
            && !payload.is_empty()
        {
            let doc: Value = serde_json::from_slice(&payload)
                .unwrap_or_else(|_| panic!("{at}: an error that is not JSON: {}", text(&payload)));
            assert_eq!(get("content-type"), "application/problem+json", "{at}");
            for key in doc.as_object().expect("object").keys() {
                assert!(
                    [
                        "type",
                        "title",
                        "status",
                        "detail",
                        "field",
                        "rule",
                        "retry_after_secs"
                    ]
                    .contains(&key.as_str()),
                    "{at}: an unexpected field {key} in a problem document"
                );
            }
            assert_eq!(doc["status"], status.as_u16(), "{at}");
        }
    }
    h.finish().await;
}

/// Words that would only appear in an answer that is telling more than it should.
const LEAKS: &[&str] = &[
    "panicked",
    "backtrace",
    "RUST_BACKTRACE",
    "stack overflow",
    ".rs:",
    "/Users/",
    "/home/",
    "/target/",
    "postgres://",
    "SELECT ",
    "INSERT ",
    "sqlx",
    "tokio",
    "axum",
    "serde_json",
    "an-operator-secret",
    "GRAFT_",
];

/// Bodies a well-behaved client never sends.
fn hostile_bodies() -> Vec<(&'static str, Option<&'static str>, Vec<u8>)> {
    let json = Some("application/json");
    vec![
        ("empty", json, Vec::new()),
        ("null", json, b"null".to_vec()),
        ("array", json, b"[]".to_vec()),
        ("a bare string", json, b"\"x\"".to_vec()),
        ("a huge number", json, b"1e999999".to_vec()),
        ("truncated", json, b"{\"title\":\"abc".to_vec()),
        (
            "invalid utf-8",
            json,
            vec![0xff, 0xfe, 0xfd, b'{', 0x80, b'}'],
        ),
        ("a nul byte", json, b"{\"title\":\"a\0b\"}".to_vec()),
        (
            "deeply nested arrays",
            json,
            [vec![b'['; 4000], vec![b']'; 4000]].concat(),
        ),
        (
            "deeply nested objects",
            json,
            [b"{\"a\":".repeat(2000), b"1".to_vec(), vec![b'}'; 2000]].concat(),
        ),
        ("no content type", None, b"{}".to_vec()),
        ("html as the type", Some("text/html"), b"{}".to_vec()),
        ("xml as the type", Some("application/xml"), b"<a/>".to_vec()),
        (
            "a form",
            Some("application/x-www-form-urlencoded"),
            b"a=1&b=2".to_vec(),
        ),
        (
            "a multipart body",
            Some("multipart/form-data; boundary=x"),
            b"--x--".to_vec(),
        ),
        (
            "a type with a huge parameter",
            Some(
                "text/plain; a=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ),
            b"{}".to_vec(),
        ),
    ]
}

#[tokio::test]
async fn hostile_bodies_are_refused_cleanly_and_quickly_by_every_route_that_takes_one() {
    // Uploads are on so the source route reads its body too, instead of refusing at the door.
    let h = harness(|c| {
        c.guardrails.admin_failures_per_ip.count = 1_000_000;
        c.guardrails.uploads_enabled = true;
    })
    .await;
    let parent = source(&h).await;
    let routes: Vec<Walk> = ROUTES
        .iter()
        .filter(|(m, _)| matches!(*m, "POST" | "PUT"))
        .map(|(m, p)| {
            let headers = if is_admin(p) {
                vec![(ADMIN, SECRET)]
            } else {
                vec![]
            };
            (*m, p.replace("{id}", &parent), headers)
        })
        .collect();
    assert!(routes.len() >= 8);
    for (method, uri, headers) in &routes {
        for (name, content_type, payload) in hostile_bodies() {
            let at = format!("{method} {uri} with {name}");
            let started = std::time::Instant::now();
            let (status, response, bytes) = tokio::time::timeout(
                Duration::from_secs(5),
                h.send_bytes(method, uri, headers, content_type, payload),
            )
            .await
            .unwrap_or_else(|_| panic!("{at}: did not answer within five seconds"));
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "{at}: took {:?}",
                started.elapsed()
            );
            assert!(
                status.is_client_error(),
                "{at}: answered {status}, a refusal was expected: {}",
                text(&bytes)
            );
            let shown = text(&bytes);
            for leak in LEAKS {
                assert!(
                    !shown.contains(leak),
                    "{at}: the answer contains {leak:?}: {shown}"
                );
            }
            assert!(
                response
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.starts_with("application/problem+json")),
                "{at}: not a problem document"
            );
        }
    }
    // Still well, and still serving real work.
    let (status, _, _) = h.get("/health").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 77))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    h.finish().await;
}

#[tokio::test]
async fn a_body_over_each_routes_cap_is_refused_as_too_large_without_being_read_to_the_end() {
    let h = harness(|_| {}).await;
    let parent = source(&h).await;
    for (method, template, cap_hint) in [
        ("POST", "/v1/publications", 8 * 1024),
        ("POST", "/v1/reports", 2 * 1024),
        ("POST", "/v1/events", 16 * 1024),
    ] {
        let uri = template.replace("{id}", &parent);
        // Eight times the cap: enough to show it acts without making the test itself heavy.
        let payload = vec![b'a'; cap_hint * 8];
        let (status, _, bytes) = h
            .send_bytes(method, &uri, &[], Some("application/json"), payload)
            .await;
        assert_eq!(
            status,
            StatusCode::PAYLOAD_TOO_LARGE,
            "{method} {uri}: {}",
            text(&bytes)
        );
    }
    h.finish().await;
}

#[tokio::test]
async fn extreme_numbers_in_a_flip_are_refused_not_wrapped_or_computed() {
    let h = harness(|_| {}).await;
    let parent = source(&h).await;
    let max = u32::MAX;
    let big = i64::MAX;
    // (start, end, p, q): each is a request that would misbehave if a number wrapped, overflowed or
    // was trusted to size an allocation.
    let cases: &[(Value, Value, Value, Value)] = &[
        (json!(0), json!(max), json!(1), json!(1)),
        (json!(max), json!(0), json!(1), json!(1)),
        (json!(max), json!(max), json!(1), json!(1)),
        (json!(0), json!(24_000), json!(0), json!(1)),
        (json!(0), json!(24_000), json!(1), json!(0)),
        (json!(0), json!(24_000), json!(0), json!(0)),
        (json!(0), json!(24_000), json!(max), json!(1)),
        (json!(0), json!(24_000), json!(1), json!(max)),
        (json!(0), json!(24_000), json!(1_048_577), json!(1)),
        (json!(0), json!(24_000), json!(1), json!(1_048_577)),
        (json!(0), json!(24_000), json!(-1), json!(1)),
        (json!(-1), json!(24_000), json!(1), json!(1)),
        (json!(0), json!(24_000), json!(big), json!(1)),
        (json!(0), json!(24_000), json!(1.5), json!(1)),
        (json!(0), json!(24_000), json!("1"), json!(1)),
        (json!(0), json!(24_000), json!(null), json!(1)),
        (json!(0), json!(0), json!(1), json!(1)),
        (json!(5), json!(4), json!(1), json!(1)),
        // The one valid request: the whole source, slowed to a quarter, so four times as long.
        (json!(0), json!(48_000), json!(1), json!(4)),
    ];
    for (n, (start, end, p, q)) in cases.iter().enumerate() {
        let payload = json!({
            "parent_id": parent,
            "cut": { "start": start, "end": end },
            "speed": { "p": p, "q": q },
            "title": "extreme",
            "author": "jo",
            "retry_key": format!("extreme-number-key-{n:04}"),
        });
        let started = std::time::Instant::now();
        let (status, _, res) = h.post("/v1/publications", &payload).await;
        assert!(
            status.is_client_error() || status == StatusCode::CREATED,
            "case {n} {payload}: answered {status}: {res}"
        );
        // Only the last case is a valid request (a long, slow cut that fits); every other is refused.
        if n + 1 < cases.len() {
            assert!(status.is_client_error(), "case {n} {payload}: {status}");
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "case {n}: took {:?}",
            started.elapsed()
        );
    }
    let (status, _, _) = h.get("/ready").await;
    assert_eq!(status, StatusCode::OK, "still ready afterwards");
    h.finish().await;
}

#[tokio::test]
async fn a_chain_at_the_depth_cap_reads_in_bounded_work_and_one_more_flip_is_refused() {
    let h = harness(|_| {}).await;
    let mut parent = source(&h).await;
    // The source is stage 1; eleven flips reach the default cap of twelve.
    for n in 0..11u32 {
        let (status, _, res) = h
            .post("/v1/publications", &body(&parent, 0, 4_800, 1, 1, 100 + n))
            .await;
        assert_eq!(status, StatusCode::CREATED, "flip {n}: {res}");
        parent = res["publication"]["id"].as_str().expect("id").to_owned();
    }
    let started = std::time::Instant::now();
    let (status, _, chain) = h.get(&format!("/v1/chains/{parent}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(chain["stages"].as_array().expect("stages").len(), 12);
    assert!(chain["truncated"].is_null(), "{chain}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 0, 4_800, 1, 1, 200))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "one past the cap: {res}");
    h.finish().await;
}

#[tokio::test]
async fn a_client_that_connects_and_goes_quiet_does_not_hold_a_request_for_ever() {
    // The deadline covers reading the body as well as handling it: a body that never finishes
    // arriving is answered with a timeout, in the same problem format, and frees the request.
    let h = harness(|c| c.request_timeout_secs = 1).await;
    for (method, uri, headers) in [
        ("POST", "/v1/publications", vec![]),
        ("POST", "/v1/reports", vec![]),
        ("POST", "/v1/events", vec![]),
        ("PUT", "/admin/switch", vec![(ADMIN, SECRET)]),
    ] {
        let started = std::time::Instant::now();
        // A guard so that a service with no deadline fails this test instead of hanging it.
        let (status, response, bytes) = tokio::time::timeout(
            Duration::from_secs(10),
            h.send_stalled_body(method, uri, &headers, "application/json"),
        )
        .await
        .unwrap_or_else(|_| panic!("{method} {uri}: still waiting after ten seconds"));
        assert_eq!(
            status,
            StatusCode::REQUEST_TIMEOUT,
            "{method} {uri}: {}",
            text(&bytes)
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{method} {uri}: {:?}",
            started.elapsed()
        );
        let doc: Value = serde_json::from_slice(&bytes).expect("a problem document");
        assert_eq!(doc["type"], "urn:graft:problem:request-timeout");
        assert!(
            response
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/problem+json"))
        );
    }
    // The maker route reads its body only after the key is accepted; a stall there is cut off too.
    let parent = source(&h).await;
    let made = h
        .post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 901))
        .await
        .2;
    let id = made["publication"]["id"].as_str().expect("id").to_owned();
    let key = made["manage_key"].as_str().expect("key").to_owned();
    let (status, _, bytes) = tokio::time::timeout(
        Duration::from_secs(10),
        h.send_stalled_body(
            "PUT",
            &format!("/v1/publications/{id}/fork-permission"),
            &[(MANAGE, &key)],
            "application/json",
        ),
    )
    .await
    .expect("answered within ten seconds");
    assert_eq!(status, StatusCode::REQUEST_TIMEOUT, "{}", text(&bytes));
    // Ordinary requests are untouched by the deadline.
    let (status, _, _) = h.get("/health").await;
    assert_eq!(status, StatusCode::OK);
    h.finish().await;
}

fn retry_after(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
}

#[tokio::test]
async fn the_public_write_routes_that_are_limited_refuse_with_a_wait_once_an_address_has_used_its_share()
 {
    let h = harness(|c| {
        c.guardrails.report_per_ip.count = 2;
        c.guardrails.ingest_per_ip.count = 2;
    })
    .await;
    let parent = source(&h).await;
    let report = json!({ "publication_id": parent, "category": "spam" });
    let events = json!({ "events": [] });
    for (uri, payload) in [("/v1/reports", &report), ("/v1/events", &events)] {
        let mut statuses = Vec::new();
        let mut last = HeaderMap::new();
        for _ in 0..4 {
            let (status, headers, _) = h
                .send_from("198.51.100.7", "POST", uri, &[], Some(payload))
                .await;
            statuses.push(status);
            last = headers;
        }
        assert!(
            statuses.contains(&StatusCode::TOO_MANY_REQUESTS),
            "{uri}: {statuses:?}"
        );
        assert!(
            retry_after(&last).is_some_and(|s| s > 0),
            "{uri}: no wait named"
        );
        // Another address is not affected by the first one's use.
        let (status, _, _) = h
            .send_from("198.51.100.8", "POST", uri, &[], Some(payload))
            .await;
        assert_ne!(status, StatusCode::TOO_MANY_REQUESTS, "{uri}");
    }
    h.finish().await;
}

#[tokio::test]
async fn public_text_cannot_carry_markup_controls_look_alikes_or_a_link_into_a_title_or_a_name() {
    let h = harness(|_| {}).await;
    let parent = source(&h).await;
    // Each is either refused or stored without the dangerous part: never stored as sent.
    let attempts: &[(&str, &str)] = &[
        ("markup", "<script>alert(1)</script>"),
        ("an attribute", "x\" onmouseover=\"alert(1)"),
        ("a line break to inject a header", "title\r\nx-injected: 1"),
        ("a tab", "ti\ttle"),
        ("a bidirectional override", "gnp\u{202e}.exe"),
        ("a zero-width joiner", "pa\u{200d}ypal"),
        ("a byte order mark", "\u{feff}title"),
        ("a full-width link", "ｅｘａｍｐｌｅ．ｃｏｍ"),
        ("a full-width at sign", "＠someone"),
        ("a link", "see https://evil.example/x"),
        ("a bare domain", "visit evil-site.net now"),
        ("a handle", "thanks @someone"),
        ("a script mix inside one word", "pаypal"), // the second letter is Cyrillic
        ("a path", "../../etc/passwd"),
        ("a null", "a\u{0}b"),
        ("a very long word", &"w".repeat(5_000)),
        ("emoji", "title 🎷"),
        ("a combining flood", &format!("a{}", "\u{0301}".repeat(200))),
    ];
    for (n, (what, text_in)) in attempts.iter().enumerate() {
        for field in ["title", "author"] {
            let mut payload = body(
                &parent,
                1000,
                24_000,
                3,
                2,
                300 + n as u32 * 2 + (field == "author") as u32,
            );
            payload[field] = json!(text_in);
            let (status, _, res) = h.post("/v1/publications", &payload).await;
            if status == StatusCode::CREATED {
                let stored = res["publication"][field].as_str().unwrap_or("");
                for bad in [
                    "<",
                    ">",
                    "http",
                    "@",
                    "://",
                    "\r",
                    "\n",
                    "\t",
                    "\u{202e}",
                    "\u{200d}",
                    "\u{feff}",
                    "\0",
                    "evil.example",
                ] {
                    assert!(
                        !stored.contains(bad),
                        "{what} in {field}: stored {stored:?} still contains {bad:?}"
                    );
                }
            } else {
                assert_eq!(
                    status,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "{what} in {field}: {res}"
                );
                assert_eq!(res["field"], field, "{what}");
            }
        }
    }
    h.finish().await;
}

#[tokio::test]
async fn a_cross_origin_request_from_a_site_that_is_not_configured_gets_no_permission() {
    let h = harness(|c| c.cors_origins = vec!["https://site.example".into()]).await;
    let parent = source(&h).await;
    for origin in [
        "https://evil.example",
        "null",
        "https://site.example.evil.example",
        "http://site.example",
    ] {
        let (_, headers, _) = h
            .send_bytes(
                "GET",
                &format!("/v1/chains/{parent}"),
                &[("origin", origin)],
                None,
                Vec::new(),
            )
            .await;
        assert!(
            headers.get("access-control-allow-origin").is_none(),
            "{origin} was given permission"
        );
    }
    let (_, headers, _) = h
        .send_bytes(
            "GET",
            &format!("/v1/chains/{parent}"),
            &[("origin", "https://site.example")],
            None,
            Vec::new(),
        )
        .await;
    assert_eq!(
        headers
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("https://site.example")
    );
    h.finish().await;
}
