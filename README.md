# graft

A sound's ancestry, rolled as playable credits. Open a sound, hear the chain of cuts and flips that led to it, scrub through it, and make one new flip of your own.

graft is an independent experiment. It is not affiliated with or endorsed by any product named in it.

Every fact the project shows about a sound is one of three things: declared (said by a person), computed (produced by the system) or unknown (not established). The same applies to this repository: where a claim is measured, the test or number that backs it is named; where it is not, it says so.

> Status: the backend runs end to end and is tested against real Postgres and a real S3-compatible object store: seed a source, publish a flip (rendered on the server by the canonical renderer), read the chain, manage your own publication with its key, report a sound, hide it as the operator, and serve audio through short-lived signed URLs. It also has the abuse limits and a runtime kill switch, the event path (a transactional outbox, a relay, an idempotent consumer and hourly rollups), a guarded client event endpoint, visitor source uploads (switched off by default), the seeded chain with its static snapshot, and traces, metrics and error reporting that send nothing personal. The web app has a tested playback engine and the home page: the seeded chain as a roll of credit stages (torn-paper title slabs, wall-label credits) beside a large record you can scrub, in the locked look, played from a static snapshot; any publication's link opens its chain with every state designed (removed, held, not found, offline); an operator's page at `/admin` (reports, hide and lift, the kill switch, the event path) behind the admin secret; the make flow is not built, and deployment is not built. Sections below are filled in by the work that owns them.

## What it is, and is not

_Written by ticket 37 (docs consolidation)._

## What is declared, computed and unknown

Every statement the roll makes about a stage carries one of three states, written out in words next to it (colour never carries a state alone).

- **Declared**: a person said it, and it is printed as typed: a title, a name, a licence line, a statement about the right to share. graft keeps the words and does not check them. The seeded chain's sound is declared as synthesized for graft, by the author of this repository.
- **Computed**: the system produced it and can produce it again. The cut in frames, the speed as a fraction (shown as a percentage and the nearest musical interval), the length, the identifiers, the hash of the audio and the renderer's name are computed from the stored record. "Reproducible" is claimed only for the named renderer version and the published test vectors; a hash says which bytes, and nothing more.
- **Unknown**: nothing establishes it. That is the default for who really made a sound and whether they hold the right to share it. graft does not verify a recording or a licence, so those lines say "unknown" or "not established", and the roll ends on an empty label marked "maker unknown".

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

It serves `GET /v1/chains/{id}` and `GET /v1/publications/{id}`, `POST /v1/publications` (publish a flip), `PUT /v1/publications/{id}/fork-permission` and `POST /v1/publications/{id}/withdraw` (with the manage key), `POST /v1/reports`, `POST /v1/events` (the browser's best-effort counts), `POST /v1/sources` (visitor uploads; answers "uploads are switched off" unless `GRAFT_UPLOADS=on`), `/openapi.json`, `/health`, `/ready` and `/metrics`, and operator routes under `/admin` when `GRAFT_ADMIN_SECRET` is set (reports, hiding, the kill switch, the rollups). `graft-seed` creates a source (a root publication) from a canonical audio file; `graft-seed-chain` seeds the chain the roll opens on through the visitor publish path and writes or checks its static snapshot (see ARCHITECTURE.md, "First open and the static snapshot"); `graft-rebuild-rollups` rebuilds the event rollups from the ledger. Running any of them twice changes nothing.

## What the limits do and do not promise

Every write is limited, and every refusal says why and when to try again (ARCHITECTURE.md, "Abuse guardrails"). The honest edges: a runtime kill switch closes publishing without a redeploy but leaves reads, reports and withdrawals open; the per-address limits count in one process's memory and are forgotten after their window, so a second instance gives each visitor a second allowance (the global publish cap, which lives in the database, holds across instances); and the storage limit is an admission threshold, not a hard cap: publishes admitted between two readings of the stored total can overshoot it, by at most the global cap's burst plus one refresh interval of its refill, each as large as the largest allowed blob (about 61 MB with the defaults). Someone can still publish what they should not; these limits cap how fast and how much, and the report, hide and kill switch let the operator respond. They do not make misuse impossible.

## Events, rollups and what they cannot recover

Only server events (a publication was created, a report was filed) can never diverge from the write they describe; they commit in the same transaction. Client events are best-effort counts and never feed a public fact. Raw events are kept 30 days and hourly rollups are kept for good, so **rollups older than the 30-day window cannot be rebuilt**: `graft-rebuild-rollups` recounts only the hours the ledger still holds and carries older hours over as they are. The analytics path is designed to avoid personal data (no address, user agent or account is stored in it, and a browser that signals Global Privacy Control or Do Not Track sends nothing); that is a design aim and not a legal certification. graft stores no IP address in its own records; the hosting providers necessarily process addresses to deliver traffic.

## Where to look when something is wrong

Logs are JSON on standard output, one line per event, each with its request id (`x-request-id` on the response) and, when traces are exported, its trace id. Metrics are at `/metrics` in the Prometheus text format (requests, publish outcomes, renders, refusals by reason, the kill switch, relay backlog and consumer lag). Traces go to the OTLP endpoint in `OTEL_EXPORTER_OTLP_ENDPOINT` when one is set. Server errors and panics go to the error tracker in `GRAFT_ERROR_TRACKER_DSN` when one is set, with no personal data. The operator reads the event path at `GET /admin/rollups` and closes publishing with `PUT /admin/switch`. ARCHITECTURE.md ("Observability and operations") has the example alert rules; the full runbook comes with the launch gate.

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
