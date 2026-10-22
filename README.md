# factory

An agentic software factory built on [GitHub Agentic Workflows (gh-aw)](https://github.github.com/gh-aw/). It works almost fully autonomously within approved limits: agents do the work, deterministic code enforces the rules, and the owner approves policies, not individual changes.

- **[DESIGN.md](DESIGN.md):** the full design. It is the source of truth.
- **[policies/](policies/):** the rules the factory enforces.
- **[docs/JOURNAL.md](docs/JOURNAL.md):** the build journal: what was built, decisions and why, lessons.
- **Product repos:** [chrono-node-rs](https://github.com/sabbasi3-factory-lab/chrono-node-rs) (scenario 1: a Rust port of [chrono-node](https://github.com/wanasit/chrono)).
- **Control room:** published on this repo's GitHub Pages (coming in Stage 0).

Agents can't write to this repo. Every change is a reviewed PR.
