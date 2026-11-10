//! The wasmtime embedding.

use crate::error::{ArtefactError, RenderError};
use crate::pins::Pins;
use sha2::{Digest, Sha256};
use wasmtime::{Config, Engine, InstancePre, Linker, Module, ResourceLimiter, Store, Trap};

/// Renderer name recorded in a content record.
pub const RENDERER_NAME: &str = "graft-render";

/// Exact speed as a fraction `p/q`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ratio {
    /// Numerator.
    pub p: u32,
    /// Denominator.
    pub q: u32,
}

/// Interpolation method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// Two-point linear.
    Linear = 0,
    /// Cubic Hermite (Catmull-Rom).
    Hermite = 1,
}

/// Name, version and artefact hash of the loaded renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendererIdentity {
    /// Renderer name.
    pub name: &'static str,
    /// Version reported by the artefact.
    pub version: u32,
    /// SHA-256 of the exact bytes loaded, lower-case hex.
    pub wasm_sha256: String,
}

/// Per-render resource bounds.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Linear memory a single render may use.
    pub max_memory_bytes: usize,
    /// Fuel (roughly, WebAssembly instructions) a single render may use.
    pub max_fuel: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_memory_bytes: 64 << 20,
            max_fuel: 1_000_000_000,
        }
    }
}

/// What one render cost, for sizing the host and calibrating the fuel budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderStats {
    /// Fuel consumed (roughly, WebAssembly instructions executed).
    pub fuel_used: u64,
    /// Linear memory the instance held when the render finished, in bytes. Memory only grows, so
    /// this is also its peak.
    pub peak_memory_bytes: usize,
}

/// What the service needs from a renderer. API tests can substitute a fake for the real host.
pub trait Render: Send + Sync {
    /// Renders `cut` at speed `ratio` with `method`.
    ///
    /// # Errors
    /// See [`RenderError`].
    fn render(&self, cut: &[i16], ratio: Ratio, method: Method) -> Result<Vec<i16>, RenderError>;

    /// Output frames a render of `in_len` input frames at `ratio` would produce, so a caller can
    /// apply its own length limits before rendering.
    ///
    /// # Errors
    /// [`RenderError::InvalidParameters`] when the renderer refuses the parameters.
    fn output_frames(&self, in_len: u32, ratio: Ratio) -> Result<u32, RenderError>;

    /// The identity of the renderer in use.
    fn identity(&self) -> &RendererIdentity;
}

/// Exports the artefact must have (the C-ABI in `ARCHITECTURE.md`).
const REQUIRED_EXPORTS: [&str; 6] = [
    "memory",
    "graft_version",
    "graft_alloc",
    "graft_free",
    "graft_out_len",
    "graft_render",
];

/// Remembers whether the module asked for memory the host refused.
struct MemoryLimiter {
    max_bytes: usize,
    denied: bool,
}

impl ResourceLimiter for MemoryLimiter {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.max_bytes {
            self.denied = true;
            return Ok(false);
        }
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= 10_000)
    }
}

type AllocFn = wasmtime::TypedFunc<u32, u32>;

fn engine_config() -> Config {
    let mut config = Config::new();
    config.consume_fuel(true);
    config.wasm_simd(false);
    config.wasm_relaxed_simd(false);
    config.wasm_multi_memory(false);
    config.wasm_memory64(false);
    config
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn invalid<E: std::fmt::Display>(e: E) -> ArtefactError {
    ArtefactError::Invalid(e.to_string())
}

/// The artefact compiled once, ready to render. Every render gets a fresh store: nothing a render
/// does to the module's memory or globals survives it, and a trapped instance is discarded.
pub struct RenderHost {
    engine: Engine,
    pre: InstancePre<MemoryLimiter>,
    identity: RendererIdentity,
    limits: Limits,
}

impl std::fmt::Debug for RenderHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RenderHost")
            .field("identity", &self.identity)
            .field("limits", &self.limits)
            .finish()
    }
}

impl RenderHost {
    /// Loads the artefact and checks it against the pins compiled into the binary.
    ///
    /// # Errors
    /// See [`ArtefactError`].
    pub fn load(wasm: &[u8], limits: Limits) -> Result<Self, ArtefactError> {
        Self::load_with_pins(wasm, &Pins::embedded()?, limits)
    }

