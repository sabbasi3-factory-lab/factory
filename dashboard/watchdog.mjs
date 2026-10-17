// Liveness watchdog: alerts through one GitHub issue when
//  - the controller's hourly heartbeat is more than 2 hours old, missing, or can't be
//    read (DESIGN §11), or
//  - the factory's audit-verify workflow (independent audit-chain verifier) hasn't
//    succeeded in 26 hours, has never succeeded, or its runs can't be read.
// Runs from .github/workflows/heartbeat-watchdog.yml; the pure parts are unit-tested.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/factory node dashboard/watchdog.mjs
//   WATCHDOG_DRY_RUN=1 prints the plan without writing anything.
//
// Fails closed: anything unreadable is "unknown" and alerts; only a heartbeat or a
// verifier run that was actually read and is recent enough counts as "fresh".
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, dayPaths, formatAge, parseJsonl, parseTime, parseUtcSeconds, validateEvent } from './lib.js';

export const SOURCE_REPO = 'sabbasi3-factory-lab/chrono-node-rs';
export const AUDIT_BRANCH = 'audit';
export const LABEL = 'heartbeat-alert'; // kept for continuity: the open issue is found by this label
export const TITLE = 'Factory liveness alert';
export const MAX_AGE_MIN = DEFAULTS.heartbeatAlertMin; // 120: alert after 2 h
export const VERIFIER_WORKFLOW = 'audit-verify.yml'; // in the repo that holds the alert issue
export const VERIFIER_MAX_AGE_MIN = 26 * 60; // hourly runs; alert after 26 h without a success
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

  const unreadable = files.filter((f) => f.status !== 'ok' && f.status !== 'missing').map((f) => f.path);
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
  if (decision.unreadable?.length) lines.push(`- Unreadable: ${decision.unreadable.map((p) => `\`${p}\``).join(', ')}`);
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

/** Both checks together; the alert lasts while either fails. */
export function combine(heartbeat, verifier) {
  const failing = [heartbeat, verifier].filter((d) => d.alert).map((d) => d.reason);
  return { status: failing.length ? 'alert' : 'ok', alert: failing.length > 0, failing, heartbeat, verifier };
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
    ...(runUrl ? ['', `Watchdog run: ${runUrl}`] : []),
  ].join('\n');
}

/**
 * What to do with the alert issue, given the decision (from combine(), or a bare heartbeat
 * decision) and the open issues carrying LABEL. One issue lists every failing check and is
 * closed only when all of them are healthy.
 */
export function planIssueActions(decision, openIssues, runUrl = null) {
  const live = asLiveness(decision);
  const open = (openIssues || []).filter((i) => !i.pull_request).sort((a, b) => a.number - b.number);
  const details = describeLiveness(live, runUrl);
  if (live.alert) {
    const failing = live.failing.map((r) => `\`${r}\``).join(', ');
    if (open.length) return [{ op: 'comment', number: open[0].number, body: `Still alerting: ${failing}.\n\n${details}` }];
    const body = [
      `A factory liveness check is failing. The watchdog checks the controller's heartbeat on the \`${AUDIT_BRANCH}\` branch of ${SOURCE_REPO}, and the independent audit verifier (\`${VERIFIER_WORKFLOW}\` in this repo).`,
      '',
      details,
      '',
      `The controller writes a \`heartbeat\` event every hour (alert after ${MAX_AGE_MIN} min), and \`${VERIFIER_WORKFLOW}\` verifies the audit log every hour (alert after ${VERIFIER_MAX_AGE_MIN / 60} h without a success). This issue is updated by the hourly watchdog and closed automatically only when every check is healthy again.`,
    ].join('\n');
    return [{ op: 'create', title: TITLE, body, labels: [LABEL] }];
  }
  const recovered = live.verifier ? 'Heartbeat and audit verifier both healthy again. Closing.' : 'Heartbeat fresh again. Closing.';
  return open.flatMap((i) => [
    { op: 'comment', number: i.number, body: `${recovered}\n\n${details}` },
    { op: 'close', number: i.number },
  ]);
}

// ---------------------------------------------------------------------------
// GitHub I/O (fetch is injected for tests)

function apiHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'factory-heartbeat-watchdog' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Reads the audit branch head and today's and yesterday's day files, pinned to that head. */
export async function readAudit({ fetch, now, token = null, repo = SOURCE_REPO }) {
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

  const files = await Promise.all(dayPaths(now, 2).map(async (path) => {
    try {
      // The token is never sent to raw.githubusercontent.com.
      const r = await fetch(`${RAW}/${repo}/${sha}/${path}`, { headers: { 'User-Agent': 'factory-heartbeat-watchdog' } });
      if (r.status === 404) return { path, status: 'missing' };
      if (!r.ok) return { path, status: 'error', detail: `HTTP ${r.status}` };
      return { path, status: 'ok', text: await r.text() };
    } catch (err) {
      return { path, status: 'error', detail: `network: ${err?.message ?? err}` };
    }
  }));
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

/** Applies the plan to the alert issue in `repo` (the factory repo). */
export async function syncIssue({ fetch, token, repo, decision, runUrl = null, dryRun = false }) {
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
  const actions = planIssueActions(decision, open, runUrl);
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
  const liveness = combine(decision, verifier);
  const actions = await syncIssue({ fetch: fetchImpl, token, repo, decision: liveness, runUrl, dryRun });
  const summary = [
    `### Liveness watchdog: ${liveness.status} (heartbeat ${decision.status}, verifier ${verifier.status})`,
    '',
    describeLiveness(liveness, runUrl),
    '',
    `Issue actions${dryRun ? ' (dry run)' : ''}: ${actions.length ? actions.map((a) => `${a.op}${a.number ? ` #${a.number}` : ''}`).join(', ') : 'none'}`,
  ].join('\n');
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n');
  return { decision, verifier, liveness, actions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`liveness watchdog failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
