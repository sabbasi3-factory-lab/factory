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
| `build-cost.json` | What it cost to build the factory (research, design, coordination and build sessions), from the build journal: `{ "ai_units", "usd", "as_of", "source" }`. Deployed with the page and read same-origin |
| `drills.json` | The safety-drill record from the build journal: `{ "as_of", "source", "defects_found_and_fixed", "runs": [{ "id", "result": "pass" or "fail", "note"? }] }`. Deployed with the page and read same-origin |
| `test/lib.test.mjs`, `test/v2.test.mjs`, `test/verifier.test.mjs`, `test/drop-closed.test.mjs`, `test/dispatch-banner.test.mjs`, `test/redesign.test.mjs`, `test/scoreboard.test.mjs` | Tests for `lib.js` (`redesign.test.mjs`: the task board, cost join, medians, quality, liveness, recent activity and the closed rule; `scoreboard.test.mjs`: the status line, the five sentences, the two JSON files and the human-steps rule) |
| `test/make-fixture.mjs` | Generates the sample audit logs with real hashes and the verifier anchors over them: `test/fixtures/sample.jsonl` and `anchors.jsonl` (`?fixture=1`, a busy factory), and `quiet.jsonl` and `quiet-anchors.jsonl` (`?fixture=quiet`, a quiet factory with every task done), plus `sample-meta.json` and `quiet-meta.json`: the task map, contracts, task issues, build cost and drill record each sample uses instead of GitHub. It also writes `outcomes.json`, the busy sample's gh-aw Outcomes file (read same-origin; the quiet sample has none, to show the fallback). `outcomes-live-sample.json` is a real file from the source repo, for the parser test |
| `watchdog.mjs` | Liveness watchdog scheduled hourly by `.github/workflows/heartbeat-watchdog.yml`: keeps one "Factory liveness alert" issue (label `heartbeat-alert`) open while the heartbeat is over 12 h old, missing or unreadable, or `audit-verify` hasn't succeeded in 26 h, opening it only after two failing runs in a row (see [Watchdog](#watchdog)). Try it read-only with `GITHUB_REPOSITORY=<owner>/<repo> WATCHDOG_DRY_RUN=1 node dashboard/watchdog.mjs` |
| `test/watchdog.test.mjs` | Tests for the watchdog and for workflow permissions and action pins |
| `test/glance.test.mjs` | The 5-second glance test: word budgets, layout, tooltips and keyboard behaviour, measured on the rendered `?fixture=1` and `?fixture=quiet` pages in headless Chrome |
| `test/glance-measure.mjs`, `test/headless.mjs` | The in-page word and layout measurements, and a dependency-free headless-Chrome driver (static server, DevTools protocol over Node's `WebSocket`). Also a CLI that measures the live page |

## Layout

A results scoreboard first, operations second. Every number sits in a sentence that says what
it is. Tooltips (hover, or Tab to focus; Escape closes) say in at most two short sentences (25
words) what a number is and where it comes from; definitions, rules and lists are visible text in
Details, "How these numbers work". The tooltip is 14 px text, line-height 1.55, 320 px wide with
12 px padding, at 4.5:1 contrast or more in both themes. Times are relative ("12m ago",
"in 22m"); exact UTC times are only in titles and Details. The visible page avoids jargon (no
AIC, auto-strict, dispatch or heartbeat).

Top to bottom:

- **Header:** the data's age ("12s ago", tooltip: when it was checked, API requests left,
  token, factory version), Refresh, Theme and Settings, then the **status line**:
  "✓ Healthy · idle · nothing needs you". The health chip (rule below), then the state in plain
  words (`statusParts()`): the worst health problem ("last check-in 9h ago", "the audit log
  failed its integrity check", …), else "switched off" (the kill switch, a neutral grey), else the
  pause reason ("daily AI budget reached"), else "working on 2 tasks: X, Y" (linked to their
  issues), else "idle"; then what needs you: "nothing needs you", or "2 tasks need you: #28,
  #33" (linked, after the closed rule), "checking reviews…" or "review list unavailable".
  "Dry run" and "Sample" chips show when they apply.
- **Scoreboard:** five sentences, each with one big number:
  1. "Shipped: 26 of 26 tasks", under it "18 routine + 8 core" and the gh-aw Outcomes result for
     real work, "gh-aw Outcomes: 26 PRs accepted, 1 rejected, 0 pending" (else "gh-aw Outcomes
     not available yet");
  2. "Speed: about 10 min per task", under it the first and last finish dates ("Oct 22 → 27");
  3. "Total cost: about $1,126", under it "= $1,110 one-time build + $16.32 running" and the run
     split "$11.84 tasks + $4.47 drills · about $0.46 per accepted PR";
  4. "Hands-off: 25 of 26 PRs merged with no human edits (gh-aw zero-touch)", under it "2 manual
     steps after go-live" (ours: steps outside the PR), linked to the list in Details;
  5. "Quality: 0 reverts · reviewer blocked 1 change · 12 safety drills passed (6 defects
     fixed)", real work only, the drills linked to the build journal.

  The wording is tight because of the 120-word fold budget; the tooltips and Details carry the
  qualifiers (real work only, before merge, ported from JavaScript to Rust).
- **Task board:** one tile per task of the task map, grouped by its contract area, with a state
  colour and icon (✓ done, ▶ running, ⚠ needs you, ⧗ waiting); a legend shows when more than one
  state is present. A tile links to its issue; its tooltip has the task id, tier, state and since
  when.
- **Details** (one fold, closed): how these numbers work (the definitions and the data scope),
  Outcomes (gh-aw: the per-status table for real work and drills, last evaluated, the agent-only
  vs full-cost note, `gh aw outcomes <run-id>` to reproduce with one agent run id, and the agent
  runs), repairs (ours, as sentences), latest checks, where the time goes, task timeline, liveness (last and next check-in, the
  observed cadence and the health rule), human steps (the list behind sentence 4, plus all human actions of the
  shared account with its caveat), recent activity, and the audit log with the verifier line.
- **Footer:** "Read-only · verified in your browser".

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
  joined with titled and untitled agent runs, one manual step, a build cost and a drill record. The clock is pinned just
  after the last sample event. The same URL works on Pages, because the fixtures are published
  with the site. Sample mode makes no request to GitHub.
- <http://localhost:8000/?fixture=quiet> loads `test/fixtures/quiet.jsonl`, `quiet-anchors.jsonl`
  and `quiet-meta.json`: a quiet factory. Nothing needs you, the factory is off, dry run, all
  three tasks done, no build cost (the "unavailable" wording), the verifier OK, ten merged owner PRs, and heartbeats and anchors at the
  irregular cadence GitHub really delivers.

Other query parameters: `?poll=N` (seconds between checks, 10–3600, default 30) and
`?days=N` (1–31, default 14): the window of the operations views in Details (latest checks, the
check-in cadence, where the time goes). The scoreboard always uses the whole log.

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

- at most 120 visible words above the fold at 1440×900 (the owner's results-scoreboard
  request; it was 80, then 150 for the earlier one-screen layout);
- at most 250 visible words in total (closed `<details>`, hidden elements and tooltips
  don't count);
- no visible sentence longer than 8 words. The scoreboard sentences are longer, so each number
  and link is its own inline-block run and clauses are split by "·"; every run fits.

A word is a whitespace-separated token with a letter or digit, so icons, "·" and "—" aren't
words; a sentence ends at a "·", "|", ".", "!" or "?", a line break or the edge of its
element. The exact rules are on `measureGlance()` in `test/glance-measure.mjs`. The test
also checks the layout (the status line and the five sentences above the fold, then the board,
then one closed Details fold), the exact status line and sentences of both samples, that an
invalid build cost or drill record drops only its part with the reason in the tooltip, that the
"manual steps" link opens Details at the list, that no raw ISO time or jargon is visible, that
sample mode makes no GitHub request, the task board's state icons, colours, links and tooltips,
both themes, tooltips on keyboard focus, "View all" with Enter and Space, focus surviving a
re-render, no link text starting with "Open", nothing red or amber while the sample is held back,
the liveness and health tooltips' observed cadence, and a clean console. On failure it prints the
offending words and sentences.

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
   fetches **every** day file in it (`allDayPaths()`), from `raw.githubusercontent.com` pinned
   to the head SHA, so raw caching can't serve stale files. Raw downloads don't count against
   the API limit, and the log grows by one small file a day, so the scoreboard's numbers (tasks,
   speed, cost, human steps, quality) are lifetime results and the whole chain is verified from
   its first event. Only listed files are fetched, so there are no 404s. If the listing fails,
   it falls back to the last 14 days (a 404 is an empty day), and "How these numbers work" and
   the scoreboard's tooltips say the numbers cover only that window.
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
7. It reads `build-cost.json` and `drills.json` from the page's own site (same origin, no API
   cost), on load and then hourly, and validates them strictly (`validateBuildCost()`,
   `validateDrills()`: every field required with its type, no extra keys). If one is missing or
   invalid, only its part goes: the cost shows the running cost alone, the quality sentence drops
   the drills clause, and the tooltip gives the reason. In sample mode both come from the meta
   stand-ins (the quiet sample has no build cost on purpose).