    /// Loads the artefact and checks it against the given pins: the version the module reports must
    /// be pinned, and the SHA-256 of the loaded bytes must equal that pin.
    ///
    /// # Errors
    /// See [`ArtefactError`].
    pub fn load_with_pins(wasm: &[u8], pins: &Pins, limits: Limits) -> Result<Self, ArtefactError> {
        let host = Self::load_unpinned(wasm, limits)?;
        let version = host.identity.version;
        let expected = pins
            .get(version)
            .ok_or(ArtefactError::UnpinnedVersion(version))?;
        if expected != host.identity.wasm_sha256 {
            return Err(ArtefactError::PinMismatch {
                version,
                expected: expected.to_string(),
                actual: host.identity.wasm_sha256,
            });
        }
        Ok(host)
    }

    /// Loads without checking the pins. Crate-private: the hostile-module tests need it, and nothing
    /// outside this crate can bypass the pin check.
    ///
    /// # Errors
    /// See [`ArtefactError`].
    pub(crate) fn load_unpinned(wasm: &[u8], limits: Limits) -> Result<Self, ArtefactError> {
        let engine = Engine::new(&engine_config()).map_err(invalid)?;
        let module = Module::new(&engine, wasm).map_err(invalid)?;
        let imports = module.imports().len();
        if imports > 0 {
            return Err(ArtefactError::HasImports(imports));
        }
        for name in REQUIRED_EXPORTS {
            if module.get_export(name).is_none() {
                return Err(ArtefactError::MissingExport(name));
            }
        }
        let pre = Linker::<MemoryLimiter>::new(&engine)
            .instantiate_pre(&module)
            .map_err(invalid)?;
        let mut host = Self {
            engine,
            pre,
            identity: RendererIdentity {
                name: RENDERER_NAME,
                version: 0,
                wasm_sha256: sha256_hex(wasm),
            },
            limits,
        };
        let mut store = host.new_store().map_err(|e| invalid(format!("{e:?}")))?;
        let instance = host.pre.instantiate(&mut store).map_err(invalid)?;
        let version = instance
            .get_typed_func::<(), u32>(&mut store, "graft_version")
            .map_err(|_| ArtefactError::MissingExport("graft_version"))?
            .call(&mut store, ())
            .map_err(invalid)?;
        host.identity.version = version;
        Ok(host)
    }

    fn new_store(&self) -> Result<Store<MemoryLimiter>, RenderError> {
        let mut store = Store::new(
            &self.engine,
            MemoryLimiter {
                max_bytes: self.limits.max_memory_bytes,
                denied: false,
            },
        );
        store.limiter(|state| state);
        store
            .set_fuel(self.limits.max_fuel)
            .map_err(|e| RenderError::Internal(e.to_string()))?;
        Ok(store)
    }

    /// One render with raw wire parameters and an explicit output capacity in frames.
    ///
    /// # Errors
    /// See [`RenderError`].
    pub fn render_raw(
        &self,
        cut: &[i16],
        p: u32,
        q: u32,
        method: u32,
        out_cap: u32,
    ) -> Result<Vec<i16>, RenderError> {
        self.run(cut, p, q, method, Some(out_cap))
            .map(|(out, _)| out)
    }

    /// A render that also reports what it cost.
    ///
    /// # Errors
    /// See [`RenderError`].
    pub fn render_with_stats(
        &self,
        cut: &[i16],
        ratio: Ratio,
        method: Method,
    ) -> Result<(Vec<i16>, RenderStats), RenderError> {
        self.run(cut, ratio.p, ratio.q, method as u32, None)
    }

    /// Output frames a render of `in_len` input frames at `ratio` would produce.
    ///
    /// # Errors
    /// [`RenderError::InvalidParameters`] when the renderer refuses the parameters.
    pub fn output_frames(&self, in_len: u32, ratio: Ratio) -> Result<u32, RenderError> {
        let mut store = self.new_store()?;
        let instance = self.pre.instantiate(&mut store).map_err(classify)?;
        let out_len = instance
            .get_typed_func::<(u32, u32, u32), i32>(&mut store, "graft_out_len")
            .map_err(|_| {
                RenderError::Internal("export `graft_out_len` has the wrong type".into())
            })?;
        match out_len
            .call(&mut store, (in_len, ratio.p, ratio.q))
            .map_err(classify)?
        {
            n if n > 0 => Ok(n.unsigned_abs()),
            _ => Err(RenderError::InvalidParameters),
        }
    }

