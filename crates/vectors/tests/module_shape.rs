#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly

//! The canonical artefact has the shape the determinism claim relies on: it imports nothing, exports
//! exactly the documented surface, and contains no floating-point instruction or value type.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;
use wasmparser::{CompositeInnerType, Parser, Payload, ValType};

/// Built and read once per test binary. Tests run in parallel, and every cargo invocation briefly
/// re-links the output file, so a test that read it while another built it saw "not found".
fn artefact() -> Vec<u8> {
    static BUILT: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BUILT.get_or_init(build_artefact).clone()
}

fn build_artefact() -> Vec<u8> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = Command::new("sh")
        .arg(root.join("scripts/build-wasm.sh"))
        .status()
        .expect("build");
    assert!(status.success(), "scripts/build-wasm.sh failed");
    std::fs::read(root.join("target/wasm32-unknown-unknown/wasm/graft_render.wasm")).expect("read")
}

fn is_float(t: ValType) -> bool {
    matches!(t, ValType::F32 | ValType::F64)
}

#[test]
fn artefact_has_no_imports_and_the_exact_export_surface() {
    let wasm = artefact();
    let mut imports = 0usize;
    let mut exports = BTreeSet::new();
    for payload in Parser::new(0).parse_all(&wasm) {
        match payload.expect("valid module") {
            Payload::ImportSection(s) => imports += s.count() as usize,
            Payload::ExportSection(s) => {
                for e in s {
                    exports.insert(e.expect("export").name.to_string());
                }
            }
            _ => {}
        }
    }
    assert_eq!(
        imports, 0,
        "the browser instantiates this with an empty import object"
    );
    let want: BTreeSet<String> = [
        "memory",
        "graft_version",
        "graft_alloc",
        "graft_free",
        "graft_out_len",
        "graft_render",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    assert_eq!(exports, want, "only the documented C-ABI is exported");
}

#[test]
fn artefact_contains_no_floating_point() {
    let wasm = artefact();
    let mut offenders = Vec::new();
    for payload in Parser::new(0).parse_all(&wasm) {
        match payload.expect("valid module") {
            Payload::TypeSection(s) => {
                for group in s {
                    for ty in group.expect("type").types() {
                        if let CompositeInnerType::Func(f) = &ty.composite_type.inner
                            && f.params().iter().chain(f.results()).any(|t| is_float(*t))
                        {
                            offenders.push(
                                "a function type with a float parameter or result".to_string(),
                            );
                        }
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                for local in body.get_locals_reader().expect("locals") {
                    if is_float(local.expect("local").1) {
                        offenders.push("a float local".to_string());
                    }
                }
                let mut ops = body.get_operators_reader().expect("operators");
                while !ops.eof() {
                    let op = format!("{:?}", ops.read().expect("operator"));
                    if op.contains("F32") || op.contains("F64") {
                        offenders.push(op);
                    }
                }
            }
            _ => {}
        }
    }
    assert!(offenders.is_empty(), "floating point found: {offenders:?}");
}
