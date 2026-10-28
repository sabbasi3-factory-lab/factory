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
| `test/lib.test.mjs`, `test/v2.test.mjs`, `test/verifier.test.mjs`, `test/drop-closed.test.mjs`, `test/dispatch-banner.test.mjs`, `test/redesign.test.mjs` | Tests for `lib.js` (`redesign.test.mjs`: the task board, cost join, 14-day medians, quality, human touch, liveness, recent activity and the closed rule) |
| `test/make-fixture.mjs` | Generates the sample audit logs with real hashes and the verifier anchors over them: `test/fixtures/sample.jsonl` and `anchors.jsonl` (`?fixture=1`, a busy factory), and `quiet.jsonl` and `quiet-anchors.jsonl` (`?fixture=quiet`, a quiet factory with every task done), plus `sample-meta.json` and `quiet-meta.json`: the task map, contracts and Actions run lists each sample uses instead of GitHub |
| `watchdog.mjs` | Liveness watchdog scheduled hourly by `.github/workflows/heartbeat-watchdog.yml`: keeps one "Factory liveness alert" issue (label `heartbeat-alert`) open while the heartbeat is over 12 h old, missing or unreadable, or `audit-verify` hasn't succeeded in 26 h, opening it only after two failing runs in a row (see [Watchdog](#watchdog)). Try it read-only with `GITHUB_REPOSITORY=<owner>/<repo> WATCHDOG_DRY_RUN=1 node dashboard/watchdog.mjs` |
| `test/watchdog.test.mjs` | Tests for the watchdog and for workflow permissions and action pins |
| `test/glance.test.mjs` | The 5-second glance test: word budgets, layout, tooltips and keyboard behaviour, measured on the rendered `?fixture=1` and `?fixture=quiet` pages in headless Chrome |
| `test/glance-measure.mjs`, `test/headless.mjs` | The in-page word and layout measurements, and a dependency-free headless-Chrome driver (static server, DevTools protocol over Node's `WebSocket`). Also a CLI that measures the live page |

## Layout

One screen at 1440×900: everything that matters is above the fold, and a 5-second glance tells
you whether the factory is healthy, what it's doing, whether anything needs you, and how the
tasks are going. Numbers, colour and icons come first; every state has an icon as well as a
colour; explanations and definitions live in tooltips (on the ⓘ buttons, chips, numbers, tiles
and rows), which open on hover and on keyboard focus (Tab reaches them) and close with Escape.
Every time on the page is relative ("23m ago", "in 31m"); the exact UTC time is in the tooltip
or the element's title. "—" means no data (the tooltip says why).

Top to bottom:

- **Sticky header and status line:** "updated 12s ago" (its tooltip has the check times, API
  requests left, token use, factory version and source), Refresh, Theme and Settings as icon
  buttons, then the status line in large type, for example
  "✓ Healthy · ⏻ Factory on · ✓ Idle: all 26 tasks done". The **health chip** (rule below; it
  includes the independent verifier), the kill switch (on is green, off a neutral grey: off is
  the deliberate safe state), the **state** in plain English, and "ⓘ Dry run" only when the
  controller is in dry-run mode. The state is `stateLine()` in `lib.js`: "Paused: daily AI budget
  reached" (or another dispatch gate, from the newest `dispatch_state`; the kill switch has its
  own chip), "Running: 2 tasks", "Waiting on you: 1 task", "Idle: all 26 tasks done",
  "Waiting: 3 tasks ready" or "Waiting: 4 tasks on dependencies". Its tooltip has the task counts
  and the controller's last dispatch state with how long it has held. With sample data there's
  also a "Sample" chip. Until the first load the health chip reads "… Loading" in neutral grey
  and the numbers show "…": nothing is red before something is known to be wrong.
- **Four big numbers** (number and a short label; the definition is in each tooltip):
  **Tasks done** "26/26" with the done count per tier ("auto 18 · auto-strict 8"),
  **Issue → merged** (median over the last 14 days), **Cost per task** (median, in dollars) and
  **Needs you** (a green ✓ 0, or the count and up to three items with "View issue"/"View PR").
