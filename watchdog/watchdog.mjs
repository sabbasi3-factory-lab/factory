// Liveness watchdog: alerts through one GitHub issue when
//  - the controller's heartbeat is more than 12 hours old, missing, or can't be read
//    (DESIGN §11), or
//  - the factory's audit-verify workflow (independent audit-chain verifier) hasn't
//    succeeded in 26 hours, has never succeeded, or its runs can't be read, or
//  - one of chrono-node-rs's scheduled workflows (SCHEDULED_WORKFLOWS) failed its two newest
//    decisive runs on main in a row, or its runs can't be read,
// on TWO consecutive watchdog runs. GitHub runs the "hourly" schedules of a Free-plan org
// only every ~2–8 h (measured), so the limits are set from that, and one bad run (a slow
// scheduler, a transient read error) never opens an issue on its own.
// Runs from .github/workflows/heartbeat-watchdog.yml; the pure parts are unit-tested.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/factory node watchdog/watchdog.mjs
//   WATCHDOG_DRY_RUN=1 prints the plan without writing anything.
//
// Fails closed: anything unreadable is "unknown" and alerts; only a heartbeat or a
// verifier run that was actually read and is recent enough counts as "fresh".
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, dayPaths, formatAge, parseJsonl, parseTime, parseUtcSeconds, validateEvent } from './audit.mjs';

export const SOURCE_REPO = 'sabbasi3-factory-lab/chrono-node-rs';
export const AUDIT_BRANCH = 'audit';
export const LABEL = 'heartbeat-alert'; // kept for continuity: the open issue is found by this label
export const TITLE = 'Factory liveness alert';
export const MAX_AGE_MIN = DEFAULTS.heartbeatAlertMin; // 720: alert after 12 h
export const VERIFIER_WORKFLOW = 'audit-verify.yml'; // in the repo that holds the alert issue
export const VERIFIER_MAX_AGE_MIN = 26 * 60; // alert after 26 h without a success
export const WATCHDOG_WORKFLOW = 'heartbeat-watchdog.yml';
export const WATCHDOG_JOB = 'watchdog';
// chrono-node-rs's scheduled factory workflows: each alerts when its two newest decisive runs on
// main (success or a failure; skipped and cancelled runs don't count) both failed (outcomes.yml
// failed every run for ~5 h on 2026-11-04 with nobody told; it's retired since 2026-11-10, CAO covers
// agent operations). watchdog.yml is chrono-node-rs's own stall watchdog: if it breaks, this says so.
export const SCHEDULED_WORKFLOWS = ['watchdog.yml', 'monitor.yml', 'onboard.yml', 'upstream-sync.yml', 'drills.yml'];
export const WORKFLOW_FAILURES_IN_A_ROW = 2;
const DECISIVE = new Set(['success', 'failure', 'timed_out', 'startup_failure']);
// Name of the workflow step that runs only when this run's verdict is "failing". The next run
// reads it from the jobs API: success = the previous run was failing, skipped = it was healthy.
export const MARKER_STEP = 'Liveness failing (marker for the next run)';
const RAW_ATTEMPTS = 3;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

// ---------------------------------------------------------------------------
// Pure decision logic

/**
 * Newest valid heartbeat in the readable day files, or null. Only a complete audit record
 * (every required field, right shapes) whose timestamp is a real UTC time (exact round-trip,
 * so no "September 31") and not after `now` counts as proof of life.
 */
