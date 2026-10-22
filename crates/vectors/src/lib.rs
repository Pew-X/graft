//! The renderer vector table and the harnesses that replay it.
//!
//! The table (`fixtures/vectors/vectors.json`) is the evidence behind the determinism claim: every
//! host (native, wasmtime, browsers, the TypeScript port) must produce the same output hash for every
//! vector. Expected values are produced by an independent reference (`scripts/vectors/reference.py`),
//! not by the renderer under test.

pub mod canon;
pub mod cli;
pub mod host;
pub mod hosted;
pub mod input;
pub mod native;
pub mod run;
pub mod table;
pub mod wasm;
