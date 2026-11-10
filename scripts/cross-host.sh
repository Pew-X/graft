#!/bin/sh
# The Rust side of the cross-host check, shared by the Linux and macOS jobs: build the artefact, check
# its pin, replay the table on each Rust host, run the Rust harness tests. Run from the repository root.
# A failing replay stops the script; the pipe-free capture keeps its exit status.
set -eu
art=target/wasm32-unknown-unknown/wasm/graft_render.wasm

run() { # print the summary line of a replay, or all of its output on failure
  out=$(mktemp)
  if "$@" >"$out"; then
    tail -n 1 "$out"
    rm -f "$out"
  else
    cat "$out"
    rm -f "$out"
    exit 1
  fi
}

sh scripts/build-wasm.sh
cargo build -q -p graft-vectors --bin vectors-replay
node scripts/check-wasm-pin.mjs "$art"
run target/debug/vectors-replay --host wasmtime "$art"
run target/debug/vectors-replay --host render-host "$art"
run target/debug/vectors-replay --host native
cargo test -p graft-vectors
