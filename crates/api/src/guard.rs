//! Abuse guardrails: the kill switch, the per-visitor limits, the global publish cap and the
//! storage admission threshold. Every refusal is a problem document that says why.
//!
//! Two kinds of state, kept apart on purpose. What must agree across instances (the kill switch,
//! the global budget) lives in Postgres. What concerns a visitor (how often an address has
//! published) lives in this process's memory for one window and is never written anywhere: not to
//! the database, not to a log line, not to a metric label. A restart forgets it, which is the
//! point.

use crate::config::{Guardrails, Rate};
use crate::problem::Problem;
use axum::extract::ConnectInfo;
use axum::http::HeaderMap;
use graft_storage::{BlobStore, PublishToken, Store};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

/// A source of the current time in seconds since the Unix epoch, so a test can move it.
pub trait Clock: Send + Sync {
    /// Now.
    fn now_secs(&self) -> f64;
}

/// The system clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64())
    }
}

/// A clock that moves only when told to.
pub struct ManualClock(Mutex<f64>);

impl ManualClock {
    /// A clock standing at `start`.
    #[must_use]
    pub fn new(start: f64) -> Self {
        Self(Mutex::new(start))
    }

    /// Move forward by `secs`.
    pub fn advance(&self, secs: f64) {
        if let Ok(mut now) = self.0.lock() {
            *now += secs;
        }
    }
}

impl Clock for ManualClock {
    fn now_secs(&self) -> f64 {
        self.0.lock().map_or(0.0, |now| *now)
    }
}

/// The setting key the kill switch is stored under.
pub const SWITCH_KEY: &str = "publishing";

/// The kill switch for every write that adds to what is published. Closing it refuses flips,
/// sources, client events and uploads with the same kind message; reads, reports, a maker's
/// withdrawal and the operator's own routes stay open, so a bad moment can always be undone.
///
/// The state lives in the database, so every instance agrees. A read is reused for the configured
/// cache time, so a change made on another instance is seen within that time; the instance that
/// makes the change sees it on its next request.
pub struct KillSwitch {
    store: Store,
    clock: Arc<dyn Clock>,
    default_open: bool,
    ttl_secs: f64,
    cached: Mutex<Option<(bool, f64)>>,
}

impl KillSwitch {
    fn new(store: Store, clock: Arc<dyn Clock>, g: &Guardrails) -> Self {
        Self {
            store,
            clock,
            default_open: g.publishing_default,
            ttl_secs: g.switch_cache_ms as f64 / 1000.0,
            cached: Mutex::new(None),
        }
    }

    /// Whether publishing is open. If the database cannot be read, the last known state stands;
    /// with none, the configured default.
    pub async fn publishing_open(&self) -> bool {
        let now = self.clock.now_secs();
        let known = self.cached.lock().ok().and_then(|c| *c);
        if let Some((open, at)) = known
            && now - at < self.ttl_secs
        {
            return open;
        }
        match self.store.setting(SWITCH_KEY).await {
            Ok(value) => {
                let open = match value.as_deref() {
                    Some("off") => false,
                    Some("on") => true,
                    _ => self.default_open,
                };
                if let Ok(mut c) = self.cached.lock() {
                    *c = Some((open, now));
                }
                open
            }
            Err(error) => {
                tracing::warn!(%error, "reading the kill switch failed; using the last known state");
                known.map_or(self.default_open, |(open, _)| open)
            }
        }
    }

    /// Open or close publishing. Takes effect on this instance at once and on the others within
    /// the cache time.
    pub async fn set_publishing_open(&self, open: bool) -> Result<(), graft_storage::StoreError> {
        self.store
            .set_setting(SWITCH_KEY, if open { "on" } else { "off" })
            .await?;
        if let Ok(mut c) = self.cached.lock() {
            *c = Some((open, self.clock.now_secs()));
        }
        Ok(())
    }
}

