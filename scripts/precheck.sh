#!/bin/sh
# What CI would say, before you push, in a minute or two instead of ten. Run it from anywhere:
#   sh scripts/precheck.sh          fast: formatting, lints, repository rules, API contract, web checks
#   sh scripts/precheck.sh --full   also the whole Rust test suite (needs the dev containers in README.md)
# It is not a hook: it never blocks a commit or a push, it only tells you.
set -eu
cd "$(dirname "$0")/.."
step() { printf '\n== %s\n' "$1"; }

step "rustfmt"
cargo fmt --all --check
step "clippy (warnings are errors)"
cargo clippy --workspace --all-targets --all-features -- -D warnings
step "repository rules, crate graph, scripts"
node scripts/check-repo.mjs
node scripts/check-crate-graph.mjs
node --test scripts/*.test.mjs loadtest/*.test.mjs >/dev/null
step "OpenAPI document and the typed client match the service"
cargo run -q -p graft-api --bin graft-openapi | diff -u openapi/openapi.json -
(cd web && pnpm generate:api >/dev/null && git diff --exit-code -- lib/api/schema.d.ts)
step "web: typecheck, lint, format, unit tests"
(cd web && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test)
step "commit messages are plain"
git fetch -q origin 2>/dev/null || true
base=$(git rev-parse --verify -q origin/dev || echo HEAD)
node scripts/lint-commit-msg.mjs --range "$base..HEAD"

if [ "${1:-}" = "--full" ]; then
  step "rust tests (Postgres and the object store must be running: see README.md)"
  cargo test --workspace --all-features
  step "playback test in Chromium"
  (cd web && pnpm exec playwright test)
fi
printf '\nall checks passed\n'