export function newestHeartbeat(files, now) {
  let best = null;
  for (const file of files) {
    if (file.status !== 'ok') continue;
    for (const rec of parseJsonl(file.text, file.path)) {
      const ev = rec.event;
      if (!ev || ev.type !== 'heartbeat' || validateEvent(ev).length !== 0) continue;
      if (typeof ev.timestamp !== 'string' || !TIMESTAMP.test(ev.timestamp)) continue;
      const ms = parseTime(ev.timestamp);
      if (ms == null || ms > now) continue;
      if (new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') !== ev.timestamp) continue;
      if (!best || ms > best.ms) best = { ms, timestamp: ev.timestamp, path: file.path, line: rec.line };
    }
  }
  return best;
}

/**
 * audit: { branch: 'ok' | 'missing' | 'error', headSha?, detail?, files?: [{ path, status: 'ok' | 'missing' | 'error', text? }] }
 * Returns { status: 'fresh' | 'stale' | 'unknown', alert, reason, last, ageMin, ... }.
 */
export function decide(audit, now, maxAgeMin = MAX_AGE_MIN) {
  const base = { checkedAt: new Date(now).toISOString().slice(0, 19) + 'Z', maxAgeMin, headSha: audit?.headSha ?? null, last: null, ageMin: null };
  if (audit?.branch === 'missing') return { ...base, status: 'stale', alert: true, reason: 'audit-branch-missing' };
  if (audit?.branch !== 'ok') return { ...base, status: 'unknown', alert: true, reason: 'audit-branch-unreadable', detail: audit?.detail ?? null };

  const files = Array.isArray(audit.files) ? audit.files : [];
  const last = newestHeartbeat(files, now);
  const ageMin = last ? Math.max(0, (now - last.ms) / 60000) : null;
  const withLast = { ...base, last, ageMin };
  if (last && ageMin <= maxAgeMin) return { ...withLast, status: 'fresh', alert: false, reason: 'heartbeat-fresh' };

  const unreadable = files.filter((f) => f.status !== 'ok' && f.status !== 'missing').map((f) => ({ path: f.path, detail: f.detail ?? null }));
  if (unreadable.length || !files.length) {
    return { ...withLast, status: 'unknown', alert: true, reason: 'audit-file-unreadable', unreadable };
  }
  if (!last) return { ...withLast, status: 'stale', alert: true, reason: 'no-heartbeat' };
  return { ...withLast, status: 'stale', alert: true, reason: 'heartbeat-too-old' };
}

const REASON_TEXT = {
  'heartbeat-fresh': 'The newest heartbeat is recent.',
  'heartbeat-too-old': 'The newest heartbeat is older than the limit.',
  'no-heartbeat': "There's no heartbeat event in today's or yesterday's audit file.",
  'audit-branch-missing': "The `audit` branch doesn't exist, so there's no heartbeat at all.",
  'audit-branch-unreadable': "The `audit` branch couldn't be read, so liveness is unknown.",
  'audit-file-unreadable': "An audit day file couldn't be read and no recent heartbeat was found, so liveness is unknown.",
};

export function describe(decision, runUrl = null) {
  const last = decision.last;
  const lines = [
    `- Status: **${decision.status}** (\`${decision.reason}\`). ${REASON_TEXT[decision.reason] ?? ''}`.trimEnd(),
    `- Last heartbeat: ${last ? `${last.timestamp} (\`${last.path}\` line ${last.line})` : 'none found'}`,
    `- Age: ${decision.ageMin == null ? 'unknown' : decision.ageMin < 120 ? formatAge(decision.ageMin) : `${formatAge(decision.ageMin)} (${Math.floor(decision.ageMin)} min)`}; alert after ${decision.maxAgeMin} min`,
    `- Checked: ${decision.checkedAt}${decision.headSha ? `, audit head \`${decision.headSha.slice(0, 7)}\`` : ''}`,
  ];
  if (decision.detail) lines.push(`- Detail: ${decision.detail}`);
  if (decision.unreadable?.length) lines.push(`- Unreadable: ${decision.unreadable.map((u) => (typeof u === 'string' ? `\`${u}\`` : `\`${u.path}\`${u.detail ? ` (${u.detail})` : ''}`)).join(', ')}`);
  if (runUrl) lines.push(`- Watchdog run: ${runUrl}`);
  return lines.join('\n');
}

/**
 * The independent verifier's state, from the newest successful audit-verify run:
 * verifier: { workflow: 'ok', run: <workflow run> | null } | { workflow: 'missing' } | { workflow: 'error', detail? }.
 * The run's time is its `run_started_at`: it's fixed once the run starts and is never later
 * than the verification itself, so it can't make a run look newer than it was (`updated_at`
 * can move later, e.g. when logs are deleted). Returns { status: 'fresh' | 'stale' |
 * 'missing' | 'unknown', alert, reason, last, ageMin, ... }.
 */
export function decideVerifier(verifier, now, maxAgeMin = VERIFIER_MAX_AGE_MIN) {
  const base = { checkedAt: new Date(now).toISOString().slice(0, 19) + 'Z', maxAgeMin, workflow: VERIFIER_WORKFLOW, last: null, ageMin: null };
  if (verifier?.workflow === 'missing') return { ...base, status: 'missing', alert: true, reason: 'verifier-workflow-missing' };
  if (verifier?.workflow !== 'ok') return { ...base, status: 'unknown', alert: true, reason: 'verifier-unreadable', detail: verifier?.detail ?? null };
  const run = verifier.run;
  if (run == null) return { ...base, status: 'missing', alert: true, reason: 'verifier-never-succeeded' };
  const ms = parseUtcSeconds(run?.run_started_at);
  if (!Number.isSafeInteger(run?.id) || run.id <= 0 || run.head_branch !== 'main' || run.status !== 'completed' || run.conclusion !== 'success' || ms == null || ms > now) {
    return { ...base, status: 'unknown', alert: true, reason: 'verifier-unreadable', detail: 'unexpected workflow run in the response' };
  }
  const url = typeof run.html_url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(run.html_url) ? run.html_url : null;
  const last = { id: run.id, startedAt: run.run_started_at, url };
  const ageMin = Math.max(0, (now - ms) / 60000);
  if (ageMin <= maxAgeMin) return { ...base, last, ageMin, status: 'fresh', alert: false, reason: 'verifier-fresh' };
  return { ...base, last, ageMin, status: 'stale', alert: true, reason: 'verifier-too-old' };
}

const VERIFIER_REASON_TEXT = {
  'verifier-fresh': 'The newest successful audit-verify run is recent.',
  'verifier-too-old': 'The newest successful audit-verify run is older than the limit.',
  'verifier-never-succeeded': 'audit-verify has never succeeded, so the audit log has no independent verification.',
  'verifier-workflow-missing': 'The audit-verify workflow was not found (HTTP 404), so the audit log has no independent verification.',
  'verifier-unreadable': "audit-verify's runs couldn't be read, so verification is unknown.",
};

const ageText = (ageMin) => (ageMin == null ? 'unknown' : ageMin < 120 ? formatAge(ageMin) : `${formatAge(ageMin)} (${Math.floor(ageMin)} min)`);

export function describeVerifier(v, runUrl = null) {
  const last = v.last;
  const lines = [
    `- Status: **${v.status}** (\`${v.reason}\`). ${VERIFIER_REASON_TEXT[v.reason] ?? ''}`.trimEnd(),
    `- Last success: ${last ? `run ${last.url ? `[${last.id}](${last.url})` : last.id}, started ${last.startedAt}` : 'none found'}`,
    `- Age: ${ageText(v.ageMin)}; alert after ${v.maxAgeMin} min`,
    `- Checked: ${v.checkedAt}, workflow \`${v.workflow}\``,
  ];
  if (v.detail) lines.push(`- Detail: ${v.detail}`);
  if (runUrl) lines.push(`- Watchdog run: ${runUrl}`);
  return lines.join('\n');
}

/**
 * The scheduled workflows' state. reads: [{ workflow, status: 'ok' | 'missing' | 'error', runs?, detail? }],
 * runs newest first as the API lists them. A workflow is failing when its WORKFLOW_FAILURES_IN_A_ROW
 * newest decisive runs all failed; fewer decisive runs than that never alert (a new or rarely run
 * workflow). Unreadable or missing alerts (fail closed), like the other checks.
 */
export function decideWorkflows(reads, now) {
  const base = { checkedAt: new Date(now).toISOString().slice(0, 19) + 'Z', repo: SOURCE_REPO, inARow: WORKFLOW_FAILURES_IN_A_ROW };
  const workflows = SCHEDULED_WORKFLOWS.map((workflow) => {
    const r = (reads || []).find((x) => x?.workflow === workflow);
    if (!r || r.status === 'error') return { workflow, status: 'unknown', detail: r?.detail ?? 'not read' };
    if (r.status === 'missing') return { workflow, status: 'missing' };
    const valid = (x) => Number.isSafeInteger(x?.id) && x.id > 0 && x.status === 'completed' && x.head_branch === 'main' && typeof x.conclusion === 'string';
    if (!Array.isArray(r.runs) || !r.runs.every(valid)) return { workflow, status: 'unknown', detail: 'unexpected workflow runs response' };
    const decisive = r.runs.filter((x) => DECISIVE.has(x.conclusion)).slice(0, WORKFLOW_FAILURES_IN_A_ROW);
    const last = decisive.map((x) => ({ id: x.id, conclusion: x.conclusion, url: typeof x.html_url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(x.html_url) ? x.html_url : null }));
    const failing = decisive.length === WORKFLOW_FAILURES_IN_A_ROW && decisive.every((x) => x.conclusion !== 'success');
    return { workflow, status: failing ? 'failing' : 'ok', last };
  });
  const bad = workflows.filter((w) => w.status !== 'ok');
  const has = (status) => bad.some((w) => w.status === status);
  const reason = !bad.length ? 'scheduled-workflows-ok' : has('failing') ? 'scheduled-workflow-failing' : has('missing') ? 'scheduled-workflow-missing' : 'scheduled-workflow-unreadable';
  return { ...base, status: bad.length ? 'alert' : 'ok', alert: bad.length > 0, reason, workflows };
}

export function describeWorkflows(w, runUrl = null) {
  const runText = (x) => (x.url ? `[${x.conclusion}](${x.url})` : x.conclusion);
  const lines = w.workflows.map((x) => {
    if (x.status === 'unknown') return `- \`${x.workflow}\`: **unknown** (runs couldn't be read${x.detail ? `: ${x.detail}` : ''})`;
    if (x.status === 'missing') return `- \`${x.workflow}\`: **missing** (HTTP 404)`;
    return `- \`${x.workflow}\`: **${x.status}**${x.last.length ? ` (newest decisive runs: ${x.last.map(runText).join(', ')})` : ' (no decisive run yet)'}`;
  });
  lines.push(`- Checked: ${w.checkedAt}, ${w.repo} on main; alert after ${w.inARow} failures in a row`);
  if (runUrl) lines.push(`- Watchdog run: ${runUrl}`);
  return lines.join('\n');
}

/** Every check together; the alert lasts while any fails. `workflows` is optional (older callers). */
export function combine(heartbeat, verifier, workflows = null) {
  const failing = [heartbeat, verifier, workflows].filter((d) => d && d.alert).map((d) => d.reason);
  return { status: failing.length ? 'alert' : 'ok', alert: failing.length > 0, failing, heartbeat, verifier, workflows };
}

// A bare heartbeat decision (from decide()) is still accepted and covers the heartbeat only.
const asLiveness = (decision) => (decision.heartbeat ? decision : { ...combine(decision, { alert: false }), verifier: null });

export function describeLiveness(decision, runUrl = null) {
  const live = asLiveness(decision);
  if (!live.verifier) return describe(live.heartbeat, runUrl);
  return [
    live.failing.length ? `Failing: ${live.failing.map((r) => `\`${r}\``).join(', ')}` : 'All checks pass.',
    '',
    '#### Controller heartbeat',
    describe(live.heartbeat),
    '',
    `#### Audit verifier (\`${live.verifier.workflow}\`)`,
    describeVerifier(live.verifier),
    ...(live.workflows ? ['', `#### Scheduled workflows (${live.workflows.repo})`, describeWorkflows(live.workflows)] : []),
    ...(runUrl ? ['', `Watchdog run: ${runUrl}`] : []),
  ].join('\n');
}

