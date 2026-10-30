# graft

A sound has a past. Hear how this one was made, then make the next step.

graft is a sound's ancestry, rolled as playable credits. Open a sound, hear the chain of cuts and flips that led to it, scrub through it, and make one new flip of your own.

In graft's words: a **flip** is a sound with a part cut out and its speed changed; a **stage** is one flip (or the first, the **source**); the **chain** is the stages from the source to the newest flip; the **roll** is the chain shown as credits, one stage after another, beside a **record** you can drag a needle across.

![The home page: the last stage of the seeded chain as a torn-paper title, its credits beside it, and the record with its needle](assets/readme/home-roll.jpg)

graft is an independent experiment. It is not affiliated with or endorsed by any product named in it.

Every fact the project shows about a sound is one of three things: declared (said by a person), computed (produced by the system) or unknown (not established). The same applies to this repository: where a claim is measured, the test or number that backs it is named; where it is not, it says so.

## What it is, and is not

A visitor opens a sound and sees its ancestry as a roll of credit stages beside a large record. Each stage is one flip: a cut of the sound before it, at a speed. Pressing play hears the finished flip first, then each step from the source forward to the finished flip, with a short caption for each (the first visit only); dragging the needle jumps to a step. "Make a flip" cuts a stage, hears it, and publishes it, so the chain grows by one. Nothing sounds until the visitor presses play.

The server renders every published flip with one canonical, integer-only renderer, so the same input gives the same bytes on every host the tests cover. The renderer is a single WebAssembly artefact for that reason, and the claim is "reproducible for this renderer version and these published vectors"; the repository carries the vectors and the replay tool that check it. The rest of the service is Rust to keep one language end to end and to learn it, not because the product needs it.

Perform plays the stages as an instrument: the number row plays stages 1 to 12 by position, and a pad for every stage does the same by touch, so a run of presses can be played as a phrase. A key plays a whole stage and nothing else. Rec keeps the pads you press (up to sixteen seconds) as a phrase: which pad and when, never any sound, held in the page's own address, so copying the link sends it; a link you open only offers it and never plays by itself. It is not a sampler (there is no slicing, no grid or tempo and no export of sound), not a social network (no accounts, no feeds), and not a statement about scale: no number here is extrapolated to a number of users. It does not check who made a sound or whether they hold the right to share it; it says so on the page.

## Try it

The dev site is at https://graft-fawn-six.vercel.app. Press play: the first visit is narrated, one short caption for each step of how the sound was made, and then three small hints show what you can do next (drag the needle to hear any moment; mark a part of a stage, change its speed, flip it; press "perform" and then 1 2 3 to play the stages). "keys" lists every keyboard control of the page you are on. "make a flip" in the header opens a ready-made flip of the stage in view, so one tap on "hear it" gives sound. "? how it works" (on the roll, the make page and the about page) plays the guide again whenever you want it. Publishing a flip gives a link anyone can open and flip again.

The home page plays from a snapshot that ships with the site, so it works even while the service is asleep. The service sleeps when nobody is using it (to keep the cloud bill small): opening any page asks it to wake, a chain page opened in the meantime says so and opens by itself, and a cold start was measured at about a minute, never instant. See "Deployment".

## How it is put together

```mermaid
flowchart LR
  B["Browser"] -->|"pages"| W["Site on Vercel (Next.js)"]
  B -->|"JSON"| S["Service: one Rust container (ECS on Fargate, ARM64)"]
  B -->|"short-lived signed links"| O[("Audio in S3")]
  S --> R["Canonical renderer (.wasm under wasmtime)"]
  S --> P[("Postgres (Aurora Serverless v2)")]
  S --> O
  P --> E["Event ledger, relay, consumer, hourly rollups"]
```

One service and one database. A publish renders the flip, stores the audio, writes the publication and its event in one transaction, and answers; a retried request is handled once. The home page plays from a static snapshot of the seeded chain, so it works before the service has answered. ARCHITECTURE.md has the module boundaries, the concurrency and idempotency guarantees with the tests that show them, the abuse limits and their honest edges, the threat model, and the runbook.

## What has been measured

