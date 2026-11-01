# graft

A sound has a past. Hear how this one was made, then make the next step.

graft shows a sound's ancestry as playable credits. Open a sound, hear the chain of cuts and speed changes that led to it, scrub through it, and make one new flip of your own.

![The home page in dark mode: the last stage of the seeded chain as a torn-paper title, its credits beside it, and the record with its needle](assets/readme/home-dark.jpg)

- A **flip** is a sound with a part cut out and its speed changed.
- A **stage** is one flip, or the first sound, the **source**. The **chain** is the stages from the source to the newest flip.
- The **roll** shows the chain as credits, one stage after another, beside a **record** you can drag a needle across.

graft is an independent experiment.

<table>
  <tr>
    <td align="center" width="28%"><img src="assets/readme/make.jpg" width="100%" alt="The make page: a cut chosen on a waveform and a speed of about a fifth up"></td>
    <td align="center" width="55%"><img src="assets/readme/perform.jpg" width="100%" alt="Perform mode: four pads, one per stage, lit in their colours beside the record"></td>
    <td align="center" width="16%"><img src="assets/readme/phone.jpg" width="100%" alt="The same pads on a phone"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Make a flip.</b> Cut a piece, change its speed, hear it as you move.</sub></td>
    <td align="center"><sub><b>Perform.</b> The number keys and the pads play the stages of a chain.</sub></td>
    <td align="center"><sub><b>On a phone.</b> Everything works by touch.</sub></td>
  </tr>
</table>

Light and dark themes follow your system.

## Try it

The demo is at https://graft-fawn-six.vercel.app. Press the main button. The first visit is narrated: one short caption per step of how the sound was made, then three hints (drag the needle, mark a part and change its speed, press perform and then 1 2 3). "make a flip" in the header opens a ready-made flip of the stage in view, so one tap on "hear it" gives sound.

The home page plays from a snapshot that ships with the site, so it works even when the service is asleep. The service sleeps when nobody is using it, to keep the bill small. Opening any page wakes it; a chain page opened in the meantime says so and opens by itself, usually within a minute.

## How it works

```mermaid
flowchart LR
  B["Browser"] --> W["Site (Next.js, Vercel)"]
  B -->|"JSON"| S["Service (Rust, one container on AWS)"]
  B -->|"signed URLs"| O[("Audio (S3)")]
  S --> R["Renderer (.wasm)"]
  S --> P[("Postgres")]
  S --> O
```

- **One renderer, everywhere.** Every flip is rendered by one integer-only renderer compiled to a single WebAssembly file. The browser previews with it and the server renders with the same bytes, so what you hear is what is stored. The claim is "reproducible for this renderer version and these published test vectors", and the repository carries the vectors and the tool that checks it.
- **Honest credits.** Every fact shown about a sound is *declared* (a person said it), *computed* (the system produced it and can again) or *unknown* (not established). graft does not check who made a sound or whether they may share it, and says so on the page.
- **No accounts.** The maker of a flip gets a key, shown once, that can close or withdraw that flip. Nothing else is stored about people.
- **Sketches.** A sketch is a private try held in your browser until you publish it, so you can keep several directions of one sound, hear up to twelve together on pads, and publish the ones you like.
- **Perform.** The number row plays stages 1 to 12; pads do the same by touch. A press plays one stage and nothing else.

[ARCHITECTURE.md](ARCHITECTURE.md) has the design with diagrams: the data model, the publish path, the concurrency and idempotency guarantees and their tests, the abuse limits, the security notes, the decisions and their costs, and the known debt.

## What has been measured

One load run on a clean copy of the dev environment: one Fargate task of 0.5 vCPU and 1 GB, ARM64, with Aurora Serverless v2 capped at 1 unit, driven by one laptop on a home connection. In the full profile (flips at up to 12 a second, reads at 60 a second) it published 1,843 flips with no unexplained errors. Publish took 79 ms at the median and 132 ms at the 99th percentile; reading a chain took 12 ms and 26 ms. The client's counts, the service's counters and the database's counts agreed exactly.

What bent is also on record: at 250 reads a second the 1-unit database was the limit, and from about 50 flips a second publish had a tail of about 5.5 seconds whose cause is a hypothesis that was not tested. No flips-per-second ceiling is claimed, and none of this is extrapolated to a number of users. The table and the limits are in ARCHITECTURE.md, "Measured numbers".

## Roadmap