8. It reads the **task issues**, one API call with an ETag:
   `GET /repos/sabbasi3-factory-lab/chrono-node-rs/issues?state=all&labels=factory:task&per_page=100`.
   Each issue's task id comes from the hidden `<!-- factory-task: <id> -->` marker in its body,
   else the title prefix (`<id>: Port <Class>`); PRs are ignored and bodies aren't kept. On load,
   then at most every 30 minutes, or sooner (at most every 2 minutes) when the audit log shows a
   new `task_done` or `merged`; only with at least 6 API requests left. If it can't be read, the
   board falls back to the audit log (the last good list is kept if there is one) and its
   tooltips say so.
9. **gh-aw Outcomes** come from `outcomes.json` on the source repo's `outcomes` branch, a raw
   download (no API cost), on load and on the PR lists' cadence. `parseOutcomesFile()` is
   tolerant: `runs` must be an array; runs without a numeric `run_id` or an `items` array are
   skipped (counted in Details); unknown fields are ignored. Its `runs[]` map each agent run to
   its workflow, task and drill flag, and `generated_at` is "last evaluated". If the file is
   missing or invalid, the last good copy stays, or the Outcomes lines say "gh-aw Outcomes not
   available yet" and the rest still works; a file generated over 48 h ago gives its age in the
   tooltip.

