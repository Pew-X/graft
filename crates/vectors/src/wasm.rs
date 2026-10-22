//! The canonical `.wasm` artefact run under wasmtime, one instance for the life of the host.
//!
//! This is a test harness. The service's own host crate (`graft-render-host`) adds limits,
//! interruption and typed errors; here the point is to run the table against the artefact's bytes.

use crate::host::{Host, Outcome, PointerCase};
use wasmtime::{Config, Engine, Instance, Memory, Module, Store, Trap, TypedFunc};

/// Why the artefact could not be loaded.
#[derive(Debug)]
pub struct WasmError(pub String);

impl std::fmt::Display for WasmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for WasmError {}

fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> WasmError + '_ {
    move |e| WasmError(format!("{what}: {e}"))
}

type RenderFn = TypedFunc<(u32, u32, u32, u32, u32, u32, u32), i32>;

/// The artefact instantiated with an empty import object.
pub struct WasmtimeHost {
    store: Store<()>,
    memory: Memory,
    alloc: TypedFunc<u32, u32>,
    free: TypedFunc<(u32, u32), ()>,
    out_len: TypedFunc<(u32, u32, u32), i32>,
    render: RenderFn,
}

impl WasmtimeHost {
    /// Instantiates the artefact bytes.
    ///
    /// # Errors
    /// Returns a message when the module is invalid, needs imports, or lacks an expected export.
    pub fn new(wasm: &[u8]) -> Result<Self, WasmError> {
        let engine = Engine::new(&Config::new()).map_err(err("engine"))?;
        let module = Module::new(&engine, wasm).map_err(err("compile"))?;
        let mut store = Store::new(&engine, ());
        let instance = Instance::new(&mut store, &module, &[]).map_err(err("instantiate"))?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| WasmError("no memory export".into()))?;
        Ok(Self {
            alloc: instance
                .get_typed_func(&mut store, "graft_alloc")
                .map_err(err("graft_alloc"))?,
            free: instance
                .get_typed_func(&mut store, "graft_free")
                .map_err(err("graft_free"))?,
            out_len: instance
                .get_typed_func(&mut store, "graft_out_len")
                .map_err(err("graft_out_len"))?,
            render: instance
                .get_typed_func(&mut store, "graft_render")
                .map_err(err("graft_render"))?,
            memory,
            store,
        })
    }

    fn bytes(frames: &[i16]) -> Vec<u8> {
        frames.iter().flat_map(|f| f.to_le_bytes()).collect()
    }
}

impl Host for WasmtimeHost {
    fn name(&self) -> &str {
        "wasmtime"
    }

    fn out_len(&mut self, in_len: u32, p: u32, q: u32) -> Result<i32, String> {
        self.out_len
            .call(&mut self.store, (in_len, p, q))
            .map_err(|e| e.to_string())
    }

    fn render(&mut self, input: &[i16], p: u32, q: u32, method: u32, out_cap: u32) -> Outcome {
        let mut run = || -> Result<Outcome, String> {
            let in_len = u32::try_from(input.len()).map_err(|e| e.to_string())?;
            let in_bytes = in_len.checked_mul(2).ok_or("input too long")?;
            let out_bytes = out_cap.checked_mul(2).ok_or("output capacity too large")?;
            let in_ptr = self
                .alloc
                .call(&mut self.store, in_bytes)
                .map_err(|e| e.to_string())?;
            let out_ptr = self
                .alloc
                .call(&mut self.store, out_bytes)
                .map_err(|e| e.to_string())?;
            if (in_bytes > 0 && in_ptr == 0) || (out_bytes > 0 && out_ptr == 0) {
                return Err("graft_alloc failed".into());
            }
            self.memory
                .write(&mut self.store, in_ptr as usize, &Self::bytes(input))
                .map_err(|e| e.to_string())?;
            let code = self
                .render
                .call(
                    &mut self.store,
                    (in_ptr, in_len, p, q, method, out_ptr, out_cap),
                )
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            if code > 0 {
                let mut raw = vec![0u8; code as usize * 2];
                self.memory
                    .read(&self.store, out_ptr as usize, &mut raw)
                    .map_err(|e| e.to_string())?;
                out = raw
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]))
                    .collect();
            }
            self.free
                .call(&mut self.store, (in_ptr, in_bytes))
                .map_err(|e| e.to_string())?;
            self.free
                .call(&mut self.store, (out_ptr, out_bytes))
                .map_err(|e| e.to_string())?;
            Ok(Outcome::Status { code, out })
        };
        run().unwrap_or_else(Outcome::HarnessError)
    }

    fn render_with_pointer_case(
        &mut self,
        case: PointerCase,
        in_len: u32,
        p: u32,
        q: u32,
        method: u32,
    ) -> Option<Outcome> {
        let setup = |host: &mut Self| -> Result<(u32, u32, u32), String> {
            let n = host
                .out_len
                .call(&mut host.store, (in_len, p, q))
                .map_err(|e| e.to_string())?;
            let cap = u32::try_from(n)
                .ok()
                .filter(|c| *c > 0 && in_len >= 2)
                .ok_or("bad case setup")?;
            let in_bytes = in_len.checked_mul(2).ok_or("in_len overflows")?;
            let out_bytes = cap.checked_mul(2).ok_or("cap overflows")?;
            let in_ptr = host
                .alloc
                .call(&mut host.store, in_bytes)
                .map_err(|e| e.to_string())?;
            let out_ptr = host
                .alloc
                .call(&mut host.store, out_bytes)
                .map_err(|e| e.to_string())?;
            if in_ptr == 0 || out_ptr == 0 {
                return Err("graft_alloc failed".into());
            }
            Ok((cap, in_ptr, out_ptr))
        };
        let (cap, in_ptr, out_ptr) = match setup(self) {
            Ok(v) => v,
            Err(e) => return Some(Outcome::HarnessError(e)),
        };
        let wild = u32::try_from(self.memory.data_size(&self.store) + 65_536).unwrap_or(u32::MAX);
        let (in_ptr, out_ptr) = match case {
            PointerCase::NullInput => (0, out_ptr),
            PointerCase::OddInput => (in_ptr + 1, out_ptr),
            PointerCase::OddOutput => (in_ptr, out_ptr + 1),
            PointerCase::Overlap => (in_ptr, in_ptr + 2),
            PointerCase::WrapsAddressSpace => (0xFFFF_FFF0, out_ptr),
            PointerCase::WildOutput => (in_ptr, wild),
        };
        let result = self.render.call(
            &mut self.store,
            (in_ptr, in_len, p, q, method, out_ptr, cap),
        );
        Some(match result {
            Ok(code) => Outcome::Status {
                code,
                out: Vec::new(),
            },
            Err(e) => match e.downcast_ref::<Trap>() {
                Some(Trap::MemoryOutOfBounds) => Outcome::Trap(Trap::MemoryOutOfBounds.to_string()),
                _ => Outcome::HarnessError(e.to_string()),
            },
        })
    }

    fn memory_pages(&mut self) -> Option<u64> {
        Some(self.memory.size(&self.store))
    }
}