One load run on a clean copy of the dev environment: one Fargate task of 0.5 vCPU and 1 GB, ARM64, and Aurora Serverless v2 capped at 1 unit, driven by one laptop over a home connection with the per-address limits lifted so the service was measured and not the limiter. In the full profile (five minutes of one-minute phases: 60 chain reads a second; flips at 6 a second; a mixed run of 60 requests a second, a fifth of them flips; and a ramp to 12 flips a second) it published 1,843 flips with no errors that were not a named refusal. Publish took 79 ms at the median and 132 ms at the 99th percentile; reading a chain took 12 ms and 26 ms. The client's counts, the service's counters and the database's counts agreed exactly.

What bent is also on record: at 250 reads a second the 1-unit database was the limit (a chain read took 289 ms at the median, 13 ms with the cap raised to 4 units), and in the stress run, from about 50 flips a second, publish had a tail of about 5.5 seconds whose cause is a hypothesis that was not tested. No flips-a-second ceiling is claimed. ARCHITECTURE.md, "Measured numbers", has the table, the raw results are in `loadtest/results/`, and the limits are stated beside them.

## What exists, and what does not

The backend runs end to end and is tested against real Postgres and a real S3-compatible object store: seed a source, publish a flip, read the chain, manage your own publication with its key, report a sound, hide it as the operator, and serve audio through short-lived signed links. It has abuse limits and a runtime kill switch, an event path (a transactional outbox, a relay, an idempotent consumer, hourly rollups), a guarded client event endpoint, visitor source uploads (a setting, off by default; on for the dev demo), and traces, metrics and error reports that send nothing personal. The web app has the playback engine, the home page and its record, any publication's link with every state designed (removed, held, not found, offline), the make flow, with recording and adding your own sound (publishing it is refused unless uploads are switched on), the manage, report and about screens, and the operator's page at `/admin` behind the admin secret. Browser tests run the whole suite in Chromium, with accessibility and frame-budget checks, and the core loop in Firefox and WebKit. A first visit gets a three-note guide drawn over the real screen, and the stylus can mark a part of any stage on the record and carry it into the make flow.

One dev environment is deployed, by choice and with no staging or production (see "Deployment"). Not done: the GitHub deploy workflow has never run; no test on a real phone or in Safari on a device; no listening test with people outside the project.

## What is declared, computed and unknown

Every statement the roll makes about a stage carries one of three states, written out in words next to it (colour never carries a state alone).

- **Declared**: a person said it, and it is printed as typed: a title, a name, a licence line, a statement about the right to share. graft keeps the words and does not check them. The seeded chain's sound is declared as synthesized for graft, by the author of this repository.
- **Computed**: the system produced it and can produce it again. The cut in frames, the speed as a fraction (shown as a percentage and the nearest musical interval), the length, the identifiers, the hash of the audio and the renderer's name are computed from the stored record. "Reproducible" is claimed only for the named renderer version and the published test vectors; a hash says which bytes, and nothing more.
- **Unknown**: nothing establishes it. That is the default for who really made a sound and whether they hold the right to share it. graft does not verify a recording or a licence, so those lines say "unknown" or "not established", and the roll ends on an empty label marked "maker unknown".

## The sounds a maker can start from

Ten short sounds, all made for graft by `scripts/curated-sources.mjs` (a synthesizer in a script, no samples, no downloads): 808 sub, chip arpeggio, power up, saber hum, laser zap, metal clang, house stab, dm9 chord, upright bass and trap hats. Each is declared as "own work, synthesized for graft", which graft prints as typed and does not check, and each is stored as canonical audio in `seed/sources/` with its hash in `seed/sources.json`. There is nothing third-party in the set, so there is no licence page to link; if a downloaded sound is ever added it will carry its licence, its link and the date the licence was checked. `node scripts/curated-sources.mjs --check` remakes the files and says if any differs.

## Run it

