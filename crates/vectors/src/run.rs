//! Replays the table against a host and reports every check.

use crate::canon;
use crate::host::{Host, Outcome};
use crate::table::{Scenario, Table, Vector};
use sha2::{Digest, Sha256};

/// One pass/fail line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    /// What was checked (vector or scenario name, with a prefix for the group).
    pub name: String,
    /// Whether the host produced the expected result.
    pub passed: bool,
    /// What the table expects.
    pub expected: String,
    /// What the host produced.
    pub actual: String,
}

impl Check {
    fn new(name: impl Into<String>, expected: String, actual: String) -> Self {
        Self {
            name: name.into(),
            passed: expected == actual,
            expected,
            actual,
        }
    }
}

/// SHA-256 of frames as little-endian bytes, lower-case hex.
#[must_use]
pub fn sha256_pcm(frames: &[i16]) -> String {
    let mut hasher = Sha256::new();
    for f in frames {
        hasher.update(f.to_le_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn describe(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Status { code, out } if *code > 0 => {
            format!("status {code} sha256 {}", sha256_pcm(out))
        }
        Outcome::Status { code, .. } => format!("status {code}"),
        Outcome::Trap(why) => format!("trap ({why})"),
    }
}

fn expected(v: &Vector) -> String {
    match &v.expect.sha256 {
        Some(hash) => format!("status {} sha256 {hash}", v.expect.status),
        None => format!("status {}", v.expect.status),
    }
}

fn run_vector(v: &Vector, host: &mut dyn Host) -> Vec<Check> {
    let input = v.input.generate();
    let outcome = host.render(&input, v.p, v.q, v.method, v.out_cap);
    let mut checks = vec![Check::new(
        format!("vector {}", v.name),
        expected(v),
        describe(&outcome),
    )];
    if let (Some(want), Outcome::Status { out, .. }) = (&v.expect.samples, &outcome) {
        checks.push(Check::new(
            format!("vector {} (hand-worked samples)", v.name),
            format!("{want:?}"),
            format!("{out:?}"),
        ));
    }
    checks
}

fn run_scenario(table: &Table, scenario: &Scenario, host: &mut dyn Host) -> Check {
    let name = format!("scenario {}", scenario.name());
    match scenario {
        Scenario::Repeat { vector, times, .. } => {
            let Some(v) = table.vector(vector) else {
                return Check::new(name, "known vector".into(), format!("no vector {vector}"));
            };
            let input = v.input.generate();
            let first = describe(&host.render(&input, v.p, v.q, v.method, v.out_cap));
            let drift = (1..*times)
                .find(|_| describe(&host.render(&input, v.p, v.q, v.method, v.out_cap)) != first);
            Check::new(
                name,
                "every repeat identical".into(),
                match drift {
                    None => "every repeat identical".into(),
                    Some(n) => format!("repeat {n} differed from the first"),
                },
            )
        }
        Scenario::Growth {
            big, times, then, ..
        } => {
            let (Some(b), Some(s)) = (table.vector(big), table.vector(then)) else {
                return Check::new(name, "known vectors".into(), "missing vector".into());
            };
            let (big_in, small_in) = (b.input.generate(), s.input.generate());
            let before = describe(&host.render(&small_in, s.p, s.q, s.method, s.out_cap));
            let mut results = Vec::new();
            for _ in 0..*times {
                results.push(describe(
                    &host.render(&big_in, b.p, b.q, b.method, b.out_cap),
                ));
            }
            let after = describe(&host.render(&small_in, s.p, s.q, s.method, s.out_cap));
            let big_ok = results.iter().all(|r| *r == expected(b));
            Check::new(
                name,
                "large renders match, small vector unchanged".into(),
                if big_ok && before == after && after == expected(s) {
                    "large renders match, small vector unchanged".into()
                } else {
                    format!("large ok: {big_ok}, small before/after: {before} / {after}")
                },
            )
        }
        Scenario::Trap {
            in_len,
            p,
            q,
            method,
            ..
        } => match host.render_with_wild_output_pointer(*in_len, *p, *q, *method) {
            None => Check::new(
                name,
                "not defined on this host".into(),
                "not defined on this host".into(),
            ),
            Some(Outcome::Trap(_)) => Check::new(name, "trap".into(), "trap".into()),
            Some(other) => Check::new(name, "trap".into(), describe(&other)),
        },
    }
}

/// Runs the whole table against `host`.
pub fn run_table(table: &Table, host: &mut dyn Host) -> Vec<Check> {
    let mut checks = Vec::new();
    for v in &table.vectors {
        checks.extend(run_vector(v, host));
    }
    for c in &table.out_len {
        let actual = host
            .out_len(c.in_len, c.p, c.q)
            .map_or_else(|e| format!("trap ({e})"), |n| n.to_string());
        checks.push(Check::new(
            format!("out_len({}, {}, {})", c.in_len, c.p, c.q),
            c.expect.to_string(),
            actual,
        ));
    }
    for s in &table.scenarios {
        checks.push(run_scenario(table, s, host));
    }
    checks
}

/// Checks the canonicalisation rules against their vectors. Independent of any renderer host.
#[must_use]
pub fn run_canonicalisation(table: &Table) -> Vec<Check> {
    let mut checks = Vec::new();
    for c in &table.canonicalisation.f32_to_s16.cases {
        checks.push(Check::new(
            format!("f32_to_s16 {}", c.name),
            c.expect.to_string(),
            canon::f32_to_s16(f32::from_bits(c.bits)).to_string(),
        ));
    }
    for c in &table.canonicalisation.downmix.cases {
        checks.push(Check::new(
            format!("downmix({}, {})", c.left, c.right),
            c.expect.to_string(),
            canon::downmix(c.left, c.right).to_string(),
        ));
    }
    checks
}
