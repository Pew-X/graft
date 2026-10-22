//! The C-ABI surface of the canonical artefact. Compiled for `wasm32` only.
//!
//! Only 32-bit integers cross this boundary. The caller owns both buffers (obtained from
//! [`graft_alloc`]); errors are negative return codes; a trap means the renderer failed. The module
//! imports nothing.
//!
//! # Why `unsafe` is needed here and nowhere else
//!
//! The host hands over linear-memory addresses as integers. Turning an address into a slice is the one
//! thing safe Rust cannot express. Every `unsafe` block below does only that, after [`crate::plan`] has
//! validated every parameter, so lengths come from validated frame counts and never from the caller's
//! raw numbers. The contract with the host is: pointers come from [`graft_alloc`] (8-byte aligned,
//! inside linear memory) and the two buffers do not overlap. A pointer outside linear memory traps on
//! first access, which the vector table pins as the "renderer failed" path.

use crate::{STATUS_PARAM, VERSION, out_len, plan, render_into};
use std::alloc::{Layout, alloc, dealloc};

const ALIGN: usize = 8;

/// Renderer version, the same number recorded in a content record.
#[unsafe(no_mangle)]
pub extern "C" fn graft_version() -> u32 {
    VERSION
}

/// Allocates `size` bytes for the host to fill or read. Returns 0 for size 0 or on failure.
#[unsafe(no_mangle)]
pub extern "C" fn graft_alloc(size: u32) -> u32 {
    if size == 0 {
        return 0;
    }
    let Ok(layout) = Layout::from_size_align(size as usize, ALIGN) else {
        return 0;
    };
    // SAFETY: the layout has a non-zero size.
    unsafe { alloc(layout) as usize as u32 }
}

/// Releases a buffer from [`graft_alloc`]. `size` must be the size it was allocated with.
#[unsafe(no_mangle)]
pub extern "C" fn graft_free(ptr: u32, size: u32) {
    if ptr == 0 || size == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size as usize, ALIGN) {
        // SAFETY: the host passes back a pointer and size from `graft_alloc`.
        unsafe { dealloc(ptr as usize as *mut u8, layout) }
    }
}

/// Output frames for `in_len` input frames at speed `p/q`, or a negative status.
#[unsafe(no_mangle)]
pub extern "C" fn graft_out_len(in_len: u32, p: u32, q: u32) -> i32 {
    out_len(in_len, p, q)
}

/// Renders `in_len` frames at `in_ptr` into the buffer at `out_ptr` (capacity `out_cap` frames).
/// Returns frames written, [`STATUS_PARAM`](crate::STATUS_PARAM) or
/// [`STATUS_CAPACITY`](crate::STATUS_CAPACITY).
#[unsafe(no_mangle)]
pub extern "C" fn graft_render(
    in_ptr: u32,
    in_len: u32,
    p: u32,
    q: u32,
    method: u32,
    out_ptr: u32,
    out_cap: u32,
) -> i32 {
    let frames = match plan(in_len, p, q, method, out_cap) {
        Ok(n) => n,
        Err(status) => return status,
    };
    // SAFETY: `plan` accepted, so `in_len >= 1` and `frames >= 1`; the host guarantees the two ranges
    // are live, aligned and disjoint buffers from `graft_alloc` (module documentation).
    let (src, dst) = unsafe {
        (
            std::slice::from_raw_parts(in_ptr as usize as *const i16, in_len as usize),
            std::slice::from_raw_parts_mut(out_ptr as usize as *mut i16, frames),
        )
    };
    let written = render_into(src, p, q, method, dst);
    if written < 0 { STATUS_PARAM } else { written }
}
