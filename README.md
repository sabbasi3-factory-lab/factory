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

Every PR has a tier:
- **auto:** routine, low-risk work. Merged automatically when the checks pass.
- **auto-strict:** shared or core code. Merged automatically only after the reviewer approves and the full regression passes, one at a time, with automatic revert if `main` breaks.
- **human:** the rules and the referees (golden tests, the comparison harness, contracts, gates, workflows, the controller) and anything not yet promoted. The owner approves.

In short: the rulebook tells the manager how much to trust each worker's PR, and the risky ones get an inspector. Details are in [DESIGN.md](DESIGN.md).

- **[DESIGN.md](DESIGN.md):** the full design. It is the source of truth.
- **[policies/](policies/):** the rules the factory enforces.
- **[docs/JOURNAL.md](docs/JOURNAL.md):** the build journal: what was built, decisions and why, lessons.
- **Product repos:** [chrono-node-rs](https://github.com/sabbasi3-factory-lab/chrono-node-rs) (scenario 1: a Rust port of [chrono-node](https://github.com/wanasit/chrono)).
- **Control room:** published on this repo's GitHub Pages (coming in Stage 0).

Agents can't write to this repo. Every change is a reviewed PR.