**Rate limits.** Without a token, GitHub allows 60 API requests an hour per IP, and
conditional requests that return 304 still count against it (they're only free when
authenticated). A first load takes about seven (branch, tree, two PR lists, open issues, the
anchors probe, task issues). In steady state the side reads take about 14 an hour (the PR lists
and open issues every 15 min, the task issues every 30 min, a few more after merges), and the
branch polls are spread over the rest. The
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
covers (it should match the page's own event count) with its audit head.
With `?fixture=1` it reads `test/fixtures/anchors.jsonl`, with `?fixture=quiet`
`test/fixtures/quiet-anchors.jsonl`.

## How the panels are derived

Drill tasks (`drill/*`, the factory's own fire drills) are left out of every task aggregate.
"Real" means not a dry-run plan (`isPlanOnly()`); observed facts such as `merged` always count.

| Item | Derivation (`lib.js`) |
|---|---|
| Status line | `healthSummary()` (the chip) and `statusParts()` (the state and what needs you, above) |
| Task board | `taskBoard()`: per task of the catalog, **done** when its task issue is closed as "completed" (no audit events needed); while the issue is open, only after the controller's `task_done`; an issue closed otherwise is never done. Without a known issue (or when the issue list can't be read): after a `merged` or `task_done` not followed by a reopening `ready`, `auto_ready`, `dispatched` or `repair_dispatched`. The tile links to the task issue; **needs you** with an open Needs-you item for the task; **running** once real work started (`dispatched`, `repair_dispatched` or `review_dispatched`) and not done, unless its issue or current PR is closed (the closed rule); **waiting** otherwise. "Since" is when it entered that state |
| Shipped | `shippedItem()`: done tiles of all tiles; "routine" = tier `auto`, "core" = tier `auto-strict`, from the contracts. The Outcomes line: `outcomesSummary()` of `outcomes.json`, `create_pull_request` items of real runs by `outcome_status` (a run is a drill when its `drill` flag is set or its task is `drill/*`; drills are counted apart, in Details) |
| Speed | `issueToMerged()` over every done real task whose start and merge are in the whole audit log (the tooltip says how many of the done tasks that is): from the task's first real `auto_ready` (else its first real `dispatched`) to its last `merged`; the median, in minutes up to 90, then hours. The dates are the first and last done times of real tasks |
| Total cost | `costItem()`: build (`build-cost.json`, `usd`) + run. Run = each agent run's latest measured AI credits across every real `spend_snapshot` in the whole log (a "reserved" entry never replaces a measurement): the full cost, agent plus the threat-detection job. $ = credits ÷ 100. `costJoin()` joins runs to tasks by run id through `outcomes.json`'s `runs[]`: drills (flag or `drill/*`) apart, real tasks everything else, including runs without a task (reviewer runs, for now) and runs the file doesn't list. Per accepted PR = real run cost ÷ real accepted PRs. gh-aw's own `aic` is agent-only; for real runs the full cost is about 1.56× it. Details compares the two over the same runs only (real runs with both a spend measurement and a gh-aw figure) and says how many of the measured real runs that covers. The median per done task is in Details only. Spend data is tracked apart from Outcomes (`cost.spend`): with real agent runs but no spend measurement, "running cost not available yet"; with no real run (a dry run), a known $0.00. Without `outcomes.json`: the run total, no split; without the build cost: the running cost only |
| Repairs (Details) | `repairStats()`: per real `repair_dispatched`, "fixed the PR" when the task's PR merged next, "handed to a person" when a `needs_human` for the task came first, else still running; real work and drills apart, plus the share of finished repairs that fixed the PR |
| Hands-off | gh-aw zero-touch: accepted real `create_pull_request` items with `zero_touch: true`, of all accepted real PRs |
| Manual steps (under Hands-off) | `humanSteps()`, after go-live (the earliest real `dispatched` of a non-drill task); go-live and each step use the action's own time (`eventTime()`: `at`, `submitted_at`), not the record time: `queued` by an actor that isn't a `[bot]` on an agent PR (one whose `pr_opened` author is a `[bot]`, or that a task event names), and `human_action` with an action other than a review or comment on an agent PR or a factory task. Plain reviews and comments, and anything on other PRs (the coordinator's own, under the shared account), don't count. Manual dispatches, label fixes and pushes count when the log records them as `human_action` |
| Quality | `qualityStats()`: real `auto_revert` events, and real `needs_human` with reason `review_objected`, both without drills; plus `drills.json`: runs with result "pass", and `defects_found_and_fixed` |
| Needs you | Open `needs_human` and `stale_contract` items, one per task (or PR/issue), plus owner reviews (open, non-draft PRs with a human or owner `Tier:` line or label). An item closes when a later real event for the same task, PR or issue shows it moved on, or when its issue or PR is closed (the closed rule) |
| Liveness (Details) | Last check-in: the newest controller event. Next: `liveness()`, ~10 min after the last poll with work in flight or a pause, else the next full hour (GitHub's cron often runs hours late; the tooltip shows the observed cadence) |
| Human actions (Details) | `humanTouch()`: `human_action` events in the last 7 days plus `queued` by a person. It counts every action by the shared account, including the coordinator's merges, so it isn't a measure of the owner's time |
| Recent activity (Details) | `recentActivity()`: one line per task (else per PR) with its latest real event, newest 5 |
| Where the time goes (Details) | `stageSummary()`: per non-drill task merged in the last 14 days, the time from each stage to the next; the top bar is the median per stage |

**Not derivable from v1 events yet:**

- *Human-tier PRs* and *closed issues or PRs*: v1 events carry neither, so they're read from
  GitHub's open lists (see above).
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
