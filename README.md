# factory

An agentic software factory built on [GitHub Agentic Workflows (gh-aw)](https://github.github.com/gh-aw/). It works almost fully autonomously within approved limits: agents do the work, deterministic code enforces the rules, and the owner approves policies, not individual changes.

## How it works in one minute

| Piece | Role | What it is |
|---|---|---|
| `factory` repo | The rulebook | Design, policies, dashboard and audit checker. No product code. |
| `chrono-node-rs` | The product, plus the machinery | The Rust port, its tests and gates, and the workflows that run the factory. |
| Controller | The manager | Plain code on GitHub Actions, no AI. Picks tasks, starts agents, watches checks, merges, records everything and enforces the rules. Acts as the controller App. |
| Agent | The worker | Claude Sonnet 5.5 through the gh-aw `implement` workflow. One task → one PR. Acts as the agent App. |
| Reviewer | The inspector | A GPT-family model. Checks the risky PRs. Acts as the reviewer App. |

Every PR has a tier ([policies/tiers.yaml](policies/tiers.yaml)):
- **auto:** routine, low-risk work (locale parsers and refiners). Merged automatically when the checks pass.
- **auto-strict:** shared or core code. Merged automatically only after the strict gates pass, including the reviewer's approval and the full regression, one at a time, with automatic revert if `main` breaks. Promoted from owner review to automatic in [#22](https://github.com/sabbasi3-factory-lab/factory/pull/22).
- **human:** the rules and the referees (golden tests, the comparison harness, contracts, gates, workflows, the controller). The owner approves.

In short: the rulebook tells the manager how much to trust each worker's PR, and the risky ones get an inspector. Details are in [DESIGN.md](DESIGN.md).

The rules sit apart from the code they govern: agents work in chrono-node-rs and can't edit the rules or the verifier; the controller reads policies at a pinned commit (`.github/factory/factory-version`).

## Safety and records

- **Repair agent (Evergreen):** when an agent PR fails `ci`, the controller starts the gh-aw `repair` workflow on it, at most 2 times per task ([policies/limits.yaml](policies/limits.yaml)). The same failure twice, or still failing after that, goes to a person.
- **Audit log:** every controller decision is a hash-chained event on the append-only `audit` branch of chrono-node-rs. Only the controller App can push to it; no force-push, no deletion.
- **Independent verifier:** [verifier/](verifier/) in this repo, run by the scheduled `audit-verify` workflow with no App key. It re-checks the whole audit chain and appends an anchor line to this repo's append-only `anchors` branch.
- **Heartbeat watchdog:** [dashboard/watchdog.mjs](dashboard/watchdog.mjs), run hourly by `heartbeat-watchdog`. It opens a "Factory liveness alert" issue if the controller hasn't checked in for 12 h or the verifier hasn't succeeded for 26 h, after two failing checks in a row.
- **Kill switch:** the `FACTORY_ENABLED` repository variable in chrono-node-rs. Unless it is exactly `true`, nothing new is dispatched; runs in flight finish, then nothing merges.
- **Spend caps:** [policies/budgets.yaml](policies/budgets.yaml) caps AI credits per run, per workflow per day, per task (1,000) and for the whole factory per day (10,000, about $100). At the daily cap the factory pauses.
- **gh-aw Outcomes:** chrono-node-rs's `outcomes` workflow runs `gh aw logs --outcomes` on every agent run and publishes the result on its `outcomes` branch, which the dashboard reads.

## Results so far

As of 2026-11-04, from the [control room](https://sabbasi3-factory-lab.github.io/factory/) (audit log and gh-aw Outcomes):

- **Tasks merged:** 47 of 47 planned tasks (39 routine, 8 core), Oct 22 – Nov 3: the common code plus English, German and French. 0 reverts.
- **First try:** 45 of 47 merged without a repair run. Of the other 2, the repair agent fixed 1 and handed 1 to a person.
- **Speed:** median 13 min from a task's start to its merge.
- **Cost:** $40.12 of agent runs ($0.76 per accepted PR), plus $1,417 one-time to build the factory (as of Oct 30, from the [build journal](docs/JOURNAL.md)).

## More

- **[DESIGN.md](DESIGN.md):** the full design. It is the source of truth.
- **[policies/](policies/):** the rules the factory enforces.
- **[docs/JOURNAL.md](docs/JOURNAL.md):** the build journal: what was built, decisions and why, lessons.
- **Product repos:** [chrono-node-rs](https://github.com/sabbasi3-factory-lab/chrono-node-rs) (scenario 1: a Rust port of [chrono-node](https://github.com/wanasit/chrono)).
- **Control room:** the live dashboard at <https://sabbasi3-factory-lab.github.io/factory/>, built from the audit log ([dashboard/](dashboard/)).

Agents can't write to this repo. Every change is a reviewed PR.