Small steps, in the order that makes the most sense. Nothing here is a promise; the reasons and the costs are in [ARCHITECTURE.md](ARCHITECTURE.md#roadmap).

| When | What | Why it is useful |
|---|---|---|
| **Now** | Test on real devices: two fingers on two pads on an iPhone, the silent switch, Safari, a screen reader | The core loop is covered by automated browsers and one laptop; a phone in a hand is the missing evidence |
| **Now** | A repeatable deploy: a staging environment and the deploy workflow run once, with a rollback | Today a release is a script run by hand against the only environment |
| **Now** | Settle the publish tail: re-run the load test with a higher render limit | One untested hypothesis says the ceiling is a setting, not the hardware |
| **Next** | More chains, with a human behind them: seeded lineages from real recordings, declared as the maker's own | The home chain is one synthesized chord; a lineage of real sounds explains the idea faster |
| **Next** | Hear a stage against its parent (A/B) | Only worth it once a change is audible, which needs the content above |
| **Next** | Split a cut into several pads at once | A small kit in one tap, built from sketches that already exist |
| **Next** | A longer stored source, and more file formats (starting with `.ogg`) | Today a source is capped at 15 seconds and some files cannot be read |
| **Later** | A faster-than-1x method with an anti-alias filter, as a new renderer version | Removes the known aliasing; needs new vectors and a new pin |
| **Later** | A sequencer over the phrase recorder | Only if pressing pads is not enough |
| **Later** | Several parents mixed into one sound | Turns the chain from a line into a graph; a vision, not a plan |

The idea underneath is a small public record of how sounds come to be: who made each one, what it was made from, and a way to hear every step and make the next one.

## Run it

Needs the pinned Rust toolchain (installed from `rust-toolchain.toml` by rustup), Node 24 with pnpm, and Docker.

Start two throwaway containers (Postgres and an S3-compatible store, bound to localhost), then everything at once:

```sh
docker run -d --name graft-dev-pg -e POSTGRES_PASSWORD=graft -p 127.0.0.1:55432:5432 postgres:16
docker run -d --name graft-dev-s3 -p 127.0.0.1:59000:9000 \
  -e RUSTFS_ACCESS_KEY=graftaccess -e RUSTFS_SECRET_KEY=graftsecret12345 \
  rustfs/rustfs@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b
curl -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user graftaccess:graftsecret12345 http://127.0.0.1:59000/graft-test
sh scripts/dev-local.sh      # the site is then at http://127.0.0.1:3100
```

Those are throwaway credentials for throwaway containers. `dev-local.sh` builds the renderer, starts the service with visitor uploads on (`--no-uploads` leaves them off), seeds the chain and serves the built site. It keeps its own database and bucket prefix and touches nothing else.

Run the tests:

```sh
sh scripts/build-wasm.sh                 # the canonical renderer artefact
cargo test --workspace --all-features    # vectors on every Rust host, plus the tests that need Postgres and the bucket
cd web && pnpm install && pnpm test      # unit tests; pnpm exec playwright test for the browser suite
```

The blob tests use `GRAFT_TEST_S3_ENDPOINT` (default `http://127.0.0.1:59000`) and the bucket above; the tests that need Postgres create a private database each on the server named by `GRAFT_TEST_DATABASE_URL` and remove it afterwards.

### Run the queue tests

The optional event queue is tested against an emulator, not AWS:

```sh
docker run -d --name graft-dev-sqs -p 127.0.0.1:59324:9324 \
  softwaremill/elasticmq-native@sha256:e4580ab9ad1bd5cd37b4ba04911bc5ccc8cd2d9ab4de56ece65acee71c24e05c
GRAFT_TEST_SQS_ENDPOINT=http://127.0.0.1:59324 AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x AWS_REGION=us-east-1 \
  cargo test -p graft-queue --test emulator -- --ignored --test-threads=1
GRAFT_TEST_SQS_ENDPOINT=http://127.0.0.1:59324 sh scripts/queue-e2e.sh   # the real service with the queue on
```

### Check the renderer yourself

```sh
sh scripts/build-wasm.sh
cargo run -q -p graft-vectors --bin vectors-replay -- target/wasm32-unknown-unknown/wasm/graft_render.wasm
```

It replays the vector table against the artefact and exits non-zero on any difference, naming the vector with the expected and actual hash. `--host native` or `--host render-host` replays the table against the Rust library or the service's own host; `--help` lists the rest.

### The service alone

```sh
GRAFT_DATABASE_URL=postgres://postgres:graft@127.0.0.1:55432/postgres cargo run -p graft-api
```

Routes are listed in `/openapi.json`, with `/health`, `/ready` and `/metrics` beside it. Operator routes under `/admin` exist only when `GRAFT_ADMIN_SECRET` is set. The seed and maintenance commands (`graft-seed`, `graft-seed-chain`, `graft-rebuild-rollups`, `graft-blob-cleanup`) are safe to run twice. Every setting is in ARCHITECTURE.md, "Configuration".

## Working on it

`dev` is the working branch. Branch from `dev`, open a pull request into `dev`, and keep commit messages plain and conventional; `staging` and `main` only receive promotion pull requests. Turn on the local hooks once with `git config core.hooksPath .githooks` (formatting and commit messages only). `sh scripts/precheck.sh` runs the fast checks in about half a minute; `--full` adds the whole test suite.

## Licence

Apache License 2.0: see [LICENSE](LICENSE). The ten sounds in `seed/sources/` are original works made for graft by a script and are covered by the same licence. Sounds that visitors publish are not part of this repository: each is declared by whoever published it, and graft does not check the declaration.