To just see it on your machine, with the service, a database and the seeded chain: `sh scripts/dev-local.sh` (needs Docker, Rust and pnpm; the site is then at http://127.0.0.1:3100). The rest of this section is the individual pieces and the tests.


Needs the pinned Rust toolchain (installed from `rust-toolchain.toml` by rustup) and Node 24 with pnpm.

```sh
sh scripts/build-wasm.sh                 # the canonical renderer artefact
docker run -d --name graft-dev-pg -e POSTGRES_PASSWORD=graft -p 127.0.0.1:55432:5432 postgres:16
cargo test --workspace --all-features   # vectors on every Rust host, plus the tests that need Postgres
cd web && pnpm install && pnpm dev       # the site alone: the home page plays from its snapshot; chain pages need a running service
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

The event queue tests need a queue service. This is an emulator (ElasticMQ, pinned by digest), not AWS:

```sh
docker run -d --name graft-dev-sqs -p 127.0.0.1:59324:9324 \
  softwaremill/elasticmq-native@sha256:e4580ab9ad1bd5cd37b4ba04911bc5ccc8cd2d9ab4de56ece65acee71c24e05c
GRAFT_TEST_SQS_ENDPOINT=http://127.0.0.1:59324 AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x AWS_REGION=us-east-1 \
  cargo test -p graft-queue --test emulator -- --ignored --test-threads=1
GRAFT_TEST_SQS_ENDPOINT=http://127.0.0.1:59324 sh scripts/queue-e2e.sh   # the real service with the queue on
```

The other queue tests (the envelope, the consumer, the equivalence with the Postgres-only path) need no emulator and run in a plain `cargo test`.

With both containers running, `sh scripts/dev-local.sh` starts the whole thing on this machine: the service (visitor uploads on; `--no-uploads` leaves them off, as every environment ships), the seeded chain, and the built site at `http://127.0.0.1:3100`. Stop it with Ctrl-C. It keeps its own database and bucket prefix between runs and touches nothing else.

To run the service alone against that container:

```sh
GRAFT_DATABASE_URL=postgres://postgres:graft@127.0.0.1:55432/postgres cargo run -p graft-api
```

It serves `GET /v1/chains/{id}` and `GET /v1/publications/{id}`, `POST /v1/publications` (publish a flip), `PUT /v1/publications/{id}/fork-permission` and `POST /v1/publications/{id}/withdraw` (with the manage key), `POST /v1/reports`, `POST /v1/events` (the browser's best-effort counts), `POST /v1/sources` (visitor uploads; answers "uploads are switched off" unless `GRAFT_UPLOADS=on`), `/openapi.json`, `/health`, `/ready` and `/metrics`, and operator routes under `/admin` when `GRAFT_ADMIN_SECRET` is set (reports, hiding, the kill switch, the rollups). `graft-seed` creates a source (a root publication) from a canonical audio file; `graft-seed-chain` seeds the chain the roll opens on through the visitor publish path and writes or checks its static snapshot (see ARCHITECTURE.md, "First open and the static snapshot"); `graft-rebuild-rollups` rebuilds the event rollups from the ledger. Running any of them twice changes nothing.

## Deployment

A dev environment is deployed: the site on Vercel and the service as one container on AWS (ECS Express Mode on Fargate ARM64, Aurora Serverless v2 and S3, in Mumbai). It was created by `scripts/aws-dev.sh`, which names only `graft-dev-*` resources, records every change, and can remove them all. The service can be parked (`scripts/aws-dev.sh park`: no running task, so the database pauses about 16 minutes later) and woken again; the costs are estimates, about 4 USD a day running and about 1.3 USD a day parked, and no budget alarm is set. The GitHub deploy workflow (`.github/workflows/deploy.yml`) is written and has never run. There is no staging or production environment. ARCHITECTURE.md, "Hosting and environments", says what was shown and what was not; "Measured numbers" has the first load measurement and its limits.

**Sleeping and waking.** A small function (`tools/wake`, made by `scripts/aws-dev.sh wake`) starts the service when a call carries a shared secret and, when switched on, stops it after 30 minutes with no request (and never inside a warm window set by `make warm`). The site's own server forwards the call when a page opens (`/api/wake`, settings `GRAFT_WAKE_URL` and `GRAFT_WAKE_SECRET`, inert without them). A monthly budget (`scripts/aws-dev.sh budget`) emails a warning at 45 USD of a 60 USD ceiling; it warns and does not stop spending. The decisions are plain functions with tests, and the cold start, the warm window and the health-check question were checked against the real service (the runbook in ARCHITECTURE.md has the rows).

Secrets, by name only (they live in the platform's store, never in this repository): `GRAFT_DATABASE_URL`, `GRAFT_ADMIN_SECRET`, optionally `GRAFT_ERROR_TRACKER_DSN`, and `GRAFT_BLOB_S3_ACCESS_KEY_ID` with `GRAFT_BLOB_S3_SECRET_ACCESS_KEY` only when the bucket is not reached through the container's role. Visitor uploads (`GRAFT_UPLOADS`) are off by default and are switched ON for the dev demo, a decision made on 2026-10-28 with the risk stated plainly: graft cannot check whether someone may share a sound, so the make page says so before and at publish, anyone can report a sound without an account, the operator can hide it (flips built on it are held while its rights are looked at), and one operator call closes every write at once (`PUT /admin/switch`). Per-address and global limits, a storage ceiling and checks on the audio itself still apply.

## What the limits do and do not promise

Every write is limited, and every refusal says why and when to try again (ARCHITECTURE.md, "Abuse guardrails"). The honest edges: a runtime kill switch closes publishing without a redeploy but leaves reads, reports and withdrawals open; the per-address limits count in one process's memory and are forgotten after their window, so a second instance gives each visitor a second allowance (the global publish cap, which lives in the database, holds across instances); and the storage limit is an admission threshold, not a hard cap: publishes admitted between two readings of the stored total can overshoot it, by at most the global cap's burst plus one refresh interval of its refill, each as large as the largest allowed blob (about 61 MB with the defaults). Someone can still publish what they should not; these limits cap how fast and how much, and the report, hide and kill switch let the operator respond. They do not make misuse impossible.

## Events, rollups and what they cannot recover

Only server events (a publication was created, a report was filed) can never diverge from the write they describe; they commit in the same transaction. Client events are best-effort counts and never feed a public fact. Raw events are kept 30 days and hourly rollups are kept for good, so **rollups older than the 30-day window cannot be rebuilt**: `graft-rebuild-rollups` recounts only the hours the ledger still holds and carries older hours over as they are. The analytics path is designed to avoid personal data (no address, user agent or account is stored in it, and a browser that signals Global Privacy Control or Do Not Track sends nothing); that is a design aim and not a legal certification. graft stores no IP address in its own records; the hosting providers necessarily process addresses to deliver traffic.

## Where to look when something is wrong

Logs are JSON on standard output, one line per event, each with its request id (`x-request-id` on the response) and, when traces are exported, its trace id. Metrics are at `/metrics` in the Prometheus text format, behind the operator secret (requests, publish outcomes, renders, refusals by reason, the kill switch, relay backlog and consumer lag). Traces go to the OTLP endpoint in `OTEL_EXPORTER_OTLP_ENDPOINT` when one is set. Server errors and panics go to the error tracker in `GRAFT_ERROR_TRACKER_DSN` when one is set, with no personal data. The operator reads the event path at `GET /admin/rollups` and closes publishing with `PUT /admin/switch`. ARCHITECTURE.md ("Observability and operations") has the example alert rules and its "Operator runbook" lists each task with what was run and where.

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

`dev` is the working branch. Branch from `dev`, open a pull request into `dev` (plain conventional commits, CI green; merged with a merge commit, so the branch's commits stay in the history). `staging` and `main` only receive promotion pull requests from the branch before them. Enable the local hooks once with `git config core.hooksPath .githooks`: they check formatting and commit messages only, and finish in about a second.

`sh scripts/precheck.sh` runs the fast checks locally in about half a minute (`--full` adds the whole test suite): run it before pushing, because a CI run costs ten minutes. The slow jobs are skipped on a pull request that cannot affect them (see ARCHITECTURE.md, "Determinism evidence"). Checks that run on pull requests: rustfmt, clippy with warnings as errors, tests, the crate dependency direction (`scripts/check-crate-graph.mjs`), cargo-deny, cargo-audit, a secret scan, TypeScript strict, ESLint, Prettier, a production build, `pnpm audit`, and repository hygiene (`scripts/check-repo.mjs`).

## Licence

Apache License 2.0: see [LICENSE](LICENSE). You may use, copy, change and distribute this code under its terms, which include a patent grant and a requirement to keep the notices. The ten sounds in `seed/sources/` are original works made for graft by a script and are covered by the same licence. Sounds that visitors publish are not part of this repository: each is declared by whoever published it, and graft does not check those declarations (see "Takedown" on the about page).
