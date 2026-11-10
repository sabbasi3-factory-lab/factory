// Results page: pure logic (no network, no DOM). Turns what chrono-node-rs already records into the
// delivery numbers CAO doesn't show. Everything operational (runs, cost per run, failures, firewall,
// models, gh-aw versions) is on CAO.

export const CAO_URL = 'https://sabbasi3-factory-lab.github.io/cao-control/';
export const SOURCE_REPO = 'sabbasi3-factory-lab/chrono-node-rs';
export const AGENT = 'sabbasi3-factory-agent[bot]';

// How each language was ported. The two external locales are owner decisions of 2026-11-09
// (factory policies/onboarding.yaml `external_locales`); the rest follow from the repo: a generated
// `locale.json` means v1's generated onboarding, otherwise v1's hand-set-up waves.
export const EXTERNAL = { vi: 'goal agent (A/B)', it: 'factory v2' };

const codeOf = (module) => module.replace('_', '-');
const ms = (t) => (typeof t === 'string' && Number.isFinite(Date.parse(t)) ? Date.parse(t) : null);

/** Languages on main: module dirs under src/locales/ (from a recursive tree listing). Pure. */
export function languages(paths) {
  const mods = new Set();
  const generated = new Set();
  const contracts = {};
  for (const p of paths) {
    let m = /^src\/locales\/([a-z]{2}(?:_[a-z]{4})?)\/(.+)$/.exec(p);
    if (m) {
      mods.add(m[1]);
      if (m[2] === 'locale.json') generated.add(m[1]);
    }
    m = /^contracts\/([a-z]{2}(?:-[a-z]{4})?)\/([a-z0-9-]+)\.yaml$/.exec(p);
    if (m && !/^fix-[0-9a-f]+$/.test(m[2])) contracts[m[1]] = (contracts[m[1]] || 0) + 1;
  }
  return [...mods].sort().map((mod) => {
    const code = codeOf(mod);
    const method = EXTERNAL[code] ?? (generated.has(mod) ? 'v1 (generated onboarding)' : 'v1 (waves)');
    return { code, method, steps: contracts[code] || 0 };
  });
}

/** gh-aw's zero-touch: no comment, review or commit by a person (unknown → null). Pure. */
export function zeroTouch(pr) {
  const list = (c) => (c && Array.isArray(c.nodes) && !c.pageInfo?.hasNextPage ? c.nodes : null);
  const [comments, reviews, commits] = [list(pr.comments), list(pr.reviews), list(pr.commits)];
  if (!comments || !reviews || !commits) return null;
  const bot = (a) => !!a && (a.__typename === 'Bot' || /\[bot\]$/.test(a.login || ''));
  const botCommit = (n) => !!n?.commit?.author && (bot(n.commit.author.user) || /\[bot\]@users\.noreply\.github\.com$/.test(n.commit.author.email || ''));
  return comments.every((c) => bot(c.author)) && reviews.every((r) => bot(r.author)) && commits.every(botCommit);
}

/** The language of a PR title: `[factory] <code>/<task>:`, `[factory] <code>:` or `<code>:`. Pure. */
export function prLanguage(title) {
  const m = /^(?:\[factory\] )?([a-z]{2}(?:-[a-z]{4})?)(?:\/[a-z0-9_-]+)?:/.exec(title || '');
  return m ? m[1] : null;
}

const isDrill = (title) => /^\[factory\] drill\//.test(title || '');
const isOracle = (title) => /onboarding oracle/.test(title || '');

/**
 * Per-language summary and totals. Pure.
 *   langs: languages(); issues: factory:task issues [{title, state, created_at, closed_at}];
 *   merged: merged PRs [{number, title, head, merged_at}];
 *   agentPrs: merged agent PRs [{number, title, zero_touch: true | false | null}].
 * Time: v1 from the onboarding PR's merge (generated) or the first task issue (waves) to the last
 * task closing; an external locale from its oracle PR's merge to its last port PR's merge.
 */