/// What a per-visitor limit counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Class {
    /// Publishing a flip or a source.
    Publish,
    /// Filing a report.
    Report,
    /// A refused admin attempt.
    AdminFailure,
    /// A batch of client events.
    Ingest,
}

/// Most addresses tracked at once. Beyond this the limiter stops tracking new ones rather than
/// grow without bound; the global publish cap still protects the service.
const MAX_TRACKED: usize = 100_000;

/// Sliding-window limits per visitor address, kept in memory only.
///
/// An address is held for as long as its window and no longer. IPv6 addresses count by their /64,
/// the smallest block a household or a phone is given, so one visitor cannot spread over a range.
pub struct RateLimiter {
    rates: HashMap<Class, Rate>,
    seen: Mutex<HashMap<(Class, IpAddr), VecDeque<f64>>>,
}

impl RateLimiter {
    fn new(g: &Guardrails) -> Self {
        Self {
            rates: HashMap::from([
                (Class::Publish, g.publish_per_ip),
                (Class::Report, g.report_per_ip),
                (Class::AdminFailure, g.admin_failures_per_ip),
                (Class::Ingest, g.ingest_per_ip),
            ]),
            seen: Mutex::new(HashMap::new()),
        }
    }

    fn rate(&self, class: Class) -> Rate {
        self.rates.get(&class).copied().unwrap_or(Rate {
            count: u32::MAX,
            window_secs: 1,
        })
    }

    /// Count one use by `ip`, or refuse with the seconds to wait. The count and the decision are
    /// one step under one lock, so `n` simultaneous requests against a limit of `l` admit exactly
    /// `l` and refuse `n - l`.
    pub fn try_admit(&self, class: Class, ip: IpAddr, now: f64) -> Result<(), u32> {
        self.touch(class, ip, now, true)
    }

    /// Whether `ip` is over its limit, without counting this use.
    pub fn check(&self, class: Class, ip: IpAddr, now: f64) -> Result<(), u32> {
        self.touch(class, ip, now, false)
    }

    /// Count one use by `ip` without deciding anything: for events that are only counted when
    /// they fail.
    pub fn record(&self, class: Class, ip: IpAddr, now: f64) {
        let rate = self.rate(class);
        let window = rate.window_secs as f64;
        let Ok(mut seen) = self.seen.lock() else {
            return;
        };
        if seen.len() >= MAX_TRACKED {
            self.prune(&mut seen, now);
            if seen.len() >= MAX_TRACKED && !seen.contains_key(&(class, normalise(ip))) {
                return;
            }
        }
        let q = seen.entry((class, normalise(ip))).or_default();
        expire(q, now, window);
        q.push_back(now);
        while q.len() > rate.count as usize {
            q.pop_front();
        }
    }

    fn touch(&self, class: Class, ip: IpAddr, now: f64, count_it: bool) -> Result<(), u32> {
        let rate = self.rate(class);
        let window = rate.window_secs as f64;
        let Ok(mut seen) = self.seen.lock() else {
            return Ok(());
        };
        let key = (class, normalise(ip));
        if !seen.contains_key(&key) && seen.len() >= MAX_TRACKED {
            self.prune(&mut seen, now);
            if seen.len() >= MAX_TRACKED {
                return Ok(());
            }
        }
        let q = seen.entry(key).or_default();
        expire(q, now, window);
        if q.len() >= rate.count as usize {
            let oldest = q.front().copied().unwrap_or(now);
            let wait = (oldest + window - now)
                .ceil()
                .clamp(1.0, f64::from(u32::MAX));
            return Err(wait as u32);
        }
        if count_it {
            q.push_back(now);
        }
        Ok(())
    }

    fn prune(&self, seen: &mut HashMap<(Class, IpAddr), VecDeque<f64>>, now: f64) {
        seen.retain(|(class, _), q| {
            let window = self.rate(*class).window_secs as f64;
            expire(q, now, window);
            !q.is_empty()
        });
    }

    /// How many addresses are being tracked right now.
    #[must_use]
    pub fn tracked(&self) -> usize {
        self.seen.lock().map_or(0, |s| s.len())
    }
}

