#!/bin/sh
# Builds the canonical renderer artefact: target/wasm32-unknown-unknown/wasm/graft_render.wasm
# Paths are remapped so the same source gives the same bytes from any checkout directory.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
sysroot=$(rustc --print sysroot)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
RUSTFLAGS="--remap-path-prefix=$root=/graft --remap-path-prefix=$sysroot=/rustc --remap-path-prefix=$cargo_home=/cargo -C strip=symbols" \
  cargo build --locked --profile wasm -p graft-render --target wasm32-unknown-unknown
