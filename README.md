# graft

A sound's ancestry, rolled as playable credits. Open a sound, hear the chain of cuts and flips that led to it, scrub through it, and make one new flip of your own.

graft is an independent experiment. It is not affiliated with or endorsed by any product named in it.

Every fact the project shows about a sound is one of three things: declared (said by a person), computed (produced by the system) or unknown (not established). The same applies to this repository: where a claim is measured, the test or number that backs it is named; where it is not, it says so.

> Status: foundation only (repository, renderer, render host, cross-host checks). Nothing here runs end to end yet. Sections below are filled in by the work that owns them.

## What it is, and is not

_Written by ticket 37 (docs consolidation)._

## Run it

Needs the pinned Rust toolchain (installed from `rust-toolchain.toml` by rustup) and Node 24 with pnpm.

```sh
sh scripts/build-wasm.sh                 # the canonical renderer artefact
cargo test --workspace                   # includes the vector table on every Rust host
cd web && pnpm install && pnpm dev       # the UI shell (a blank page for now)
```

The service itself arrives with the backend tickets; there is nothing to call yet.

## Vectors replay tool

`vectors-replay` runs the renderer vector table against any artefact and exits non-zero on any difference, naming the vector with the expected and actual hash.

```sh
sh scripts/build-wasm.sh
cargo run -q -p graft-vectors --bin vectors-replay -- target/wasm32-unknown-unknown/wasm/graft_render.wasm
cargo run -q -p graft-vectors --bin vectors-replay -- --help
```

`--host native` replays the table against the Rust library instead; `--host render-host` uses the service's own host (and checks the artefact against the pinned hash); `--emit <vector>` writes one vector's raw output.

## Working on it

`dev` is the working branch. Branch from `dev`, open a pull request into `dev` (squashed, plain conventional commit, CI green). `staging` and `main` only receive promotion pull requests from the branch before them. Enable the local hooks once with `git config core.hooksPath .githooks`: they check formatting and commit messages only, and finish in about a second.

Checks that run on every pull request: rustfmt, clippy with warnings as errors, tests, the crate dependency direction (`scripts/check-crate-graph.mjs`), cargo-deny, cargo-audit, a secret scan, TypeScript strict, ESLint, Prettier, a production build, `pnpm audit`, and repository hygiene (`scripts/check-repo.mjs`).

## Licence

_Undecided._
