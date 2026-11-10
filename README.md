# factory

An agentic software factory built on [GitHub Agentic Workflows (gh-aw)](https://github.github.com/gh-aw/). It works almost fully autonomously within approved limits: agents do the work, deterministic code enforces the rules, and the owner approves policies, not individual changes.

## How it works in one minute

| Piece | Role | What it is |
|---|---|---|
| `factory` repo | The rulebook | Design, policies, the results page and audit checker. No product code. |
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
- **Heartbeat watchdog:** [watchdog/watchdog.mjs](watchdog/watchdog.mjs), run hourly by `heartbeat-watchdog`. It opens a "Factory liveness alert" issue if the controller hasn't checked in for 12 h, the verifier hasn't succeeded for 26 h, or a scheduled chrono-node-rs workflow (watchdog, monitor, onboard, upstream-sync, drills) failed its last two runs, after two failing checks in a row.
- **Kill switch:** the `FACTORY_ENABLED` repository variable in chrono-node-rs. Unless it is exactly `true`, nothing new is dispatched; runs in flight finish, then nothing merges.
- **Spend caps:** [policies/budgets.yaml](policies/budgets.yaml) caps AI credits per run, per workflow per day, per task (1,000) and for the whole factory per day (10,000, about $100). At the daily cap the factory pauses.
- **Agent operations:** [CAO](https://sabbasi3-factory-lab.github.io/cao-control/) (GitHub Next's Central Agentic Ops, monitoring only, in `cao-control`) shows agent runs, AI cost per run and workflow, failure streaks, firewall, MCP and model views, and gh-aw version drift. The custom Outcomes collector and the dashboard's ops panels were retired on 2026-11-10 in its favour.

## Results

All 17 chrono-node locales are ported (as of 2026-11-10): see the [results page](https://sabbasi3-factory-lab.github.io/factory/) ([results/](results/)) for languages and tasks shipped, the hands-off rate, reverts, time per language (factory v1, the v2 pilot and the goal-agent A/B), total cost (building the factory plus measured agent runs) and drills. It's rebuilt daily from what chrono-node-rs records.

## More

- **[DESIGN.md](DESIGN.md):** the full design. It is the source of truth.
- **[policies/](policies/):** the rules the factory enforces.
- **[docs/JOURNAL.md](docs/JOURNAL.md):** the build journal: what was built, decisions and why, lessons.
- **Product repos:** [chrono-node-rs](https://github.com/sabbasi3-factory-lab/chrono-node-rs) (scenario 1: a Rust port of [chrono-node](https://github.com/wanasit/chrono)).
- **Results page:** <https://sabbasi3-factory-lab.github.io/factory/> ([results/](results/)). **Operations:** [CAO](https://sabbasi3-factory-lab.github.io/cao-control/).

Agents can't write to this repo. Every change is a reviewed PR.