fn expire(q: &mut VecDeque<f64>, now: f64, window: f64) {
    while q.front().is_some_and(|t| now - t >= window) {
        q.pop_front();
    }
}

fn normalise(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => {
            // An IPv4 address carried inside IPv6 is the IPv4 visitor.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            let mut octets = v6.octets();
            octets[8..].fill(0);
            IpAddr::V6(octets.into())
        }
    }
}

/// The visitor's address as the service should count it. With no trusted proxy it is the address
/// that connected. With `hops` trusted proxies in front, each appends the address it saw to
/// `X-Forwarded-For`, so the visitor is the entry `hops` from the right; anything further left was
/// written by the visitor and is ignored. A header that is missing or too short falls back to the
/// connecting address.
#[must_use]
pub fn client_ip(peer: Option<IpAddr>, forwarded_for: Option<&str>, hops: usize) -> IpAddr {
    let peer = peer.unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    if hops == 0 {
        return peer;
    }
    let entries: Vec<&str> = forwarded_for
        .map(|v| v.split(',').map(str::trim).collect())
        .unwrap_or_default();
    entries
        .len()
        .checked_sub(hops)
        .and_then(|i| entries.get(i))
        .and_then(|e| e.parse::<IpAddr>().ok())
        .unwrap_or(peer)
}

/// How many events one session id may send within a window, counted in memory only. A session id
/// is chosen by the browser, so this stops one honest page from flooding; it does not stop someone
/// who invents a new id every time, which is what the per-address limit and the global bounds are
/// for.
pub struct SessionVelocity {
    rate: Rate,
    seen: Mutex<HashMap<String, VecDeque<f64>>>,
}

impl SessionVelocity {
    fn new(g: &Guardrails) -> Self {
        Self {
            rate: g.ingest_session_events,
            seen: Mutex::new(HashMap::new()),
        }
    }

    /// Count `n` events for `session`, or refuse with the seconds to wait. All or nothing.
    pub fn try_add(&self, session: &str, n: usize, now: f64) -> Result<(), u32> {
        let window = self.rate.window_secs as f64;
        let limit = self.rate.count as usize;
        let Ok(mut seen) = self.seen.lock() else {
            return Ok(());
        };
        if !seen.contains_key(session) && seen.len() >= MAX_TRACKED {
            seen.retain(|_, q| {
                expire(q, now, window);
                !q.is_empty()
            });
            if seen.len() >= MAX_TRACKED {
                return Ok(());
            }
        }
        let q = seen.entry(session.to_owned()).or_default();
        expire(q, now, window);
        if q.len() + n > limit {
            let oldest = q.front().copied().unwrap_or(now);
            let wait = (oldest + window - now)
                .ceil()
                .clamp(1.0, f64::from(u32::MAX));
            return Err(wait as u32);
        }
        q.extend(std::iter::repeat_n(now, n));
        Ok(())
    }
}

/// Whether new publishes are admitted given how much audio is stored.
///
/// The total is read from the blob store at most once per refresh interval and compared with the
/// admission threshold. This is a soft check outside any transaction, not a quota: publishes admitted
/// between two reads can add to the total, and that is bounded by the global publish cap (see
/// `Guardrails::overshoot_bound_bytes`).
pub struct StorageGauge {
    blobs: Arc<dyn BlobStore>,
    clock: Arc<dyn Clock>,
    threshold: u64,
    refresh_secs: f64,
    state: tokio::sync::Mutex<Option<(u64, f64)>>,
}

impl StorageGauge {
    fn new(
        blobs: Arc<dyn BlobStore>,
        clock: Arc<dyn Clock>,
        g: &Guardrails,
        limits: &graft_domain::limits::Limits,
    ) -> Self {
        Self {
            blobs,
            clock,
            threshold: g.admission_threshold_bytes(limits),
            refresh_secs: g.storage_refresh_secs as f64,
            state: tokio::sync::Mutex::new(None),
        }
    }