- **Task board:** one tile per task of the task map, grouped by its contract area ("Common
  parsers", "Month names", …), named without the `common/` or `en/` prefix. Each tile has a state
  colour and icon: ✓ done (green), ▶ running (blue), ⚠ needs you (amber), ⧗ waiting (grey); a legend
  with counts shows when more than one state is present. Selecting a tile (click or Enter) views
  its issue on GitHub (or its contract when the loaded events name no issue); the tooltip has the
  full task id and title, tier, state, reason and since when.
- **Five small panels**, each a few "number + label" rows with the detail in tooltips:
  **Cost** (today against the daily cap, total to date), **Quality** (reverts, escaped defects,
  reviewer objections, "Repairs worked: 50%"), **Human touch** (actions in the last 7 days, median
  time to unblock a hand-off), **Liveness** (when the controller last polled and when the next
  poll is expected) and **Recent activity** (the last 5 meaningful events, for example
  "#29 iso-format-parser merged 19h").
- **Folded details** (closed by default): **Latest checks** (newest 5, then "View all"),
  **Where the time goes** (bug-fixed: medians, see below), **Task timeline** (clicking a task
  name in the chart opens it) and the **Audit log** (type filter, integrity column, canonical
  JSON, and the independent verifier's line).
- **Footer:** "Read-only · verified in your browser".

Empty states are one short muted line. On narrow screens the numbers, panels and board columns
wrap.

### Health chip

| Chip | When |
|---|---|
| … Loading (grey) | Nothing loaded yet and no error |
| ✓ Healthy | Fresh data, a verified chain, a heartbeat within 8 h and a verifier anchor within 8 h |
| ⚠ Paused (amber) | Dispatch is held by a gate (spend unknown, budget, Actions load) and nothing else is wrong. The kill switch doesn't count: "Factory off" has its own chip. With another warning it reads Degraded, with the pause listed. The state chip next to it names the gate |
| ⚠ Degraded | The last refresh failed (older data is shown), the data is over 10 min old, the heartbeat is late (over 8 h) or unknown, the chain isn't verified, or the verifier is late (over 8 h) or not set up yet |
| ✗ Down | No audit log, nothing loaded because of an error, a broken chain, a heartbeat missing from the window or over 12 h old, or a verifier over 26 h old or unknown (unreadable, empty, malformed, out of order or in the future) |

The worst condition wins; the tooltip lists each one, plus the verifier's state such as
"Verified 23m ago · 41 anchors" or "Verifier not set up", then the rule and the observed
cadence of heartbeats and verifications. The rule is `healthSummary()` in `lib.js`.

**Why the limits are hours, not minutes.** The controller and the verifier are scheduled
hourly, but GitHub's cron on this Free-plan org runs "every 5 min" and "hourly" schedules
only every 2 to 8 h. Over 48 h the heartbeat gaps had a median of 2.4 h and a p90 of 4.4 h,
and later gaps reached 5.2 to 7.6 h. With the earlier limits (amber after 70 min, red after
120 min, verifier amber after 2 h) the page read "Degraded" most of the time, so the limits
are now above the worst gap seen: heartbeat amber after 8 h and red after 12 h
(`DEFAULTS.heartbeatWarnMin`/`heartbeatAlertMin`, which the watchdog also uses), verifier
amber after 8 h and red after 26 h (`VERIFIER_LIMITS`). Until the audit-verify workflow's first bootstrap creates the anchors file, the
live page reads "Degraded" (verifier not set up), on purpose.

## Preview locally

```sh
python3 -m http.server -d dashboard 8000
```

- <http://localhost:8000/> reads the live audit log of `sabbasi3-factory-lab/chrono-node-rs`.
  Until the controller creates the `audit` branch, it shows "No audit log yet".
- <http://localhost:8000/?fixture=1> loads `test/fixtures/sample.jsonl` and
  `sample-meta.json` instead, so you can see a populated dashboard offline: a busy factory
  with eight tasks (two done, two running, two needing you, two waiting), spend snapshots
  joined with titled and untitled agent runs, and an escaped defect. The clock is pinned just
  after the last sample event. The same URL works on Pages, because the fixtures are published
  with the site. Sample mode makes no request to GitHub.
- <http://localhost:8000/?fixture=quiet> loads `test/fixtures/quiet.jsonl`, `quiet-anchors.jsonl`
  and `quiet-meta.json`: a quiet factory. Nothing needs you, the factory is off, dry run, all
  three tasks done, the verifier OK, ten merged owner PRs, and heartbeats and anchors at the
  irregular cadence GitHub really delivers.

Other query parameters: `?poll=N` (seconds between checks, 10–3600, default 30) and
`?days=N` (days of day files to load, 1–31, default 14, the window of the medians).

## Run the tests

```sh
node --test "dashboard/test/*.test.mjs"
```

Use the glob form: on Node 26, `node --test dashboard/test/` tries to load the directory as a
module and fails.

`test/glance.test.mjs` needs Chrome or Chromium. It looks at `CHROME_PATH`, then
`google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` on `PATH`, then
the macOS app. Without one it's skipped locally and fails when `CI` is set. It serves
`dashboard/` on an ephemeral local port, opens both `?fixture=1` and `?fixture=quiet` at
1440×900 and 390×844 and checks these budgets on each:

- at most 150 visible words above the fold at 1440×900 (it was 80; the owner approved 150 for
  the one-screen layout, where the board and the small panels are above the fold too);
- at most 250 visible words in total (closed `<details>`, hidden elements and tooltips
  don't count);
- no visible sentence longer than 8 words.

A word is a whitespace-separated token with a letter or digit, so icons, "·" and "—" aren't
words; a sentence ends at a "·", "|", ".", "!" or "?", a line break or the edge of its
element. The exact rules are on `measureGlance()` in `test/glance-measure.mjs`. The test
also checks the one-screen layout (the four numbers in one row, the board and all five small
panels above the fold, the details closed below them), that no raw ISO time is visible, that
sample mode makes no GitHub request, the task board's state icons, colours, links and
tooltips, the numbers and panel rows of both samples, that both themes really change the
colours, that tooltips open on keyboard focus, that "View all" works with Enter and Space, that
focus survives a re-render, that no button or link text starts with "Open" (links out to GitHub
say "View …"), that nothing is red or amber while the sample data is held back (the page shows
"… Loading"), that "Factory off" is neutral grey, that the liveness and health tooltips show the
observed cadence and the limits without adding visible words, and that the console stays clean.
On failure it prints the offending words and sentences.

The quiet fixture is there because the busy one once hid a real failure: with two items
needing you, the sample passed the fold budget while the live page, with nothing needing you,
didn't. Measure the live page too after a layout change (below).

To measure the live page (about nine API requests on a first load), or save screenshots:

```sh
node dashboard/test/glance-measure.mjs                  # live data
node dashboard/test/glance-measure.mjs --fixture        # sample data (?fixture=1)
node dashboard/test/glance-measure.mjs --fixture quiet  # quiet sample (?fixture=quiet)
node dashboard/test/glance-measure.mjs --verbose --shots <dir> --name <prefix>
```

After changing `make-fixture.mjs`, regenerate the fixtures with
`node dashboard/test/make-fixture.mjs`; a test fails if any committed fixture is out of date.

## How it loads data

1. It polls `GET api.github.com/repos/sabbasi3-factory-lab/chrono-node-rs/branches/audit`
   with `If-None-Match` set to the last ETag.
2. When the branch head changes, it lists the `audit/` tree at that commit
   (`GET /git/trees/<sha>:audit?recursive=1`, one more API call per head change), then
   fetches only the day files from the last 14 UTC days that exist, from
   `raw.githubusercontent.com` pinned to the head SHA, so raw caching can't serve stale
   files. Skipping missing days keeps the console free of 404 errors. If the listing
   fails, it falls back to fetching all 14 days and treats a 404 as an empty day.
3. A missing `audit` branch shows "No audit log yet" and is re-checked every 5 minutes.
4. It reads the open-PR lists of `sabbasi3-factory-lab/chrono-node-rs` and
   `sabbasi3-factory-lab/factory` (`GET /pulls?state=open&per_page=100`, with ETags):
   after an audit head change but at most every 5 minutes, and at least every 15. v1
   events have no human-tier PR events, so these lists decide which owner reviews are
   waiting. PR bodies are only matched for a tier line and never shown or kept. If a list
   can't be read, or the last good read is over 20 minutes old, the page says the review list
   is unavailable instead of guessing. With them, one more call (`GET /issues?state=open`,
   which lists open issues and PRs) gives the **closed rule** for every view of in-flight work
   (`isClosedRef()` in `lib.js`): a Needs-you item, a running row or a running task on the board
   whose issue, or the PR it points at, is closed now is dropped (the audit log has no event for
   an issue or PR closed by hand). When that list is unknown (or a full page of 100, so possibly
   cut short), or the work is newer than the list, nothing is dropped.
5. It reads the independent verifier's anchors file from `raw.githubusercontent.com` at
   most every 5 minutes; until the `anchors` branch exists, one API call at most every 15
   minutes checks for it instead (see [Integrity](#integrity)).
6. It reads the **task catalog** from `raw.githubusercontent.com` (no API cost) on load and
   then hourly: `main/scripts/seed-backlog/taskmap.yaml` (the task ids and areas, flow- or
   block-style entries) and every task's generated contract `main/contracts/<id>.yaml` (title,
   tier, area, `depends_on`). A failed task map is retried after 5 minutes; meanwhile the board
   shows the tasks seen in the audit log and says the task map is unavailable. A missing contract
   only leaves that task's tier unknown.
7. It reads the **agent workflow run lists** for the cost join, three API calls with ETags:
   `GET /repos/sabbasi3-factory-lab/chrono-node-rs/actions/workflows/{implement,repair,review}.lock.yml/runs?per_page=100`.
   Only when a spend snapshot names a run id the lists don't have yet (each id is looked for
   once), at most every 10 minutes, and only with at least 8 API requests left in the hour.
   If they can't be read, the cost per task shows "—" and its tooltip says why; the totals,
   which need only the snapshots, still show.

**Rate limits.** Without a token, GitHub allows 60 API requests an hour per IP, and
conditional requests that return 304 still count against it (they're only free when
authenticated). A first load takes about nine (branch, tree, two PR lists, open issues, the
anchors probe, three run lists); after that the run lists are read only for new runs. The
dashboard spreads the remaining requests over the time left in the rate-limit window: without a
token that's about one check a minute; with a token it checks every 30 s. The "updated" tooltip and Settings show the requests left and the
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
`raw.githubusercontent.com`. Every request is a GET.

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
log on an hourly schedule (which GitHub runs every 2 to 8 h) and, on success, appends one canonical-JSON anchor line to
`anchors/chrono-node-rs.jsonl` on the `anchors` branch of `sabbasi3-factory-lab/factory`:
`{"at","audit_head","events","last_sha","run_id","source","v"}`, newest last. The page reads
that file from `raw.githubusercontent.com` (no API cost) at most every 5 minutes and checks
every line's exact keys, types and formats, that it is canonical JSON, and that `at` and
`events` never go down. It doesn't recompute hashes. There's no separate chip: the
verifier is part of the health chip (see [Health chip](#health-chip)), whose tooltip says,
for example, "Verified 23m ago · 41 anchors": fine up to 8 h, Degraded after 8 h, Down after
26 h. It's also Down ("Verifier unknown", health Down) if the
file can't be read, is empty, has any malformed or out-of-order line, or its newest anchor
is in the future. A 404 reads "Verifier not set up" in amber (health Degraded): the branch
is created by the workflow's first successful run. Until the
branch exists, the page checks for it with one API call at most every 15 minutes
(`GET /git/matching-refs/heads/anchors`, which answers `[]` rather than 404) instead of
fetching the raw file, so the console stays free of 404 errors. The audit log section has a
muted line with the details: last run, anchor count, and how many events the newest anchor
covers (more than the page loads, since the page reads only 14 days) with its audit head.
With `?fixture=1` it reads `test/fixtures/anchors.jsonl`, with `?fixture=quiet`
`test/fixtures/quiet-anchors.jsonl`.

## How the panels are derived

Drill tasks (`drill/*`, the factory's own fire drills) are left out of every task aggregate.
"Real" means not a dry-run plan (`isPlanOnly()`); observed facts such as `merged` always count.

| Item | Derivation (`lib.js`) |
|---|---|
| Health chip, kill switch | As before: `healthSummary()`, and `factory_enabled` from the latest `heartbeat` |
| State | `stateLine()`: the newest `dispatch_state` if paused by a gate; otherwise from the board: running tasks, tasks needing you, all done, ready tasks waiting for a slot, tasks waiting on dependencies |
| Task board | `taskBoard()`: per task of the catalog, **done** after a `merged` or `task_done` not followed by a reopening `ready`, `auto_ready`, `dispatched` or `repair_dispatched`; **needs you** with an open Needs-you item for the task; **running** once real work started (`dispatched`, `repair_dispatched` or `review_dispatched`) and not done, unless its issue or current PR is closed (the closed rule); **waiting** otherwise: a dependency not done, ready but no free slot, not started, closed without a merge, or no events in the loaded window. "Since" is when it entered that state |
| Tasks done | Done tiles over all tiles, and done per tier (from the contracts) |
| Issue → merged | `issueToMerged()`: per task merged in the last 14 days, from its first real `auto_ready` (else its first real `dispatched`) to its last `merged` (`merged_at`); the median |
| Cost per task | `costJoin()` + `medianTaskCost()`: each run's latest measured AIC across the real `spend_snapshot` events (a "reserved" entry is a placeholder and never replaces a measurement), joined with the run lists. Implement and repair runs name their task in the title ("Implement <task> #<issue> attempt <n>"); a review run ("Review one factory PR"), or an older untitled implement or repair run ("Implement one factory task"), is matched to the `review_dispatched`, `dispatched` or `repair_dispatched` event it was created at or within 30 min after (nearest pairs first, each event and run once). A task's cost is the sum over its runs; the number is the median over the done tasks with attributed cost, in dollars (1 AIC = $0.01) |
| Needs you | Open `needs_human` and `stale_contract` items, one per task (or PR/issue), plus owner reviews. An item closes when a later event for the same task, PR or issue shows it moved on: `ready`, `picked`, `dispatched`, `repair_dispatched`, `run_started`, `contract_pinned`, `human_action`, `merged`, `cancelled`, `accepted` or `rejected` (real ones only), or when its issue or PR is closed (the closed rule) |
| Owner reviews | Open, non-draft PRs in either repo whose body has a `Tier:` line saying `human` or `owner` (markdown bold allowed, case-insensitive), or with an `owner-review`, `human-tier` or `needs-human` label |
| Cost: today | The newest real `spend_snapshot` for today (UTC), measured plus reserved for runs in flight (a larger `run_finished` sum wins, as in the controller), against the daily cap `policies/budgets.yaml` `factory_per_day.max_aic` (10,000 AIC = $100, `DEFAULTS.aicBudget`): amber at 80%, red at 100% |
| Cost: to date | The sum of every run's latest measured AIC in the loaded window ("to date" when the window reaches the log's first event, else "in 14 days"). The tooltip splits it by workflow, drills and unattributed runs, and lists AIC per day |
| Reverts | Real `auto_revert` events |
| Escaped defects | Main commits whose post-merge `ci` failed (`check_result` with event `push`, workflow `ci`, conclusion `failure`), once per commit, leaving out merge commits of drill tasks |
| Reviewer objections | Real `needs_human` with reason `review_objected` |
| Repairs worked | Per real `repair_dispatched`: worked when the task's PR later merged with no `needs_human` for the task in between, failed when a `needs_human` came first, else pending; worked ÷ (worked + failed) |
| Human actions | `human_action` events in the last 7 days (reviews and others) plus `queued` events by a person (an actor that isn't a `[bot]`) |
| To unblock | `humanTouch()`: per real `needs_human`, the time to the next real event for the same task, PR or issue that resolves a Needs-you item (above) or closes the task (`task_done`); the median |
| Polled | The newest controller event (`heartbeat`, `spend_snapshot`, `dispatch_state`, dispatches, `auto_ready`, `auto_merge`, `needs_human`, `task_done`, …), coloured by the heartbeat's age (amber after 8 h, red after 12 h) |
| Next | `liveness()`: with work in flight or dispatch paused by a gate, the controller's follow-up chain polls again ~10 min after its last poll; otherwise, or once that time has passed, the next full hour (the schedule; GitHub's cron often runs hours late, so the tooltip shows the observed cadence) |
| Recent activity | `recentActivity()`: the newest 5 real events as "#<issue or PR> <task> <verb>", skipping heartbeats, spend snapshots, dispatch states, dequeues, passing checks and duplicates (`task_done`, `handoff_done`, `auto_merge`) |
| Where the time goes | `stageSummary()`: per non-drill task merged in the last 14 days (plain PRs without a task are left out), the time from each stage it reached (ready, picked, running, PR open, checks, queued, merged) to the next, labelled with the short task name; the top bar is the **median** per stage over those tasks, and the insight names the stage with the largest median |
| Time per stage | First time each stage was reached (`auto_ready` and `ready` count as ready). Uses the payload's own time (`opened_at`, `completed_at`, `at`, `merged_at`) where there is one, otherwise the event timestamp |

**Not derivable from v1 events yet:**

- *Human-tier PRs* and *closed issues or PRs*: v1 events carry neither, so they're read from
  GitHub's open lists (see above).
- *Tasks done before the loaded window*: a task with no events in the last 14 days shows as
  waiting ("no events in the loaded window"); load more with `?days=31`.
- *Golden pass %, per-job durations (queue wait, run setup, detection) and deploys* need
  outcome events the controller doesn't log yet.

## Watchdog

`watchdog.mjs` is scheduled hourly (GitHub runs it every few hours) and checks two things,
failing closed:

- **Heartbeat** (reason codes `heartbeat-fresh`, `heartbeat-too-old`, `no-heartbeat`,
  `audit-branch-missing`, `audit-branch-unreadable`, `audit-file-unreadable`): the newest
  valid `heartbeat` event in today's and yesterday's audit files must be at most 12 h old
  (`DEFAULTS.heartbeatAlertMin`, the same limit as the dashboard's red).
- **Verifier** (`verifier-fresh`, `verifier-too-old`, `verifier-never-succeeded`,
  `verifier-workflow-missing`, `verifier-unreadable`): the newest successful run of
  `audit-verify.yml` in this repo
  (`GET /repos/{GITHUB_REPOSITORY}/actions/workflows/audit-verify.yml/runs?branch=main&status=success&per_page=1`,
  needs `actions: read`) must have started at most 26 h ago. Its time is `run_started_at`,
  which is fixed once the run starts and never later than the verification, so it can't make
  a run look newer than it was. A 404, an API error, or no successful run ever alerts.

There's one issue, found by its `heartbeat-alert` label (so an open issue with the earlier
title "Controller heartbeat stale" is reused). It's titled "Factory liveness alert" and
lists every failing reason code with a section per check. It's opened only after **two
consecutive failing watchdog runs**, so one slow scheduler tick or transient read error
never opens it on its own. The previous run's verdict is read from a marker step in that
run's `watchdog` job, through the Actions jobs API: the step runs only when a run is
failing, so "success" means the previous run failed and "skipped" means it was healthy (an
unknown previous verdict counts as failing). While the issue is open it gets a comment on
each failing run, and it's closed on the first healthy run, when both checks pass.
`WATCHDOG_DRY_RUN=1` reads everything and prints the plan without writing.

## Deploy

`.github/workflows/pages.yml` runs on pushes to `main` that touch `dashboard/**` or the
workflow, and on manual dispatch. It runs the tests on Node 24, then uploads `dashboard/`
as the Pages artifact and deploys it. All actions are pinned to commit SHAs.
