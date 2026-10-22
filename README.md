# graft

A sound's ancestry, rolled as playable credits. Open a sound, hear the chain of cuts and flips that led to it, scrub through it, and make one new flip of your own.

graft is an independent experiment. It is not affiliated with or endorsed by any product named in it.

Every fact the project shows about a sound is one of three things: declared (said by a person), computed (produced by the system) or unknown (not established). The same applies to this repository: where a claim is measured, the test or number that backs it is named; where it is not, it says so.

> Status: the backend runs end to end and is tested against real Postgres and a real S3-compatible object store: seed a source, publish a flip (rendered on the server by the canonical renderer), read the chain, manage your own publication with its key, report a sound, hide it as the operator, and serve audio through short-lived signed URLs. The web app is a shell and the playback engine has no screen yet; abuse limits, the event path, observability beyond the baseline, and deployment are not built. Sections below are filled in by the work that owns them.

## What it is, and is not

_Written by ticket 37 (docs consolidation)._

## Run it

Needs the pinned Rust toolchain (installed from `rust-toolchain.toml` by rustup) and Node 24 with pnpm.

```sh
sh scripts/build-wasm.sh                 # the canonical renderer artefact
docker run -d --name graft-dev-pg -e POSTGRES_PASSWORD=graft -p 127.0.0.1:55432:5432 postgres:16
cargo test --workspace --all-features   # vectors on every Rust host, plus the tests that need Postgres
cd web && pnpm install && pnpm dev       # the UI shell (a blank page for now)
```

The tests that need Postgres create a private database each on the server named by `GRAFT_TEST_DATABASE_URL` (default: the container above) and remove it afterwards.

The blob tests need an S3-compatible server and a bucket. These are throwaway local credentials for a throwaway container:

```sh
docker run -d --name graft-dev-s3 -p 127.0.0.1:59000:9000 \
  -e RUSTFS_ACCESS_KEY=graftaccess -e RUSTFS_SECRET_KEY=graftsecret12345 \
  rustfs/rustfs@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b
curl -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user graftaccess:graftsecret12345 http://127.0.0.1:59000/graft-test
```

`GRAFT_TEST_S3_ENDPOINT` names a different server (default `http://127.0.0.1:59000`). To keep audio in the bucket when running the service, set `GRAFT_BLOB_S3_BUCKET`, the two credentials, `GRAFT_BLOB_S3_ENDPOINT` and `GRAFT_BLOB_S3_ALLOW_HTTP=true` (see ARCHITECTURE.md, "Configuration"). `graft-blob-cleanup` removes audio that no record uses any more.

To run the service against that container:

```sh
GRAFT_DATABASE_URL=postgres://postgres:graft@127.0.0.1:55432/postgres cargo run -p graft-api
```

It serves `GET /v1/chains/{id}` and `GET /v1/publications/{id}`, `POST /v1/publications` (publish a flip), `PUT /v1/publications/{id}/fork-permission` and `POST /v1/publications/{id}/withdraw` (with the manage key), `POST /v1/reports`, `/openapi.json`, `/health`, `/ready` and `/metrics`, and operator routes under `/admin` when `GRAFT_ADMIN_SECRET` is set. `graft-seed` creates a source (a root publication) from a canonical audio file; running it twice with the same key changes nothing.

## Concurrency

Forks of one stage cannot lose each other, and a retried request is handled once. The evidence is in the tests, not in an argument: `crates/api/tests/races.rs` sends 40 simultaneous forks at one stage over a pool of 16 database connections, through the real router, Postgres and renderer, and checks that all are published and counted exactly once; `crates/storage/tests/races.rs` forces conflicts, a busy lock and a panic on purpose. ARCHITECTURE.md ("Concurrency and idempotency") states the guarantees and what the tests do not show. No claim is made about scale.

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

`sh scripts/precheck.sh` runs the fast checks locally in about half a minute (`--full` adds the whole test suite): run it before pushing, because a CI run costs ten minutes. The slow jobs are skipped on a pull request that cannot affect them (see ARCHITECTURE.md, "Determinism evidence"). Checks that run on pull requests: rustfmt, clippy with warnings as errors, tests, the crate dependency direction (`scripts/check-crate-graph.mjs`), cargo-deny, cargo-audit, a secret scan, TypeScript strict, ESLint, Prettier, a production build, `pnpm audit`, and repository hygiene (`scripts/check-repo.mjs`).

## Licence

_Undecided._
