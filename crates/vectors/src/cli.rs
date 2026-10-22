//! The vectors replay command: runs a vector table against an artefact and says what differs.

use crate::host::{Host, Outcome};
use crate::hosted::HostedRenderer;
use crate::native::NativeHost;
use crate::run::{Check, run_canonicalisation, run_table};
use crate::table::Table;
use crate::wasm::WasmtimeHost;
use std::io::Write;
use std::path::PathBuf;

/// Help text, printed for `--help` and after a usage error.
pub const USAGE: &str = "\
vectors-replay: run the renderer vector table against an artefact and report every difference

USAGE:
    vectors-replay [OPTIONS] <ARTEFACT.wasm>
    vectors-replay --host native [OPTIONS]

ARGS:
    <ARTEFACT.wasm>   the renderer artefact to run (not needed with --host native)

OPTIONS:
    --table <PATH>    vector table (default: fixtures/vectors/vectors.json)
    --host <NAME>     wasmtime (default), render-host (the service's host, with pin check), or native
    --only <NAME>     run only the checks whose name contains NAME
    --emit <VECTOR>   write that vector's raw output (signed 16-bit little-endian) to standard
                      output instead of replaying; needs --host native or wasmtime
    -h, --help        show this help

Prints PASS or FAIL per check, with the expected and actual hash for each failure.
Exit status: 0 all checks passed, 1 at least one check failed, 2 usage error, 3 could not load.";

/// Process exit codes.
pub mod exit {
    /// Every check passed.
    pub const OK: i32 = 0;
    /// At least one check failed.
    pub const MISMATCH: i32 = 1;
    /// Bad command line.
    pub const USAGE: i32 = 2;
    /// The table or artefact could not be loaded.
    pub const LOAD: i32 = 3;
}

/// Which host to replay on; the artefact-running hosts carry the artefact's path, so a missing path
/// cannot be represented.
enum HostChoice {
    Wasmtime(PathBuf),
    RenderHost(PathBuf),
    Native,
}

struct Options {
    table: PathBuf,
    host: HostChoice,
    only: Option<String>,
    emit: Option<String>,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut table = PathBuf::from("fixtures/vectors/vectors.json");
    let (mut host, mut only, mut emit, mut artefact) = ("wasmtime".to_string(), None, None, None);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().cloned().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--table" => table = PathBuf::from(value("--table")?),
            "--only" => only = Some(value("--only")?),
            "--emit" => emit = Some(value("--emit")?),
            "--host" => host = value("--host")?,
            flag if flag.starts_with('-') => return Err(format!("unknown option `{flag}`")),
            path if artefact.is_none() => artefact = Some(PathBuf::from(path)),
            extra => return Err(format!("unexpected argument `{extra}`")),
        }
    }
    let need =
        |artefact: Option<PathBuf>| artefact.ok_or("an artefact path is required for this host");
    let host = match host.as_str() {
        "wasmtime" => HostChoice::Wasmtime(need(artefact)?),
        "render-host" => HostChoice::RenderHost(need(artefact)?),
        "native" => HostChoice::Native,
        other => return Err(format!("unknown host `{other}`")),
    };
    Ok(Options {
        table,
        host,
        only,
        emit,
    })
}

fn make_host(choice: &HostChoice) -> Result<Box<dyn Host>, String> {
    let (HostChoice::Wasmtime(path) | HostChoice::RenderHost(path)) = choice else {
        return Ok(Box::new(NativeHost));
    };
    let wasm = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let load_error = |e: &dyn std::fmt::Display| format!("cannot load {}: {e}", path.display());
    if matches!(choice, HostChoice::Wasmtime(_)) {
        WasmtimeHost::new(&wasm)
            .map(|h| Box::new(h) as Box<dyn Host>)
            .map_err(|e| load_error(&e))
    } else {
        HostedRenderer::load(&wasm)
            .map(|h| Box::new(h) as Box<dyn Host>)
            .map_err(|e| load_error(&e))
    }
}

fn emit(table: &Table, host: &mut dyn Host, name: &str, out: &mut dyn Write) -> Result<(), String> {
    let v = table
        .vector(name)
        .ok_or(format!("no vector named `{name}`"))?;
    match host.render(&v.input.generate(), v.p, v.q, v.method, v.out_cap) {
        Outcome::Status { code, out: frames } if code > 0 => {
            let bytes: Vec<u8> = frames.iter().flat_map(|f| f.to_le_bytes()).collect();
            out.write_all(&bytes).map_err(|e| e.to_string())
        }
        other => Err(format!("vector `{name}` did not render: {other:?}")),
    }
}

/// Runs the command. Returns the process exit status.
pub fn run(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        let _ = writeln!(out, "{USAGE}");
        return exit::OK;
    }
    let options = match parse(args) {
        Ok(o) => o,
        Err(message) => {
            let _ = writeln!(err, "error: {message}\n\n{USAGE}");
            return exit::USAGE;
        }
    };
    let table = match Table::load(&options.table) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(err, "error: {e} ({})", options.table.display());
            return exit::LOAD;
        }
    };
    let mut host = match make_host(&options.host) {
        Ok(h) => h,
        Err(message) => {
            let _ = writeln!(err, "error: {message}");
            return exit::LOAD;
        }
    };
    if let Some(name) = &options.emit {
        return match emit(&table, host.as_mut(), name, out) {
            Ok(()) => exit::OK,
            Err(message) => {
                let _ = writeln!(err, "error: {message}");
                exit::LOAD
            }
        };
    }
    let mut checks: Vec<Check> = run_table(&table, host.as_mut());
    checks.extend(run_canonicalisation(&table));
    if let Some(only) = &options.only {
        checks.retain(|c| c.name.contains(only.as_str()));
    }
    report(host.name(), &checks, out)
}

fn report(host: &str, checks: &[Check], out: &mut dyn Write) -> i32 {
    let mut failed = 0;
    for c in checks {
        if c.passed {
            let _ = writeln!(out, "PASS  {}", c.name);
        } else {
            failed += 1;
            let _ = writeln!(
                out,
                "FAIL  {}\n        expected {}\n        actual   {}",
                c.name, c.expected, c.actual
            );
        }
    }
    let _ = writeln!(
        out,
        "{host}: {} passed, {failed} failed",
        checks.len() - failed
    );
    if failed == 0 {
        exit::OK
    } else {
        exit::MISMATCH
    }
}