/**
 * What to do with the alert issue, given the decision (from combine(), or a bare heartbeat
 * decision) and the open issues carrying LABEL. One issue lists every failing check and is
 * closed only when all of them are healthy.
 */
export function planIssueActions(decision, openIssues, runUrl = null, previous = 'failing') {
  const live = asLiveness(decision);
  const open = (openIssues || []).filter((i) => !i.pull_request).sort((a, b) => a.number - b.number);
  const details = describeLiveness(live, runUrl);
  if (live.alert) {
    const failing = live.failing.map((r) => `\`${r}\``).join(', ');
    if (open.length) return [{ op: 'comment', number: open[0].number, body: `Still alerting: ${failing}.\n\n${details}` }];
    // A new issue needs two failing runs in a row. Only a previous run that was positively
    // healthy holds it back; an unknown previous verdict counts as failing (fail closed).
    if (previous === 'healthy') return [{ op: 'pending', failing: live.failing }];
    const body = [
      `A factory liveness check is failing. The watchdog checks the controller's heartbeat on the \`${AUDIT_BRANCH}\` branch of ${SOURCE_REPO}, and the independent audit verifier (\`${VERIFIER_WORKFLOW}\` in this repo).`,
      '',
      details,
      '',
      ...(live.workflows ? [`It also checks ${SOURCE_REPO}'s scheduled workflows (${SCHEDULED_WORKFLOWS.map((w) => `\`${w}\``).join(', ')}): one fails the check when its ${WORKFLOW_FAILURES_IN_A_ROW} newest runs that succeeded or failed on main all failed.`, ''] : []),
      `The controller writes a \`heartbeat\` event about every hour, and \`${VERIFIER_WORKFLOW}\` verifies the audit log about every hour, but GitHub runs these schedules only every ~2–8 h on this plan. So the watchdog alerts after ${MAX_AGE_MIN / 60} h without a heartbeat or ${VERIFIER_MAX_AGE_MIN / 60} h without a verification, and only when two watchdog runs in a row agree. This issue is updated by the watchdog and closed automatically when every check is healthy again.`,
    ].join('\n');
    return [{ op: 'create', title: TITLE, body, labels: [LABEL] }];
  }
  const recovered = live.workflows
    ? 'Heartbeat, audit verifier and scheduled workflows all healthy again. Closing.'
    : live.verifier ? 'Heartbeat and audit verifier both healthy again. Closing.' : 'Heartbeat fresh again. Closing.';
  return open.flatMap((i) => [
    { op: 'comment', number: i.number, body: `${recovered}\n\n${details}` },
    { op: 'close', number: i.number },
  ]);
}

