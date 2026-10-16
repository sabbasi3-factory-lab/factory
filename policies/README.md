# Factory policies

These files are the rules the factory enforces. The rule is **approve policies, not changes**:

- the owner approves a policy once, through a reviewed PR to this repo
- code enforces it on every change

Agents can never edit this repo.

| File | What it controls |
|---|---|
| [`tiers.yaml`](tiers.yaml) | Which paths auto-merge, which need strict gates, and which need a human |
| [`limits.yaml`](limits.yaml) | Loop bounds: work in progress, repairs, time limits, the human queue |
| [`budgets.yaml`](budgets.yaml) | AI Credit caps per run, per task, per workflow and per day |
| [`dependencies.yaml`](dependencies.yaml) | The dependency steward's hard checks, soft checks, allowlist and denylist |
| [`network.yaml`](network.yaml) | What agents can and can't reach |
| [`cadence.yaml`](cadence.yaml) | When scheduled jobs run |

**Changing a policy:**

- Tightening (stricter limits) may also happen automatically at runtime. For example, the controller pauses an area after a missed drill.
- **Loosening always needs a reviewed PR here.**