    /// The stored total as last read, reading again when it is older than the refresh interval.
    /// `None` when it has never been read and cannot be: the caller then admits, because refusing
    /// everything over a failed listing would be worse than the bounded overshoot.
    pub async fn total_bytes(&self) -> Option<u64> {
        let now = self.clock.now_secs();
        let mut state = self.state.lock().await;
        if let Some((total, at)) = *state
            && now - at < self.refresh_secs
        {
            return Some(total);
        }
        match self.blobs.list().await {
            Ok(all) => {
                let total = all.iter().map(|b| b.size).sum();
                *state = Some((total, now));
                Some(total)
            }
            Err(error) => {
                tracing::warn!(%error, "reading the stored total failed");
                state.map(|(total, _)| total)
            }
        }
    }

    /// Whether the stored total has reached the admission threshold.
    pub async fn is_full(&self) -> bool {
        self.total_bytes()
            .await
            .is_some_and(|total| total >= self.threshold)
    }

    /// The threshold, in bytes.
    #[must_use]
    pub fn threshold_bytes(&self) -> u64 {
        self.threshold
    }
}

/// Every guardrail, shared by the handlers.
pub struct Guards {
    /// The time source.
    pub clock: Arc<dyn Clock>,
    /// The kill switch.
    pub switch: KillSwitch,
    /// Per-visitor limits.
    pub limiter: RateLimiter,
    /// Storage admission.
    pub storage: StorageGauge,
    /// Per-session limits on client events.
    pub sessions: SessionVelocity,
    trusted_proxy_hops: usize,
    global_per_hour: u32,
    global_burst: u32,
}