// ---------------------------------------------------------------------------
// GitHub I/O (fetch is injected for tests)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'factory-heartbeat-watchdog' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Reads the audit branch head and today's and yesterday's day files, pinned to that head. */
export async function readAudit({ fetch, now, token = null, repo = SOURCE_REPO, retryDelayMs = 2000 }) {
  let res;
  try {
    res = await fetch(`${API}/repos/${repo}/branches/${AUDIT_BRANCH}`, { headers: apiHeaders(token) });
  } catch (err) {
    return { branch: 'error', detail: `network: ${err?.message ?? err}` };
  }
  if (res.status === 404) return { branch: 'missing', files: [] };
  if (!res.ok) return { branch: 'error', detail: `HTTP ${res.status}` };
  let sha;
  try {
    sha = (await res.json())?.commit?.sha;
  } catch {
    sha = null;
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return { branch: 'error', detail: 'unexpected branch response' };

  // A day file that doesn't exist yet (today's, before the first event) is 'missing', which is
  // normal: yesterday's file still holds the newest heartbeat. Other failures are retried, so
  // one transient error doesn't hide the heartbeat; what's still failing is reported with its
  // reason.
  const readOne = async (path) => {
    let last = null;
    for (let attempt = 1; attempt <= RAW_ATTEMPTS; attempt++) {
      try {
        // The token is never sent to raw.githubusercontent.com.
        const r = await fetch(`${RAW}/${repo}/${sha}/${path}`, { headers: { 'User-Agent': 'factory-heartbeat-watchdog' } });
        if (r.status === 404) return { path, status: 'missing' };
        if (r.ok) return { path, status: 'ok', text: await r.text() };
        last = `HTTP ${r.status}`;
      } catch (err) {
        last = `network: ${err?.message ?? err}`;
      }
      if (attempt < RAW_ATTEMPTS) await sleep(retryDelayMs * attempt);
    }
    return { path, status: 'error', detail: `${last} after ${RAW_ATTEMPTS} attempts` };
  };
  const files = await Promise.all(dayPaths(now, 2).map(readOne));
  return { branch: 'ok', headSha: sha, files };
}

/**
 * Reads the newest successful audit-verify run on `main` in `repo` (the factory repo). Runs on
 * other branches don't count: the verifier job only runs on main, so a dispatch elsewhere
 * "succeeds" without verifying anything.
 */
export async function readVerifier({ fetch, token = null, repo }) {
  let res;
  try {
    res = await fetch(`${API}/repos/${repo}/actions/workflows/${VERIFIER_WORKFLOW}/runs?branch=main&status=success&per_page=1`, { headers: apiHeaders(token) });
  } catch (err) {
    return { workflow: 'error', detail: `network: ${err?.message ?? err}` };
  }
  if (res.status === 404) return { workflow: 'missing' };
  if (!res.ok) return { workflow: 'error', detail: `HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.workflow_runs)) return { workflow: 'error', detail: 'unexpected workflow runs response' };
  return { workflow: 'ok', run: body.workflow_runs[0] ?? null };
}

/**
 * The newest completed runs on main of each scheduled workflow in `repo` (chrono-node-rs, public:
 * read with this repo's token). One failed read is that workflow's 'error', never the others'.
 */
export async function readWorkflows({ fetch, token = null, repo = SOURCE_REPO }) {
  return Promise.all(
    SCHEDULED_WORKFLOWS.map(async (workflow) => {
      try {
        const res = await fetch(`${API}/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=20`, { headers: apiHeaders(token) });
        if (res.status === 404) return { workflow, status: 'missing' };
        if (!res.ok) return { workflow, status: 'error', detail: `HTTP ${res.status}` };
        const body = await res.json().catch(() => null);
        if (!body || !Array.isArray(body.workflow_runs)) return { workflow, status: 'error', detail: 'unexpected workflow runs response' };
        return { workflow, status: 'ok', runs: body.workflow_runs };
      } catch (err) {
        return { workflow, status: 'error', detail: `network: ${err?.message ?? err}` };
      }
    }),
  );
}

/**
 * The verdict of the previous completed watchdog run on main (not this one): 'failing' when
 * its marker step ran, 'healthy' only when the marker step was skipped AND the job succeeded,
 * 'unknown' otherwise (the job failed or was cancelled, no earlier run, an older run without
 * the marker step, or an API error). 'unknown' counts as failing.
 */
export async function readPreviousVerdict({ fetch, token = null, repo, currentRunId = null }) {
  try {
    const res = await fetch(`${API}/repos/${repo}/actions/workflows/${WATCHDOG_WORKFLOW}/runs?branch=main&status=completed&per_page=5`, { headers: apiHeaders(token) });
    if (!res.ok) return 'unknown';
    const runs = (await res.json())?.workflow_runs;
    if (!Array.isArray(runs)) return 'unknown';
    const prev = runs.find((r) => Number.isSafeInteger(r?.id) && String(r.id) !== String(currentRunId ?? ''));
    if (!prev) return 'unknown';
    const jr = await fetch(`${API}/repos/${repo}/actions/runs/${prev.id}/attempts/${Number.isSafeInteger(prev.run_attempt) ? prev.run_attempt : 1}/jobs`, { headers: apiHeaders(token) });
    if (!jr.ok) return 'unknown';
    const job = ((await jr.json())?.jobs ?? []).find((j) => j?.name === WATCHDOG_JOB);
    const step = (job?.steps ?? []).find((st) => st?.name === MARKER_STEP);
    if (step?.conclusion === 'success') return 'failing';
    // A skipped marker proves "healthy" only if the job itself succeeded: setup, checkout or the
    // check can fail, the run can be cancelled, or the issue sync can error before the verdict
    // is written, and the marker is skipped in all of those cases too.
    if (step?.conclusion === 'skipped' && job?.conclusion === 'success') return 'healthy';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Applies the plan to the alert issue in `repo` (the factory repo). */
export async function syncIssue({ fetch, token, repo, decision, runUrl = null, dryRun = false, previous = 'failing' }) {
  const call = async (method, path, body) => {
    const res = await fetch(`${API}/repos/${repo}${path}`, {
      method,
      headers: { ...apiHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  const open = await call('GET', `/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`);
  const actions = planIssueActions(decision, open, runUrl, previous);
  if (dryRun) return actions;
  for (const a of actions) {
    if (a.op === 'create') {
      const label = await fetch(`${API}/repos/${repo}/labels/${encodeURIComponent(LABEL)}`, { headers: apiHeaders(token) });
      if (label.status === 404) {
        await call('POST', '/labels', { name: LABEL, color: 'b60205', description: 'Controller heartbeat or audit verifier is stale or unknown' });
      } else if (!label.ok) {
        throw new Error(`GET /labels/${LABEL}: HTTP ${label.status}`);
      }
      a.result = await call('POST', '/issues', { title: a.title, body: a.body, labels: a.labels });
    } else if (a.op === 'comment') {
      await call('POST', `/issues/${a.number}/comments`, { body: a.body });
    } else if (a.op === 'close') {
      await call('PATCH', `/issues/${a.number}`, { state: 'closed', state_reason: 'completed' });
    }
  }
  return actions;
}

export async function main(env = process.env, fetchImpl = globalThis.fetch, now = Date.now()) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY (owner/name of the repo for the alert issue) is required');
  const token = env.GITHUB_TOKEN || null;
  const dryRun = env.WATCHDOG_DRY_RUN === '1';
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;

  const audit = await readAudit({ fetch: fetchImpl, now, token });
  const decision = decide(audit, now);
  const verifier = decideVerifier(await readVerifier({ fetch: fetchImpl, token, repo }), now);
  const workflows = decideWorkflows(await readWorkflows({ fetch: fetchImpl, token }), now);
  const liveness = combine(decision, verifier, workflows);
  const previous = await readPreviousVerdict({ fetch: fetchImpl, token, repo, currentRunId: env.GITHUB_RUN_ID ?? null });
  const actions = await syncIssue({ fetch: fetchImpl, token, repo, decision: liveness, runUrl, dryRun, previous });
  // The workflow's marker step runs only when this run is failing; the next run reads it.
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `failing=${liveness.alert ? 'true' : 'false'}\n`);
  const summary = [
    `### Liveness watchdog: ${liveness.status} (heartbeat ${decision.status}, verifier ${verifier.status}, scheduled workflows ${workflows.status})`,
    '',
    describeLiveness(liveness, runUrl),
    '',
    `Previous watchdog run: ${previous}. Issue actions${dryRun ? ' (dry run)' : ''}: ${actions.length ? actions.map((a) => (a.op === 'pending' ? 'none yet (first failing run; an issue opens if the next run fails too)' : `${a.op}${a.number ? ` #${a.number}` : ''}`)).join(', ') : 'none'}`,
  ].join('\n');
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n');
  return { decision, verifier, workflows, liveness, actions, previous };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`liveness watchdog failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
