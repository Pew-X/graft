//! The renderer compiled natively, through its safe entry points.

use crate::host::{Host, Outcome};

/// Runs `graft-render` as a native library.
#[derive(Debug, Default)]
pub struct NativeHost;

impl Host for NativeHost {
    fn name(&self) -> &str {
        "native"
    }

    fn out_len(&mut self, in_len: u32, p: u32, q: u32) -> Result<i32, String> {
        Ok(graft_render::out_len(in_len, p, q))
    }

    fn render(&mut self, input: &[i16], p: u32, q: u32, method: u32, out_cap: u32) -> Outcome {
        let mut out = vec![0i16; out_cap as usize];
        let code = graft_render::render_into(input, p, q, method, &mut out);
        out.truncate(usize::try_from(code).unwrap_or(0));
        Outcome::Status { code, out }
    }
}