impl Guards {
    /// Build the guardrails from configuration.
    #[must_use]
    pub fn new(
        g: &Guardrails,
        limits: &graft_domain::limits::Limits,
        store: Store,
        blobs: Arc<dyn BlobStore>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            switch: KillSwitch::new(store, clock.clone(), g),
            limiter: RateLimiter::new(g),
            sessions: SessionVelocity::new(g),
            storage: StorageGauge::new(blobs, clock.clone(), g, limits),
            clock,
            trusted_proxy_hops: g.trusted_proxy_hops,
            global_per_hour: g.global_publish_per_hour,
            global_burst: g.global_publish_burst,
        }
    }

    /// The visitor's address for a request, as counted by the limits.
    #[must_use]
    pub fn client_ip(&self, extensions: &axum::http::Extensions, headers: &HeaderMap) -> IpAddr {
        let peer = extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip());
        let forwarded = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
        client_ip(peer, forwarded, self.trusted_proxy_hops)
    }

    /// Take one token from the global publish budget, or refuse with the wait.
    pub async fn take_global_token(&self, store: &Store) -> Result<(), Problem> {
        match store
            .take_publish_token(
                self.clock.now_secs(),
                self.global_per_hour,
                self.global_burst,
            )
            .await
        {
            Ok(PublishToken::Taken) => Ok(()),
            Ok(PublishToken::Empty { retry_after_secs }) => {
                Err(Problem::publish_cap(retry_after_secs))
            }
            Err(error) => {
                tracing::error!(%error, "taking a publish token failed");
                Err(Problem::retry_later())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("an address")
    }

    fn limiter(count: u32, window_secs: u64) -> RateLimiter {
        let mut g = crate::config::Config::from_lookup(|n| {
            (n == "GRAFT_DATABASE_URL").then(|| "postgres://x".to_owned())
        })
        .expect("config")
        .guardrails;
        g.publish_per_ip = Rate { count, window_secs };
        RateLimiter::new(&g)
    }

    #[test]
    fn a_visitor_is_admitted_up_to_the_limit_then_told_how_long_to_wait() {
        let l = limiter(3, 100);
        let a = ip("203.0.113.7");
        for t in [0.0, 10.0, 20.0] {
            assert_eq!(l.try_admit(Class::Publish, a, t), Ok(()));
        }
        // The oldest use leaves the window at 100 s.
        assert_eq!(l.try_admit(Class::Publish, a, 30.0), Err(70));
        assert_eq!(l.try_admit(Class::Publish, a, 99.0), Err(1));
        assert_eq!(l.try_admit(Class::Publish, a, 100.0), Ok(()));
    }

    #[test]
    fn visitors_are_independent_and_an_address_in_one_class_does_not_count_in_another() {
        let l = limiter(1, 100);
        assert_eq!(l.try_admit(Class::Publish, ip("203.0.113.7"), 0.0), Ok(()));
        assert_eq!(l.try_admit(Class::Publish, ip("203.0.113.8"), 0.0), Ok(()));
        assert!(l.try_admit(Class::Publish, ip("203.0.113.7"), 1.0).is_err());
        assert_eq!(l.try_admit(Class::Report, ip("203.0.113.7"), 1.0), Ok(()));
    }

    #[test]
    fn an_ipv6_visitor_counts_by_its_64_bit_prefix_and_a_mapped_ipv4_as_ipv4() {
        let l = limiter(1, 100);
        assert_eq!(
            l.try_admit(Class::Publish, ip("2001:db8:1:2::1"), 0.0),
            Ok(())
        );
        assert!(
            l.try_admit(Class::Publish, ip("2001:db8:1:2:ffff::9"), 1.0)
                .is_err(),
            "another address in the same /64 is the same visitor"
        );
        assert_eq!(
            l.try_admit(Class::Publish, ip("2001:db8:1:3::1"), 1.0),
            Ok(())
        );
        assert_eq!(l.try_admit(Class::Publish, ip("203.0.113.7"), 0.0), Ok(()));
        assert!(
            l.try_admit(Class::Publish, ip("::ffff:203.0.113.7"), 1.0)
                .is_err()
        );
    }

    #[test]
    fn checking_does_not_count_and_recording_does() {
        let l = limiter(2, 100);
        let a = ip("203.0.113.7");
        for _ in 0..5 {
            assert_eq!(l.check(Class::Publish, a, 0.0), Ok(()));
        }
        l.record(Class::Publish, a, 0.0);
        l.record(Class::Publish, a, 1.0);
        assert_eq!(l.check(Class::Publish, a, 2.0), Err(98));
    }

    #[test]
    fn an_address_is_forgotten_when_its_window_has_passed_and_memory_is_bounded() {
        let l = limiter(1, 10);
        for n in 0..50u8 {
            assert_eq!(
                l.try_admit(Class::Publish, ip(&format!("198.51.100.{n}")), 0.0),
                Ok(())
            );
        }
        assert_eq!(l.tracked(), 50);
        // Pruning runs only when the table is full; expiry still frees each address on its next use.
        assert_eq!(
            l.try_admit(Class::Publish, ip("198.51.100.1"), 11.0),
            Ok(())
        );
    }

    #[test]
    fn the_visitor_is_the_entry_the_trusted_proxy_appended_never_one_the_visitor_wrote() {
        let peer = Some(ip("10.0.0.9"));
        assert_eq!(client_ip(peer, Some("1.2.3.4"), 0), ip("10.0.0.9"));
        assert_eq!(client_ip(peer, Some("1.2.3.4"), 1), ip("1.2.3.4"));
        // The visitor wrote `6.6.6.6`; the proxy appended the address it really saw.
        assert_eq!(
            client_ip(peer, Some("6.6.6.6, 203.0.113.7"), 1),
            ip("203.0.113.7")
        );
        assert_eq!(
            client_ip(peer, Some("6.6.6.6, 203.0.113.7, 10.0.0.5"), 2),
            ip("203.0.113.7")
        );
        // Missing, too short or unreadable: the connecting address.
        assert_eq!(client_ip(peer, None, 1), ip("10.0.0.9"));
        assert_eq!(client_ip(peer, Some("203.0.113.7"), 2), ip("10.0.0.9"));
        assert_eq!(client_ip(peer, Some("not an address"), 1), ip("10.0.0.9"));
    }
}
