//! Domain model: content records, publications, ancestry rules, honesty states and limits.
//!
//! This crate is the centre of the dependency graph and depends on nothing in the workspace.

pub mod canonical;
pub mod chain;
pub mod hash;
pub mod honesty;
pub mod ids;
pub mod limits;
pub mod record;
