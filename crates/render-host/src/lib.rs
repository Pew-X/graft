//! Hosts the canonical renderer artefact under wasmtime.
//!
//! The service calls [`Render::render`] for every flip. The host compiles the pinned `.wasm` once,
//! gives each render a fresh store with a memory limit and a fuel budget, and turns every way the
//! module can misbehave (a trap, running out of fuel, hitting the memory limit, a negative return
//! code) into a typed [`RenderError`]. It never trusts the module and never panics on its output.
//!
//! This crate has no network surface: it takes audio as slices and returns audio as vectors.

mod error;
mod host;
#[cfg(test)]
mod hostile_tests;
mod pins;

pub use error::{ArtefactError, RenderError};
pub use host::{Limits, Method, Ratio, Render, RenderHost, RenderStats, RendererIdentity};
pub use pins::Pins;
