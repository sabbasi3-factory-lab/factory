# Control room (dashboard v2)

A static, read-only dashboard for the factory, built from the controller's audit log
(DESIGN.md §11, "Control room"). It is published on this repo's GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

It uses plain HTML, CSS and ES modules, with no frameworks, no CDNs, no build step and
no runtime dependencies. All data comes from GitHub; there is no OpenTelemetry.

| File | Purpose |
|---|---|
| `index.html` | Page structure and the Content-Security-Policy |
| `app.js` | UI: polling, rendering, settings |
| `lib.js` | Pure logic: canonical JSON, SHA-256 checks, chain check, metrics, verifier anchors. Runs in the browser and in Node |
| `style.css` | Layout; light and dark themes (system setting, or the Theme button, remembered in `localStorage`) |
| `test/lib.test.mjs`, `test/v2.test.mjs`, `test/verifier.test.mjs` | Tests for `lib.js` |
| `test/make-fixture.mjs` | Generates `test/fixtures/sample.jsonl` with real hashes, and `test/fixtures/anchors.jsonl` (verifier anchors over it) |
| `watchdog.mjs` | Liveness watchdog run hourly by `.github/workflows/heartbeat-watchdog.yml`: keeps one "Factory liveness alert" issue (label `heartbeat-alert`) open while the heartbeat is over 2 h old, missing or unreadable, or `audit-verify` hasn't succeeded in 26 h (see [Watchdog](#watchdog)). Try it read-only with `GITHUB_REPOSITORY=<owner>/<repo> WATCHDOG_DRY_RUN=1 node dashboard/watchdog.mjs` |
| `test/watchdog.test.mjs` | Tests for the watchdog and for workflow permissions and action pins |
| `test/glance.test.mjs` | The 5-second glance test: word budgets, layout, tooltips and keyboard behaviour, measured on the rendered `?fixture=1` page in headless Chrome |
| `test/glance-measure.mjs`, `test/headless.mjs` | The in-page word and layout measurements, and a dependency-free headless-Chrome driver (static server, DevTools protocol over Node's `WebSocket`). Also a CLI that measures the live page |

## Layout

The page is built for a 5-second glance: without reading sentences you can tell whether
the factory is healthy, whether anything needs you, and whether work is moving. Numbers,
colour and icons come first; every state has an icon as well as a colour; explanations
live in tooltips (on the ⓘ buttons and on chips, tiles, cards and labels), which open on
hover and on keyboard focus (Tab reaches them) and close with Escape. "—" means no data.

From the top, at widths up to 1480 px:

- **Sticky header:** "updated 12s ago" (its tooltip has the check times, API requests
  left, token use, factory version and source), Refresh, Theme and Settings as icon
  buttons, and the **glance line** in large type, for example
  "✓ Healthy · 2 need you · ⏻ Factory off · ⓘ Dry run". Each part is a chip with
  details in its tooltip: the **health chip** (rule below; it includes the independent
  verifier), the Needs-you count (a link to the panel), the kill switch (on is green, off
  is a neutral grey: off is the deliberate safe state) and dry-run or live mode. In
  `?fixture=1` mode there's also a "Sample" chip. Until the first load the health chip
  reads "… Loading" in neutral grey and the tiles show "…": nothing is red before
  something is known to be wrong.
- **Needs you:** the big count and one line per item, oldest first: icon, `#22` (or
  `factory#3` for the other repo), a title of at most 4 words (full title, reason and
  waiting time in the tooltip), an age chip, and "View PR" or "View issue". Empty: "✓ Nothing
  needs you". If the review list can't be read: "⚠ Review list unavailable".
- **Seven KPI tiles** (last 7 days): label, big number and a per-day trend line. Zero-touch
  rate, checks passed, AIC today, merged today, median time to merge, heartbeat age and
  "Verified" (age of the newest independent-verifier anchor, trend: anchors per day). The
  last two are green, amber or red with a ✓, ⚠ or ✗ icon. The detail line of each tile is
  in its tooltip. A day with nothing to measure leaves a gap in the line rather than a zero.
- **Pipeline:** seven lanes (Ready, Running, PR open, Checks, Queue, Merged, Deployed).
  Empty lanes shrink to a narrow column with the name and 0. A card shows `#20` (the PR,
  else the issue) and the time in its stage; icons flag needs human, stale contract, a
  failed check, a repair or a dry-run plan, and the tooltip has the task, attempt, model
  and tags. Merged and Deployed show the latest 3 cards and a "+N" button for the rest.
  "Closed N" counts PRs closed without merging.
- **Details, in two independent columns** (one column below 1100 px): Agents then
  "Where the time goes" on the left, Latest checks then Cost per task on the right, so a
  short panel never leaves a hole next to a tall one.
  - **Agents:** "N of 3 agents running" with the WIP slots, then a card per active
    attempt. With nothing running it's that one line. Without any `run_finished` events
    the count is "—" (see below).
  - **Latest checks:** the newest 5 (✓ or ✗, workflow, PR, time), then "View all". Run
    ids, held-out seeds and failure signatures are in the workflow's tooltip.
  - **Where the time goes:** a stacked bar per task or PR plus the average, and a
    one-line insight such as "Checks is 52% of the time".
  - **Cost per task:** AIC bars and "Average 334 AIC · 33% of budget".
- **Task timeline** and **audit log**, both collapsed. Clicking a task name opens its
  timeline. The audit log keeps v1's type filter, integrity column and canonical JSON.

Empty states are one short muted line. On narrow screens the glance line wraps and the
lanes stack.

### Health chip

| Chip | When |
|---|---|
| … Loading (grey) | Nothing loaded yet and no error |
| ✓ Healthy | Fresh data, a verified chain, a heartbeat within 70 min and a verifier anchor within 2 h |
| ⚠ Degraded | The last refresh failed (older data is shown), the data is over 10 min old, the heartbeat is late (over 70 min) or unknown, the chain isn't verified, or the verifier is late (over 2 h) or not set up yet |
| ✗ Down | No audit log, nothing loaded because of an error, a broken chain, a heartbeat missing from the window or over 120 min old, or a verifier over 26 h old or unknown (unreadable, empty, malformed, out of order or in the future) |

The worst condition wins; the tooltip lists each one, plus the verifier's state such as
"Verified 23m ago · 41 anchors" or "Verifier not set up". The rule is `healthSummary()` in
`lib.js`. Until the audit-verify workflow's first bootstrap creates the anchors file, the
live page reads "Degraded" (verifier not set up), on purpose.

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
module and fails.

`test/glance.test.mjs` needs Chrome or Chromium. It looks at `CHROME_PATH`, then
`google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` on `PATH`, then
the macOS app. Without one it's skipped locally and fails when `CI` is set. It serves
`dashboard/` on an ephemeral local port, opens `?fixture=1` at 1440×900 and 390×844 and
checks these budgets:

- at most 80 visible words above the fold at 1440×900;
- at most 250 visible words in total (closed `<details>`, hidden elements and tooltips
  don't count);
- no visible sentence longer than 8 words.

A word is a whitespace-separated token with a letter or digit, so icons, "·" and "—" aren't
words; a sentence ends at a "·", "|", ".", "!" or "?", a line break or the edge of its
element. The exact rules are on `measureGlance()` in `test/glance-measure.mjs`. The test
also checks the two-column layout, that tooltips open on keyboard focus, that "View all"
works with Enter and Space, that focus survives a re-render, that no button or link text
starts with "Open" (links out to GitHub say "View …"), that nothing is red or amber while
the sample data is held back (the page shows "… Loading"), that "Factory off" is neutral
grey, and that the console stays clean. On
failure it prints the offending words and sentences.

To measure the live page (four API requests), or save screenshots:

```sh
node dashboard/test/glance-measure.mjs              # live data
node dashboard/test/glance-measure.mjs --fixture    # sample data
node dashboard/test/glance-measure.mjs --verbose --shots <dir> --name <prefix>
``` After changing `make-fixture.mjs`, regenerate the fixture with
`node dashboard/test/make-fixture.mjs`; a test fails if the committed fixture is out of date.

## How it loads data

1. It polls `GET api.github.com/repos/sabbasi3-factory-lab/chrono-node-rs/branches/audit`
   with `If-None-Match` set to the last ETag.
2. When the branch head changes, it lists the `audit/` tree at that commit
   (`GET /git/trees/<sha>:audit?recursive=1`, one more API call per head change), then
   fetches only the day files from the last 7 UTC days that exist, from
   `raw.githubusercontent.com` pinned to the head SHA, so raw caching can't serve stale
   files. Skipping missing days keeps the console free of 404 errors. If the listing
   fails, it falls back to fetching all 7 days and treats a 404 as an empty day.
3. A missing `audit` branch shows "No audit log yet" and is re-checked every 5 minutes.
4. It reads the open-PR lists of `sabbasi3-factory-lab/chrono-node-rs` and
   `sabbasi3-factory-lab/factory` (`GET /pulls?state=open&per_page=100`, with ETags):
   after an audit head change but at most every 5 minutes, and at least every 15. v1
   events have no "closed" PR event and no human-tier PR events, so these lists decide
   which PRs are still open and which owner reviews are waiting. PR bodies are only
   matched for a tier line and never shown or kept. If a list can't be read, or the last
   good read is over 20 minutes old, the page says the PR state is unknown instead of
   guessing.
5. It reads the independent verifier's anchors file from `raw.githubusercontent.com` at
   most every 5 minutes; until the `anchors` branch exists, one API call at most every 15
   minutes checks for it instead (see [Integrity](#integrity)).

**Rate limits.** Without a token, GitHub allows 60 API requests an hour per IP, and
conditional requests that return 304 still count against it (they're only free when
authenticated). So the dashboard spreads the remaining requests over the time left in
the rate-limit window: without a token that's about one check a minute; with a token it
checks every 30 s. The "updated" tooltip and Settings show the requests left and the
reset time. Hidden tabs don't poll. Raw file downloads don't use the API limit.

**Optional token.** In Settings you can paste a read-only token (a fine-grained token with
public read-only access and no permissions). It's kept only in this browser's
`localStorage` and sent only to `api.github.com`, never to `raw.githubusercontent.com`.
It's never required.

Each section renders independently: a malformed event shows a placeholder row or a
section message, and never stops the rest of the page. The 15-second clock refresh only
updates the time cells, so focus and table nodes stay put; when a table is rebuilt
because new events arrived, focus returns to the same element within the same table.

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

**Independent verifier.** The factory's `audit-verify` workflow fully re-verifies the whole
log every hour and, on success, appends one canonical-JSON anchor line to
`anchors/chrono-node-rs.jsonl` on the `anchors` branch of `sabbasi3-factory-lab/factory`:
`{"at","audit_head","events","last_sha","run_id","source","v"}`, newest last. The page reads
that file from `raw.githubusercontent.com` (no API cost) at most every 5 minutes and checks
every line's exact keys, types and formats, that it is canonical JSON, and that `at` and
`events` never go down. It doesn't recompute hashes. There's no separate chip: the
verifier is part of the health chip (see [Health chip](#health-chip)), whose tooltip says,
for example, "Verified 23m ago · 41 anchors", and of the "Verified" tile: green up to 2 h,
amber after 2 h, red after 26 h. It's also red ("Verifier unknown", health Down) if the
file can't be read, is empty, has any malformed or out-of-order line, or its newest anchor
is in the future. A 404 reads "Verifier not set up" in amber (health Degraded): the branch
is created by the workflow's first successful run. Until the
branch exists, the page checks for it with one API call at most every 15 minutes
(`GET /git/matching-refs/heads/anchors`, which answers `[]` rather than 404) instead of
fetching the raw file, so the console stays free of 404 errors. The audit log section has a
muted line with the details: last run, anchor count, and how many events the newest anchor
covers (more than the page loads, since the page reads only 7 days) with its audit head.
With `?fixture=1` it reads `test/fixtures/anchors.jsonl`.

## How the panels are derived

| Item | Derivation |
|---|---|
| Agents running | `dispatched` and `repair_dispatched` attempts not yet retired, against the WIP limit of 3 (`policies/limits.yaml`). An attempt retires on its `run_finished`, a later attempt for the same task, the task's PR being `merged`, or a `needs_human` or `cancelled` for the task. If the window has no `run_finished` at all (v1 doesn't log it), the count is "—" while attempts are listed (they may have finished), and the cards show a "?" instead of a spinner. Dry-run dispatches are plans, so they're counted separately as "planned, not running" |
| Merge queue | PRs `queued`, minus later `dequeued` or `merged` |
| Merged today | `merged` events whose `merged_at` is today (UTC) |
| Zero-touch rate | Merged factory PRs (a `merged` or other event links the PR to a `task`) with no `human_action` on that PR, over the window. "—" until a factory PR merges |
| AIC today | Sum of `run_finished.aic` with a timestamp today (UTC), against the 10,000 AIC daily budget (`policies/budgets.yaml`). Amber at 80%, red at 100% |
| Needs you | Open `needs_human` and `stale_contract` items, one per task (or PR/issue). An item closes when a later event for the same task, PR or issue shows it moved on: `ready`, `picked`, `dispatched`, `repair_dispatched`, `run_started`, `contract_pinned`, `human_action`, `merged`, `cancelled`, `accepted` or `rejected`. A controller decision logged in dry-run mode is only a plan, so it doesn't close an item; observed facts (`human_action`, `merged`, …) do, even though every v1 payload carries `dry_run: true` |
| Kill switch | `factory_enabled` from the latest `heartbeat` |
| Factory version, dry run | `factory_version` and `dry_run` from the latest event's payload |
| Heartbeat age | Time since the latest `heartbeat`. Green with ✓ up to 70 min, amber with ⚠ after 70 min, red with ✗ after 120 min (the DESIGN alert threshold) or when there's none |
| Trend lines | Per UTC day over the window: zero-touch rate so far (cumulative), share of `check_result` events with `success`, `run_finished.aic` sum, `merged` count, median PR `opened_at` → `merged_at`, and `heartbeat` count (24 expected) |
| Owner reviews ("Review and merge") | Open, non-draft PRs in either repo whose body has a `Tier:` line saying `human` or `owner` (markdown bold allowed, case-insensitive), or with an `owner-review`, `human-tier` or `needs-human` label. Listed with the audit items, oldest first, and counted toward the review-queue cap. If the lists can't be read, the panel says the review list is unavailable instead of "Nothing needs you" |
| Pipeline lane | The latest stage event for the task (or task-less PR): `ready` → Ready; `picked`, `dispatched`, `run_started`, `repair_dispatched`, `run_finished` → Running; `pr_opened`, `dequeued` → PR open; `check_result` → Checks; `queued` → Merge queue; `merged` → Merged; `deployed`, `accepted` → Deployed. `cancelled` removes the card. Dry-run decisions never move a card. A card stays in PR open, Checks or Merge queue only if one of its PRs is open on GitHub now; otherwise it goes to the muted "Closed" count. Without a current open-PR list, those lanes say "PR state unknown". With `?fixture=1`, PRs opened and never merged count as open |
| Time per stage | First time each stage (ready → picked → running → pr-open → checks → queued → merged → deployed) was reached, per task, or per PR when the PR has no task. Uses the payload's own time (`opened_at`, `completed_at`, `at`, `merged_at`) where there is one, otherwise the event timestamp. A skipped stage shows "(to …)" |

**Not derivable from v1 events yet:**

- *Human-tier PRs* and *closed PRs*: v1 events carry neither, so they're read from the open-PR lists (see above) until the audit log records them.
- *Whether an agent is still running*: v1 has no `run_finished`, so the agents count shows "—" while attempts are listed.
- *Tokens and AIC* while a run is in progress: they arrive only with `run_finished`, so
  agent cards show elapsed time only until then. Cost says "No cost data yet".
- *Golden pass %, repairs per task, escaped bugs, and flow/throughput charts* from
  DESIGN §11 aren't in v1. They need outcome events. "Where the time goes" uses the
  stage events that exist; per-job durations (queue wait, run setup, detection) need
  `run_finished` details.

## Watchdog

`watchdog.mjs` runs hourly and checks two things, failing closed:

- **Heartbeat** (reason codes `heartbeat-fresh`, `heartbeat-too-old`, `no-heartbeat`,
  `audit-branch-missing`, `audit-branch-unreadable`, `audit-file-unreadable`): the newest
  valid `heartbeat` event in today's and yesterday's audit files must be at most 2 h old.
- **Verifier** (`verifier-fresh`, `verifier-too-old`, `verifier-never-succeeded`,
  `verifier-workflow-missing`, `verifier-unreadable`): the newest successful run of
  `audit-verify.yml` in this repo
  (`GET /repos/{GITHUB_REPOSITORY}/actions/workflows/audit-verify.yml/runs?status=success&per_page=1`,
  needs `actions: read`) must have started at most 26 h ago. Its time is `run_started_at`,
  which is fixed once the run starts and never later than the verification, so it can't make
  a run look newer than it was. A 404, an API error, or no successful run ever alerts.

There's one issue, found by its `heartbeat-alert` label (so an open issue with the earlier
title "Controller heartbeat stale" is reused). It's titled "Factory liveness alert", lists
every failing reason code with a section per check, gets a comment each hour while any
check fails, and is closed only when both are healthy. `WATCHDOG_DRY_RUN=1` reads
everything and prints the plan without writing.

## Deploy

`.github/workflows/pages.yml` runs on pushes to `main` that touch `dashboard/**` or the
workflow, and on manual dispatch. It runs the tests on Node 24, then uploads `dashboard/`
as the Pages artifact and deploys it. All actions are pinned to commit SHAs.