export function summarize({ langs, issues, merged, agentPrs }) {
  const rows = langs.map(({ code, method, steps }) => {
    const tasks = issues.filter((i) => (i.title || '').startsWith(`${code}/`));
    const done = tasks.filter((i) => i.state === 'closed').length;
    const agent = agentPrs.filter((p) => prLanguage(p.title) === code && !isDrill(p.title));
    let start = null;
    let end = null;
    let prs = agent.length;
    if (EXTERNAL[code]) {
      const own = merged.filter((p) => prLanguage(p.title) === code);
      const oracle = own.filter((p) => isOracle(p.title)).map((p) => ms(p.merged_at));
      const port = own.filter((p) => !isOracle(p.title)).map((p) => ms(p.merged_at));
      start = oracle.length ? Math.min(...oracle) : null;
      end = port.length ? Math.max(...port) : null;
      prs = port.length;
    } else {
      const onboard = merged.filter((p) => p.head === `factory/onboard/${code}`).map((p) => ms(p.merged_at));
      start = onboard.length ? Math.max(...onboard) : tasks.length ? Math.min(...tasks.map((i) => ms(i.created_at))) : null;
      end = tasks.length && done === tasks.length ? Math.max(...tasks.map((i) => ms(i.closed_at))) : null;
    }
    const finished = EXTERNAL[code] ? end !== null : tasks.length > 0 && done === tasks.length;
    return {
      code, method, steps, tasks: tasks.length, tasks_done: done, prs,
      agent_prs: agent.length, hands_off: agent.filter((p) => p.zero_touch === true).length, finished,
      hours: start !== null && end !== null && end >= start ? Math.round(((end - start) / 3600000) * 10) / 10 : null,
    };
  });
  const real = agentPrs.filter((p) => !isDrill(p.title));
  const known = real.filter((p) => p.zero_touch !== null);
  // A revert of a drill PR (the auto-revert drill) is the safety net working, not a defect.
  const titleOf = new Map(merged.map((p) => [p.number, p.title]));
  const reverts = merged
    .filter((p) => /^factory\/revert-[0-9]+$/.test(p.head || '') || /^Revert /.test(p.title || ''))
    .map((p) => {
      const of = Number((/^factory\/revert-([0-9]+)$/.exec(p.head || '') || /^Revert #([0-9]+)/.exec(p.title || '') || [])[1]);
      return { number: p.number, title: p.title, merged_at: p.merged_at, drill: isDrill(titleOf.get(of)) };
    });
  return {
    rows,
    totals: {
      languages: rows.length,
      finished: rows.filter((r) => r.finished).length,
      tasks_done: rows.reduce((n, r) => n + r.tasks_done, 0),
      agent_prs: real.length,
      hands_off: known.filter((p) => p.zero_touch).length,
      hands_off_known: known.length,
      reverts: reverts.filter((r) => !r.drill).length,
      drill_reverts: reverts.filter((r) => r.drill).length,
    },
    reverts,
  };
}

/** Measured spend of v1's agent runs: the controller's final `run_spend` per run (audit log). Pure. */
export function v1Spend(events) {
  const byRun = new Map();
  for (const e of events) {
    const p = e?.payload;
    if (e?.type === 'run_spend' && p?.dry_run === false && Number.isFinite(p.aic) && p.aic >= 0) byRun.set(p.run_id, p.aic);
  }
  return { runs: byRun.size, aic: [...byRun.values()].reduce((a, b) => a + b, 0) };
}

/** Total cost: building the factory (build-cost.json) plus measured agent runs (v1 and v2). Pure. */
export function cost(build, v1, v2) {
  const runs = v1.aic + v2.aic;
  return {
    build_aic: build.ai_units, build_as_of: build.as_of,
    v1_aic: Math.round(v1.aic), v1_runs: v1.runs,
    v2_aic: Math.round(v2.aic), v2_runs: v2.runs, v2_unknown: v2.unknown,
    runs_aic: Math.round(runs), total_aic: Math.round(build.ai_units + runs),
  };
}

/** Drills: the journal's fire-drill record and the agentic canary's finished runs. Pure. */
export function drills(record, canaryRuns) {
  const decisive = canaryRuns.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure');
  return {
    fire_drills: record.runs.length,
    fire_drills_passed: record.runs.filter((r) => r.result === 'pass').length,
    as_of: record.as_of,
    canary_runs: decisive.length,
    canary_passed: decisive.filter((r) => r.conclusion === 'success').length,
  };
}
