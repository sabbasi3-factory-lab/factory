# Control room (dashboard v1)

A static, read-only dashboard for the factory, built from the controller's audit log
(DESIGN.md §11, "Control room"). It is published on this repo's GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

It uses plain HTML, CSS and ES modules, with no frameworks, no CDNs, no build step and
no runtime dependencies. All data comes from GitHub; there is no OpenTelemetry.

| File | Purpose |
|---|---|
| `index.html` | Page structure and the Content-Security-Policy |
| `app.js` | UI: polling, rendering, settings |
| `lib.js` | Pure logic: canonical JSON, SHA-256 checks, chain check, metrics. Runs in the browser and in Node |
| `style.css` | Layout; light and dark themes via `prefers-color-scheme` |
| `test/lib.test.mjs` | Tests for `lib.js` |
| `test/make-fixture.mjs` | Generates `test/fixtures/sample.jsonl` with real hashes |

## Preview locally

```sh
python3 -m http.server -d dashboard 8000
```

- <http://localhost:8000/> reads the live audit log of `sabbasi3-factory-lab/chrono-node-rs`.
  Until the controller creates the `audit` branch, it shows "No audit log yet".
- <http://localhost:8000/?fixture=1> loads `test/fixtures/sample.jsonl` instead, so you can
  see a populated dashboard offline. The clock is pinned just after the last sample event.
  The same URL works on Pages, because the fixture is published with the site.

Other query parameters: `?poll=N` (seconds between checks, 10–3600, default 30) and
`?days=N` (days of day files to load, 1–31, default 7).

## Run the tests

```sh
node --test "dashboard/test/*.test.mjs"
```

Use the glob form: on Node 26, `node --test dashboard/test/` tries to load the directory as a
module and fails. After changing `make-fixture.mjs`, regenerate the fixture with
`node dashboard/test/make-fixture.mjs`; a test fails if the committed fixture is out of date.

## How it loads data

1. It polls `GET api.github.com/repos/sabbasi3-factory-lab/chrono-node-rs/branches/audit`
   with `If-None-Match` set to the last ETag.
2. When the branch head changes, it fetches the last 7 UTC days of
   `audit/YYYY/MM/DD.jsonl` from `raw.githubusercontent.com`, pinned to the head SHA,
   so raw caching can't serve stale files. A 404 means there were no events that day.
3. A missing `audit` branch shows "No audit log yet" and is re-checked every 5 minutes.

**Rate limits.** Without a token, GitHub allows 60 API requests an hour per IP, and
conditional requests that return 304 still count against it (they're only free when
authenticated). So the dashboard spreads the remaining requests over the time left in
the rate-limit window: without a token that's about one check a minute; with a token it
checks every 30 s. The header shows the requests left and the reset time. Hidden tabs
don't poll. Raw file downloads don't use the API limit.

**Optional token.** In Settings you can paste a read-only token (a fine-grained token with
public read-only access and no permissions). It's kept only in this browser's
`localStorage` and sent only to `api.github.com`, never to `raw.githubusercontent.com`.
It's never required.

The Content-Security-Policy allows scripts and styles only from the site itself (no
inline scripts), and network requests only to the site, `api.github.com` and
`raw.githubusercontent.com`.

## Integrity

Every event's `sha` is recomputed with WebCrypto as
`"sha256:" + hex(SHA-256(canonical JSON of the event without sha))`, where canonical JSON
sorts object keys by UTF-16 code units, recursively, with no whitespace. Each event's
`parents[0]` must equal the previous event's `sha` across the loaded window. The first
loaded event may point to a parent before the window ("window start"); an event with
`parents: []` at the start is the "genesis" of the log. The badge shows either
"Chain verified" or "Chain broken at event N", with the file, line and reason. The
schema is checked too: exactly the seven fields, version 1, UUID v4, UTC timestamp.

## How tiles and tables are derived

| Item | Derivation |
|---|---|
| Agents running | `dispatched` and `repair_dispatched` events without a matching `run_finished` (same task and attempt), against the WIP limit of 3 (`policies/limits.yaml`). Dry-run dispatches are plans, so they're counted separately as "planned, not running" |
| Merge queue | PRs `queued`, minus later `dequeued` or `merged` |
| Merged today | `merged` events whose `merged_at` is today (UTC) |
| Zero-touch rate | Merged factory PRs (a `merged` or other event links the PR to a `task`) with no `human_action` on that PR, over the window. "n/a" until a factory PR merges |
| AIC today | Sum of `run_finished.aic` with a timestamp today (UTC), against the 10,000 AIC daily budget (`policies/budgets.yaml`). Amber at 80%, red at 100% |
| Needs you | Open `needs_human` and `stale_contract` items, one per task (or PR/issue). An item closes when a later event for the same task, PR or issue shows it moved on: `ready`, `picked`, `dispatched`, `repair_dispatched`, `run_started`, `contract_pinned`, `human_action`, `merged`, `cancelled`, `accepted` or `rejected` |
| Kill switch | `factory_enabled` from the latest `heartbeat` |
| Factory version, dry run | `factory_version` and `dry_run` from the latest event's payload |
| Heartbeat age | Minutes since the latest `heartbeat`. Amber after 70 min, red after 120 min (the DESIGN alert threshold) |
| Time per stage | First time each stage (ready → picked → running → pr-open → checks → queued → merged → deployed) was reached, per task, or per PR when the PR has no task. Uses the payload's own time (`opened_at`, `completed_at`, `at`, `merged_at`) where there is one, otherwise the event timestamp. A skipped stage shows "(to …)" |

**Not derivable from v1 events yet:**

- *Human-tier PRs* in the needs-you count: v1 events don't carry a risk tier. The tile says so.
- *Tokens and AIC* while a run is in progress: they arrive only with `run_finished`, so
  "Running now" shows "—" until then. Empty states say "No runs yet" / "No finished runs yet".
- *Golden pass %, repairs per task, escaped bugs, the stacked "where the time goes" bar
  and flow/throughput charts* from DESIGN §11 aren't in v1. They need `run_finished`
  per-job durations, `deployed`/`accepted` and outcome events.

## Deploy

`.github/workflows/pages.yml` runs on pushes to `main` that touch `dashboard/**` or the
workflow, and on manual dispatch. It runs the tests on Node 24, then uploads `dashboard/`
as the Pages artifact and deploys it. All actions are pinned to commit SHAs.
