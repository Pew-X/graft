//! The service's render host (`graft-render-host`) as a vector-table host.

use crate::host::{Host, Outcome};
use graft_render_host::{ArtefactError, Limits, Ratio, RenderError, RenderHost};

/// Runs the table through the same code path the publish route will use.
pub struct HostedRenderer(pub RenderHost);

impl HostedRenderer {
    /// Loads the artefact, checking it against the committed pins.
    ///
    /// # Errors
    /// See [`ArtefactError`].
    pub fn load(wasm: &[u8]) -> Result<Self, ArtefactError> {
        RenderHost::load(wasm, Limits::default()).map(Self)
    }
}

impl Host for HostedRenderer {
    fn name(&self) -> &str {
        "render-host"
    }

    fn out_len(&mut self, in_len: u32, p: u32, q: u32) -> Result<i32, String> {
        match self.0.output_frames(in_len, Ratio { p, q }) {
            Ok(n) => i32::try_from(n).map_err(|e| e.to_string()),
            Err(RenderError::InvalidParameters) => Ok(status::PARAM),
            Err(e) => Err(e.to_string()),
        }
    }

    fn render(&mut self, input: &[i16], p: u32, q: u32, method: u32, out_cap: u32) -> Outcome {
        match self.0.render_raw(input, p, q, method, out_cap) {
            Ok(out) => Outcome::Status {
                code: i32::try_from(out.len()).unwrap_or(i32::MAX),
                out,
            },
            Err(RenderError::InvalidParameters) => Outcome::Status {
                code: status::PARAM,
                out: Vec::new(),
            },
            Err(RenderError::OutputTooSmall) => Outcome::Status {
                code: status::CAPACITY,
                out: Vec::new(),
            },
            Err(RenderError::Trapped(why)) => Outcome::Trap(why),
            Err(other) => Outcome::HarnessError(other.to_string()),
        }
    }
}

/// The renderer's documented status codes, as the table writes them.
mod status {
    pub const PARAM: i32 = -1;
    pub const CAPACITY: i32 = -2;
}
