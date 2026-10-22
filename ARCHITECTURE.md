# Architecture

Each section names the ticket that writes it. A section that says "not written yet" describes work that has not happened.

## Module boundaries

One deployable Rust service plus a Next.js UI, built as a Cargo workspace. The arrows below are enforced in CI by `scripts/check-crate-graph.mjs`, which fails on any dependency edge (normal, dev or build) against them.

| Crate | Depends on | Role |
|---|---|---|
| `graft-domain` | nothing in the workspace | content record, publication, ancestry rules, honesty states, limits |
| `graft-render` | nothing at all | the integer renderer and its C-ABI wrapper, compiled to the canonical `.wasm` |
| `graft-storage` | domain | Postgres and blob store access behind traits |
| `graft-render-host` | domain | runs the canonical `.wasm` under wasmtime |
| `graft-events` | domain | outbox, relay, consumer, rollups behind an event-sink trait |
| `graft-api` | domain, storage, render-host, events | HTTP layer, OpenAPI, rate limits, admin routes, configuration |

Nothing depends on `graft-api`. `graft-render` is deliberately kept apart: the renderer is one artefact that must build alone, with no dependencies, to a reproducible `.wasm`.

Written by ticket 01.

## Toolchain and repository conventions

- Rust is pinned in `rust-toolchain.toml`, with the `wasm32-unknown-unknown` target. Node is pinned in `.node-version`, pnpm in `web/package.json`.
- Standards enforced in CI: rustfmt, clippy with warnings as errors, no `unwrap`/`expect`/`panic!` outside tests, `unsafe` denied by default (allowed only in the renderer's C boundary, with a written justification), TypeScript strict, ESLint, Prettier.
- Supply chain: cargo-deny (licences, advisories, sources), cargo-audit, `pnpm audit`, gitleaks. GitHub Actions are pinned to commit SHAs.
- Only code, scripts, README.md, ARCHITECTURE.md and configuration are committed. Commit messages are plain conventional text with no trailers or addresses; `scripts/lint-commit-msg.mjs` enforces that in the local hook and in CI, on every commit and on the pull request title.
- Branch flow: feature branch, then `dev` (squash), then `staging` and `main` by promotion pull requests (merge commit, so the branches stay aligned).

Written by ticket 01.

## Determinism contract

_Not written yet. Ticket 02 writes it._

## Render host

_Not written yet. Tickets 03 and 03b write it._

## Determinism evidence

_Not written yet. Ticket 04 writes it._

## Data model, concurrency, events, operations, security

_Not written yet. Tickets 05 onwards; consolidated by ticket 37 write it._
