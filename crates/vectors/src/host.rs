//! What a place that can run the renderer looks like to the table.

/// Result of one render call on a host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The call returned a status. `out` holds the frames when the status is positive.
    Status {
        /// Return code: frames written, or negative.
        code: i32,
        /// Output frames.
        out: Vec<i16>,
    },
    /// The renderer trapped (WebAssembly hosts only).
    Trap(String),
}

/// A host that can run the renderer: native, wasmtime, and later the browsers' harness.
pub trait Host {
    /// Short name used in reports.
    fn name(&self) -> &str;

    /// `out_len` as exported by the renderer.
    ///
    /// # Errors
    /// A message when the host itself failed (a trap).
    fn out_len(&mut self, in_len: u32, p: u32, q: u32) -> Result<i32, String>;

    /// One render call with caller-owned buffers of `out_cap` frames.
    fn render(&mut self, input: &[i16], p: u32, q: u32, method: u32, out_cap: u32) -> Outcome;

    /// Calls render with an output pointer outside linear memory. `None` where that is not defined.
    fn render_with_wild_output_pointer(
        &mut self,
        _in_len: u32,
        _p: u32,
        _q: u32,
        _method: u32,
    ) -> Option<Outcome> {
        None
    }

    /// Current linear memory in 64 KiB pages, where the host has such a thing.
    fn memory_pages(&mut self) -> Option<u64> {
        None
    }
}
