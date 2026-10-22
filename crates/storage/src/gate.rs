//! Test seam for races. A transaction announces named points; production code uses [`NoGate`] and
//! passes straight through, while a test installs a gate that holds transactions at a point until
//! it releases them, so an interleaving that is rare in practice can be forced on purpose.

use crate::blob::BoxFuture;

/// A hook that may pause a transaction at a named point.
pub trait Gate: Send + Sync {
    /// Called when a transaction reaches `point`. The transaction continues when this resolves.
    fn reached(&self, point: &'static str) -> BoxFuture<'_, ()>;
}

/// The production gate: never waits.
pub struct NoGate;

impl Gate for NoGate {
    fn reached(&self, _point: &'static str) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

/// Points a flip transaction announces, in order.
pub mod points {
    /// The lock on the parent is held and no transaction has begun yet.
    pub const LOCKED: &str = "locked";
    /// Permission, hidden state and the fork cap were checked; nothing is written yet.
    pub const CHECKED: &str = "checked";
    /// Both rows are written; the transaction is about to commit.
    pub const BEFORE_COMMIT: &str = "before_commit";
}
