#!/bin/sh
# Builds the renderer artefact from two copies of the tracked tree in directories of different depth
# (and, for the second, a different CARGO_HOME) and fails unless the two .wasm files are byte-identical. Prints the hash.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
build() { # <dir> <cargo home or empty>
  mkdir -p "$1"
  git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$1"
  if [ -n "${2:-}" ]; then export CARGO_HOME="$2"; mkdir -p "$2"; fi
  (cd "$1" && CARGO_TARGET_DIR="$1/target" sh scripts/build-wasm.sh >/dev/null)
  shasum -a 256 "$1/target/wasm32-unknown-unknown/wasm/graft_render.wasm" | cut -d' ' -f1
}
a=$(build "$work/one/src")
b=$(build "$work/two/deeper/path/checkout" "$work/other-cargo-home")
if [ "$a" != "$b" ]; then
  echo "renderer build is not reproducible: $a != $b" >&2
  exit 1
fi
echo "renderer build reproducible: $a"
