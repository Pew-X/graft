//! Request metrics in the Prometheus text format: a counter by method, route and status, and a
//! latency histogram by route. Routes are the matched route pattern, never the raw path, so label
//! cardinality stays bounded.

use std::collections::BTreeMap;
use std::sync::Mutex;

/// Upper bounds of the latency buckets, in seconds.
const BUCKETS: [f64; 10] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0];

#[derive(Default)]
struct Histogram {
    buckets: [u64; BUCKETS.len()],
    count: u64,
    sum: f64,
}

#[derive(Default)]
struct Inner {
    requests: BTreeMap<(String, String, u16), u64>,
    latency: BTreeMap<String, Histogram>,
}

/// The service's request metrics.
#[derive(Default)]
pub struct Metrics {
    inner: Mutex<Inner>,
    preview_mismatches: std::sync::atomic::AtomicU64,
}

impl Metrics {
    /// Record one finished request.
    pub fn observe(&self, method: &str, route: &str, status: u16, seconds: f64) {
        // The method comes from the client: anything outside the standard set shares one label.
        let method = match method {
            "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" => method,
            _ => "OTHER",
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        *inner
            .requests
            .entry((method.to_owned(), route.to_owned(), status))
            .or_default() += 1;
        let h = inner.latency.entry(route.to_owned()).or_default();
        h.count += 1;
        h.sum += seconds;
        for (i, le) in BUCKETS.iter().enumerate() {
            if seconds <= *le {
                h.buckets[i] += 1;
            }
        }
    }

    /// Count one publish whose client preview hash differed from the server's render.
    pub fn preview_mismatch(&self) {
        self.preview_mismatches
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// Render everything in the Prometheus text exposition format.
    #[must_use]
    pub fn render(&self) -> String {
        let Ok(inner) = self.inner.lock() else {
            return String::new();
        };
        let mut out = String::from("# TYPE graft_preview_mismatch_total counter\n");
        out.push_str(&format!(
            "graft_preview_mismatch_total {}\n",
            self.preview_mismatches
                .load(std::sync::atomic::Ordering::Relaxed)
        ));
        out.push_str("# TYPE graft_http_requests_total counter\n");
        for ((method, route, status), n) in &inner.requests {
            out.push_str(&format!(
                "graft_http_requests_total{{method=\"{method}\",route=\"{route}\",status=\"{status}\"}} {n}\n"
            ));
        }
        out.push_str("# TYPE graft_http_request_duration_seconds histogram\n");
        for (route, h) in &inner.latency {
            for (i, le) in BUCKETS.iter().enumerate() {
                out.push_str(&format!(
                    "graft_http_request_duration_seconds_bucket{{route=\"{route}\",le=\"{le}\"}} {}\n",
                    h.buckets[i]
                ));
            }
            out.push_str(&format!(
                "graft_http_request_duration_seconds_bucket{{route=\"{route}\",le=\"+Inf\"}} {}\n",
                h.count
            ));
            out.push_str(&format!(
                "graft_http_request_duration_seconds_sum{{route=\"{route}\"}} {}\n",
                h.sum
            ));
            out.push_str(&format!(
                "graft_http_request_duration_seconds_count{{route=\"{route}\"}} {}\n",
                h.count
            ));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_requests_by_method_route_and_status() {
        let m = Metrics::default();
        m.observe("GET", "/health", 200, 0.001);
        m.observe("GET", "/health", 200, 0.002);
        m.observe("GET", "/health", 503, 0.003);
        let text = m.render();
        assert!(text.contains(
            "graft_http_requests_total{method=\"GET\",route=\"/health\",status=\"200\"} 2"
        ));
        assert!(text.contains(
            "graft_http_requests_total{method=\"GET\",route=\"/health\",status=\"503\"} 1"
        ));
    }

    #[test]
    fn client_chosen_methods_share_one_label_so_cardinality_stays_bounded() {
        let m = Metrics::default();
        for i in 0..50 {
            m.observe(&format!("FOO{i}"), "/x", 405, 0.001);
        }
        let text = m.render();
        assert!(text.contains("method=\"OTHER\",route=\"/x\",status=\"405\"} 50"));
        assert!(!text.contains("FOO"));
    }

    #[test]
    fn histogram_buckets_are_cumulative_and_the_inf_bucket_equals_the_count() {
        let m = Metrics::default();
        m.observe("GET", "/x", 200, 0.004); // in every bucket
        m.observe("GET", "/x", 200, 0.3); // from the 0.5 bucket up
        m.observe("GET", "/x", 200, 9.0); // only +Inf
        let text = m.render();
        assert!(text.contains("route=\"/x\",le=\"0.005\"} 1"));
        assert!(text.contains("route=\"/x\",le=\"0.25\"} 1"));
        assert!(text.contains("route=\"/x\",le=\"0.5\"} 2"));
        assert!(text.contains("route=\"/x\",le=\"5\"} 2"));
        assert!(text.contains("route=\"/x\",le=\"+Inf\"} 3"));
        assert!(text.contains("duration_seconds_count{route=\"/x\"} 3"));
    }
}
