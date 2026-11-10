#!/bin/sh
# Builds the canonical renderer artefact: target/wasm32-unknown-unknown/wasm/graft_render.wasm
# Paths are remapped so the same source gives the same bytes from any checkout directory.
set -eu
# Ambient cargo/rustc configuration must not change the bytes.
unset CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET
for v in $(env | sed -n 's/^\(CARGO_PROFILE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
cd "$(dirname "$0")/.."
root=$(pwd)
sysroot=$(rustc --print sysroot)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
RUSTFLAGS="--remap-path-prefix=$root=/graft --remap-path-prefix=$sysroot=/rustc --remap-path-prefix=$cargo_home=/cargo -C strip=symbols" \
  cargo build --locked --profile wasm -p graft-render --target wasm32-unknown-unknown
