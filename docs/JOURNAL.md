# Build journal

This is the running story of building the factory: what was built, what was decided and why,
what broke, and what we'd tell another team. Newest phase last.

**How this file is kept**

- Every factory or chrono-node-rs PR ends with a `## Journal` section. When it merges, its entry is
  appended here, under the current phase: one line on what changed, plus the lesson, if there is one.
- Decisions made in chat (by the owner or the user) are recorded in [Decisions](#decisions), with the
  reason, so nobody has to rebuild them from PR threads.
- `Cost:` figures are best-effort estimates of the coding agent's own model use. They don't include
  factory run spend, which is in the audit log and on the dashboard. "shared" means the work overlapped
  with another PR, so it can't be split.
- The PRs and the `audit` branch remain the source of truth. This file is the readable index.

Repos: `factory` (design, policies, dashboard, verifier) and `chrono-node-rs` (the port and the
factory's controller, gates and workflows). `#N` means chrono-node-rs; `factory#N` means this repo.

---

## Phase 0: design (Oct 16)

- **factory#1**: DESIGN.md and policies v0.3 (`tiers`, `limits`, `budgets`, `dependencies`,
  `network`, `cadence`). Factory version 1 = `320c4fc`. The rule: *approve policies, not changes*.

## Phase 1: Stage 0, by hand (Oct 16)

The goal was a hand-built base that agents can copy, plus every gate an agent PR will face.
These PRs predate the per-PR Journal sections, so this section was written from the PR threads.

| PR | What | Notes |
|---|---|---|
| #1 | chrono-node pinned at v2.10.3 in `upstream/`, with its MIT `NOTICE` | |
| #2 | Golden-test generator: runs real chrono-node with `TZ=UTC` over chrono-node's own test cases | Each test keeps its own reference date (fallback `2012-08-10T12:00:00Z`). Every case records its reference, TZ and `requires` (which parsers and refiners it needs), so a case is checked only once all of those are ported. |
| #3 | Rust core: results, components, context, JS `Date` and regex emulation, auto-registration | `build.rs` registers every parser and refiner file, so parallel agents never edit the same registration lines. |
| #4, #5, #13 | Hand ports: casual date, weekday, time expression; golden runner; JSON CLI | #13 = late Copilot findings on #4. |
| #6 | Comparison harness: random phrases and reference dates (2000–2040) from a seed, Node vs Rust | |
| #7 | `PORTING.md`: patterns for agents, and the three traps (regex lookahead, string length, time zones) | |
| #8 | CI: `checks` (untrusted build and tests, no secrets) + `gates` (trusted, runs base code, treats the PR as data) | At most 2 jobs per PR. Required on ruleset 25260035, on `pull_request` and `merge_group`. |
| #9 | Shared refiner bases + English merge refiners | |
| #10, #11 | Seed script and task map → 26 contracts (core + English), reviewed as a contracts-only PR | |
| #12 | Model smoke test: 25 models usable on this seat | Owner chose `claude-sonnet-5.5` as the placeholder; week-1 comparison vs `gpt-5.3-codex`. |
| #14 | Controller v1 in dry-run, hash-chained audit log | |
| #15 | gh-aw implement workflow (v0.92.0): pinned model, blocked network, strict threat detection | |
| #18 | Scope gate reports protected-path changes even when there's no contract | |
| factory#2 | Dashboard v1 on Pages | |

**Drills** (#16, #17, #19, #21): a protected file moved into scope, and a lockfile resolving outside
npmjs. `gates` failed on each, as it should. #19 exposed that the scope gate stopped at "no contract"
before checking paths, which led to #18.

**Incident: internal npm URLs.** This machine reaches npm only through an internal mirror, and
two lockfiles were pushed with the mirror's URLs. Branch history was rewritten to registry.npmjs.org;
the owner accepted the exposure (no purge). Prevention: a `gates` scan for lockfile hosts and internal
identifiers, and scrubbing after every install.

## Phase 2: hardening before going live (Oct 16–17)

- **#20**: fail-closed fixes in the controller and implement workflow.
  - *What broke:* #14 and #15 were merged into their stacked base by accident, so the review fixes
    landed here instead. Retarget stacked PRs to `main` before review, or label them do-not-merge.
  - *Lesson:* fail-open defaults hide in "no data" paths (no spend records, no gates run, no pick
    event). Each had a passing test, because the test supplied the data. **Test the absence of data.**
- **#22**: trusted held-out seed via **commit–reveal**, and a step-based failure signature.
  - *Lesson:* "print the seed after the run" and "take it only from a trusted step" looked
    contradictory. Commit–reveal satisfies both with no extra job. Treat every byte a candidate's job
    prints as untrusted.
- **#24**: the Stage 0 exit check (a fresh PR through every gate, the merge queue, the audit log and
  the dashboard). *Lesson:* run the exit check *after* every piece is live, not as a replay.
- **factory#3**: heartbeat-aware status and a heartbeat watchdog in a separate repo.
  - *Lesson:* a dashboard warns only while someone is looking at it. Put liveness alerting outside
    the thing it watches, and make "can't read" mean "alert".
- **factory#4**: dashboard v2, the glance rework. Word budget ≤80 above the fold; 574 → 150 visible
  words. *Lesson:* the "no console errors" check had been filtering out 404s. A concrete mock-up with
  real field names got the layout right in one pass. Cost: ~2083 AI units.
- **factory#5** (supersedes #23): independent hourly chain verifier with append-only anchors.
  - *Lesson:* a hash chain alone can't detect a cut tail; you need the length recorded somewhere else.
    An anchor is external only if the log's writer *can't write* to it. Prove permissions from the
    token's side, not the settings page.

## Phase 3: liveness on a real scheduler (Oct 18–21)

- **factory#10**: liveness limits from measured cron cadence: heartbeat amber 8 h, alert 12 h;
  verifier amber 8 h, alert 26 h. An alert needs 2 consecutive failing watchdog runs, and a skipped
  marker counts as healthy only if that watchdog job succeeded. Also retried day-file reads and the
  word budget.
  - *Measured:* "hourly" cron on GitHub Free ran every 2–8 h (one gap of 7.6 h with nothing broken),
    which caused false alarms factory#6–#9.
  - *Accepted limit:* cron-based liveness on Free can't detect an outage faster than about 12 h.
  - *Lesson:* read the run log before you fix the story. The "day rollover" bug was really a
    transient read of yesterday's file. Cost: ~1627 AI units.

## Phase 4: the canary (Oct 21–22)

- **Seed:** issues #26–#51 created from the contracts, all Proposed, and added to Project #1.
- **Canary pick:** `en/time-unit-ago-format-parser` (#45): a leaf file with few golden cases and
  no shared bases.
- **#52**: live mode, only when `FACTORY_ENABLED` is exactly `true`. Real actions: dispatch
  implement, controller labels, templated comments. Order: label → dispatch → record, so a crash can't
  double-dispatch.
  - *Lesson:* even with live mode on, the canary would have sat idle, because nothing fed the
    spend check, so spend was "unknown" and the check correctly refused. Cost: ~1243 AI units, shared
    with seeding.
- **#53**: spend collector. Today's implement runs are completed (measured AIC from gh-aw usage
  artifacts), in flight (reserved at 900 = implement 500 + detection 400), or unreadable (unknown, so
  nothing is dispatched).
  - *Lesson:* prove "zero" from step results, not from a missing file. A missing file means
    "unknown", never "free". Cost: ~635 AI units.
- **Go live (Oct 21, 22:11Z):** `FACTORY_ENABLED=true`, `factory:ready` on #45. The controller
  dispatched run 39684783727, and the agent opened **#54** with one in-scope file (+55 lines).
  `checks` and `gates` are green. Run spend: **31.38 AIC**.
- **#54 didn't merge on its own:** the merge stage hadn't been built.
- **#55** (open, owner-tier): merge stage. It enqueues only `tier: auto` agent PRs with green
  `checks` and `gates` on the current head, an exact Contract-SHA, the task `factory:picked` and no
  `needs-human`. The enqueue pins `expectedHeadOid`; a refusal goes to a human once; a 5xx retries.
  Copilot review is a signal, not a gate.
  - *Lesson:* the merge stage is mostly about saying no: 10 conditions around one GraphQL call.
    Make "refused" and "transient" different outcomes. Cost: ~380 AI units.

---

## Decisions

| When | Decision | Why | By |
|---|---|---|---|
| Oct 16 | Golden cases keep each upstream test's own reference date; record reference and TZ per case | Matches upstream exactly; cases are self-describing | User |
| Oct 16 | Comparison reference dates random 2000–2040 from the seed | Covers more date arithmetic than a fixed date | User |
| Oct 16 | Placeholder model `claude-sonnet-5.5`; compare vs `gpt-5.3-codex` in week 1 | One pinned model, never `auto` | Owner |
| Oct 16 | Accept the npm mirror URL exposure; no history purge | Low risk; prevention added in `gates` | Owner |
| Oct 17 | Held-out seed via commit–reveal | Trusted *and* printed after the run, with no extra job | User |
| Oct 18–21 | Liveness limits 12 h / 26 h, 2 consecutive failing runs before an alert | Measured cron gaps of 2–8 h; flapping alerts | User, owner |
| Oct 21 | Go canary with `en/time-unit-ago-format-parser` | Easiest auto-tier leaf task | Owner |
| Oct 21 | Spend: build a collector (option a), don't loosen fail-closed (option b) | Loosening fail-closed is the wrong precedent | User |
| Oct 21 | Reserve 900 AIC per in-flight run | Implement + detection caps; stricter is correct | User |
| Oct 22 | Build auto-merge before merging #54 by hand | No merge on the absent owner's behalf | User |
| Oct 22 | Copilot review on agent PRs is a signal, not a gate; one Copilot pass on factory PRs | Avoid review loops | User |
| Later | Controller moves Project #1 "Factory status" as tasks change state | Separate PR, after the merge stage | User |

## Process rules (as they evolved)

- Push and open PRs as `sabbasi3`, never the work account.
- Owner-tier PRs (controller, gates, workflows, policies, factory repo) are merged by the owner, or
  by the agent only when the user says so directly.
- One Copilot review pass per PR: fix the valid findings, reply and resolve, no re-review loops.
- Every PR ends with `## Journal` (what surprised me / what broke / for a team doing this / Cost).