    /// Runs one render in a fresh store. `out_cap` of `None` asks the module for the exact output
    /// length first.
    fn run(
        &self,
        cut: &[i16],
        p: u32,
        q: u32,
        method: u32,
        out_cap: Option<u32>,
    ) -> Result<(Vec<i16>, RenderStats), RenderError> {
        let mut store = self.new_store()?;
        let result = self.run_in(&mut store, cut, p, q, method, out_cap);
        if store.data().denied {
            return Err(RenderError::MemoryLimit);
        }
        let (out, peak_memory_bytes) = result?;
        let fuel_used = self
            .limits
            .max_fuel
            .saturating_sub(store.get_fuel().unwrap_or(0));
        Ok((
            out,
            RenderStats {
                fuel_used,
                peak_memory_bytes,
            },
        ))
    }

    fn run_in(
        &self,
        store: &mut Store<MemoryLimiter>,
        cut: &[i16],
        p: u32,
        q: u32,
        method: u32,
        out_cap: Option<u32>,
    ) -> Result<(Vec<i16>, usize), RenderError> {
        let in_len = u32::try_from(cut.len()).map_err(|_| RenderError::InvalidParameters)?;
        let in_bytes = in_len
            .checked_mul(2)
            .ok_or(RenderError::InvalidParameters)?;
        let instance = self.pre.instantiate(&mut *store).map_err(classify)?;
        let missing =
            |name: &str| RenderError::Internal(format!("export `{name}` has the wrong type"));
        let alloc: AllocFn = instance
            .get_typed_func(&mut *store, "graft_alloc")
            .map_err(|_| missing("graft_alloc"))?;
        let out_len = instance
            .get_typed_func::<(u32, u32, u32), i32>(&mut *store, "graft_out_len")
            .map_err(|_| missing("graft_out_len"))?;
        let render = instance
            .get_typed_func::<(u32, u32, u32, u32, u32, u32, u32), i32>(&mut *store, "graft_render")
            .map_err(|_| missing("graft_render"))?;
        let memory = instance
            .get_memory(&mut *store, "memory")
            .ok_or_else(|| missing("memory"))?;

        let cap = match out_cap {
            Some(cap) => cap,
            None => match out_len
                .call(&mut *store, (in_len, p, q))
                .map_err(classify)?
            {
                n if n > 0 => n.unsigned_abs(),
                _ => return Err(RenderError::InvalidParameters),
            },
        };
        let out_bytes = cap.checked_mul(2).ok_or(RenderError::MemoryLimit)?;
        let in_ptr = alloc.call(&mut *store, in_bytes).map_err(classify)?;
        let out_ptr = alloc.call(&mut *store, out_bytes).map_err(classify)?;
        if (in_bytes > 0 && in_ptr == 0) || (out_bytes > 0 && out_ptr == 0) {
            // The module could not allocate; if the host refused the memory the caller sees that.
            return Err(if store.data().denied {
                RenderError::MemoryLimit
            } else {
                RenderError::Internal("the module could not allocate".into())
            });
        }
        let raw: Vec<u8> = cut.iter().flat_map(|f| f.to_le_bytes()).collect();
        memory
            .write(&mut *store, in_ptr as usize, &raw)
            .map_err(|e| RenderError::Internal(e.to_string()))?;
        let code = render
            .call(&mut *store, (in_ptr, in_len, p, q, method, out_ptr, cap))
            .map_err(classify)?;
        match code {
            -1 => Err(RenderError::InvalidParameters),
            -2 => Err(RenderError::OutputTooSmall),
            n if n > 0 && n.unsigned_abs() <= cap => {
                let mut bytes = vec![0u8; n.unsigned_abs() as usize * 2];
                memory
                    .read(&*store, out_ptr as usize, &mut bytes)
                    .map_err(|e| RenderError::Internal(e.to_string()))?;
                let out = bytes
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]))
                    .collect();
                Ok((out, memory.data_size(&*store)))
            }
            other => Err(RenderError::Internal(format!(
                "the renderer returned {other}"
            ))),
        }
    }
}

/// Maps what wasmtime reports to a typed error.
fn classify(error: wasmtime::Error) -> RenderError {
    match error.downcast_ref::<Trap>() {
        Some(Trap::OutOfFuel) => RenderError::Interrupted,
        Some(trap) => RenderError::Trapped(trap.to_string()),
        None => RenderError::Internal(error.to_string()),
    }
}

impl Render for RenderHost {
    fn render(&self, cut: &[i16], ratio: Ratio, method: Method) -> Result<Vec<i16>, RenderError> {
        self.run(cut, ratio.p, ratio.q, method as u32, None)
            .map(|(out, _)| out)
    }

    fn output_frames(&self, in_len: u32, ratio: Ratio) -> Result<u32, RenderError> {
        RenderHost::output_frames(self, in_len, ratio)
    }

    fn identity(&self) -> &RendererIdentity {
        &self.identity
    }
}
