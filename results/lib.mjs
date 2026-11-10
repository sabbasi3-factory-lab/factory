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

const completed = (i) => i.state === 'closed' && i.state_reason !== 'not_planned';
const cancelledTask = (i) => i.state === 'closed' && i.state_reason === 'not_planned';
const isDrill = (title) => /^\[factory\] drill\//.test(title || '');
const isOracle = (title) => /onboarding oracle/.test(title || '');

/**
 * Per-language summary and totals. Pure.
 *   langs: languages(); issues: factory:task issues [{title, state, state_reason, created_at, closed_at}];
 *   merged: merged PRs [{number, title, head, merged_at}];
 *   agentPrs: merged agent PRs [{number, title, zero_touch: true | false | null}].
 * Time: v1 from the onboarding PR's merge (generated) or the first task issue (waves) to the last
 * task closing; an external locale from its oracle PR's merge to its last port PR's merge.
 * Done = closed as completed; a task closed as not planned is cancelled, never shipped. Shared-core
 * tasks (`common/*`) have no language row but count in the total.
 */
export function summarize({ langs, issues, merged, agentPrs }) {
  const rows = langs.map(({ code, method, steps }) => {
    const tasks = issues.filter((i) => (i.title || '').startsWith(`${code}/`));
    const done = tasks.filter(completed).length;
    const cancelled = tasks.filter(cancelledTask).length;
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
      const shipped = tasks.filter(completed);
      end = done > 0 && done + cancelled === tasks.length ? Math.max(...shipped.map((i) => ms(i.closed_at))) : null;
    }
    const finished = EXTERNAL[code] ? end !== null : done > 0 && done + cancelled === tasks.length;
    return {
      code, method, steps, tasks: tasks.length, tasks_done: done, tasks_cancelled: cancelled, prs,
      agent_prs: agent.length, hands_off: agent.filter((p) => p.zero_touch === true).length,
      hands_off_known: agent.filter((p) => p.zero_touch !== null).length, finished,
      hours: start !== null && end !== null && end >= start ? Math.round(((end - start) / 3600000) * 10) / 10 : null,
    };
  });
  const core = issues.filter((i) => (i.title || '').startsWith('common/') && completed(i)).length;
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
      tasks_done: rows.reduce((n, r) => n + r.tasks_done, 0) + core,
      core_tasks_done: core,
      agent_prs: real.length,
      hands_off: known.filter((p) => p.zero_touch).length,
      hands_off_known: known.length,
      reverts: reverts.filter((r) => !r.drill).length,
      drill_reverts: reverts.filter((r) => r.drill).length,
    },
    reverts,
  };
}

/**
 * Spend of v1's agent runs from the audit log. Per run: its newest final `run_spend`; before those
 * existed (#355, 2026-11-06), its newest entry in a `spend_snapshot` (reservations of runs still in
 * flight never count). A `bounded` run (usage incomplete) is counted at what it recorded,
 * max(readable_aic, observed_aic), as the migration budget counts it; its cap is reported beside it,
 * never added. A bounded run with neither figure is unknown. Pure.
 */
export function v1Spend(events) {
  const final = new Map();
  const snap = new Map();
  for (const e of events) {
    const p = e?.payload;
    if (e?.type === 'run_spend' && p?.dry_run === false && Number.isFinite(p.aic) && p.aic >= 0) final.set(p.run_id, p);
    // Measurements are real in both modes (the controller records snapshots in dry runs too).
    if (e?.type === 'spend_snapshot') for (const r of Array.isArray(p?.runs) ? p.runs : []) if (Number.isFinite(r?.aic) && r.aic >= 0) snap.set(r.run_id, r);
  }
  const out = { runs: 0, aic: 0, measured_runs: 0, from_snapshots: 0, bounded_runs: 0, bounded_aic: 0, bounded_cap_aic: 0, unknown: 0 };
  const add = (r, fromSnapshot) => {
    if (r.status === 'measured' || r.status === 'no_inference') {
      out.measured_runs++;
      out.aic += r.aic;
    } else if (r.status === 'bounded') {
      const seen = [r.readable_aic, r.observed_aic].filter((x) => Number.isFinite(x) && x >= 0);
      if (!seen.length) return void out.unknown++;
      out.bounded_runs++;
      out.bounded_aic += Math.max(...seen);
      out.bounded_cap_aic += r.aic;
      out.aic += Math.max(...seen);
    } else return;
    out.runs++;
    if (fromSnapshot) out.from_snapshots++;
  };
  for (const r of final.values()) add(r, false);
  for (const [id, r] of snap) if (!final.has(id)) add(r, true);
  return out;
}

/**
 * AIC of one v2 run from its usage files ({job: token_usage.jsonl text}), given the AI jobs that
 * ran (the Actions jobs API), as v2's router counts it (harness/v2/router.js runUsage). Incomplete
 * or malformed usage → null (unknown), never 0. Pure.
 */
export function v2RunUsage(files, inferred) {
  let aic = 0;
  for (const job of new Set([...inferred, ...Object.keys(files)])) {
    const text = files[job];
    if (text === undefined) return null;
    let sum = 0;
    let total = 0;
    let records = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return null;
      }
      const v = rec.ai_credits_this_response;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
      if (rec.ai_credits_total !== undefined) {
        if (typeof rec.ai_credits_total !== 'number' || !Number.isFinite(rec.ai_credits_total)) return null;
        total = Math.max(total, rec.ai_credits_total);
      }
      sum += v;
      records++;
    }
    if (total > sum + Math.max(0.001, sum * 1e-6)) return null;
    if (records === 0 && inferred.includes(job)) return null;
    aic += sum;
  }
  return aic;
}

/** Total cost: building the factory (build-cost.json) plus agent runs (v1 and v2). Pure. */
export function cost(build, v1, v2) {
  const runs = v1.aic + v2.aic;
  return {
    build_aic: build.ai_units, build_as_of: build.as_of,
    v1_aic: Math.round(v1.aic), v1_runs: v1.runs, v1_bounded_runs: v1.bounded_runs,
    v1_bounded_aic: Math.round(v1.bounded_aic), v1_bounded_cap_aic: Math.round(v1.bounded_cap_aic), v1_unknown: v1.unknown,
    v2_aic: Math.round(v2.aic), v2_runs: v2.runs, v2_unknown: v2.unknown,
    runs_aic: Math.round(runs), total_aic: Math.round(build.ai_units + runs),
  };
}

/**
 * Drills: the journal's fire-drill record and the agentic canary's finished runs. A canary run counts
 * only when it checked something (`checked`: its live-only steps ran; a dry run skips them all and
 * still succeeds) or failed; unknown (`checked: null`) runs are reported, not counted. Pure.
 */
export function drills(record, canaryRuns) {
  const decisive = canaryRuns.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure');
  const counted = decisive.filter((r) => r.conclusion === 'failure' || r.checked === true);
  return {
    fire_drills: record.runs.length,
    fire_drills_passed: record.runs.filter((r) => r.result === 'pass').length,
    as_of: record.as_of,
    canary_runs: counted.length,
    canary_passed: counted.filter((r) => r.conclusion === 'success').length,
    canary_dry: decisive.filter((r) => r.conclusion === 'success' && r.checked === false).length,
    canary_unknown: decisive.filter((r) => r.conclusion === 'success' && r.checked == null).length,
  };
}
