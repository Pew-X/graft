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
    /// The harness itself failed before or after the renderer ran (never a renderer result).
    HarnessError(String),
}

/// A pointer mistake a caller can make; each is a defined outcome of the C-ABI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerCase {
    /// Input pointer 0 with frames to read.
    NullInput,
    /// Input pointer not 2-byte aligned.
    OddInput,
    /// Output pointer not 2-byte aligned.
    OddOutput,
    /// Output buffer starting inside the input buffer.
    Overlap,
    /// Input range running past the end of the 32-bit address space.
    WrapsAddressSpace,
    /// Output pointer beyond the end of linear memory.
    WildOutput,
}

impl PointerCase {
    /// Parses the name used in the table.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "null-input" => Self::NullInput,
            "odd-input" => Self::OddInput,
            "odd-output" => Self::OddOutput,
            "overlap" => Self::Overlap,
            "wraps-address-space" => Self::WrapsAddressSpace,
            "wild-output" => Self::WildOutput,
            _ => return None,
        })
    }
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

    /// Calls render with a deliberately wrong pointer. `None` where raw pointers do not exist.
    fn render_with_pointer_case(
        &mut self,
        _case: PointerCase,
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
