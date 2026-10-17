import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ANCHORS_PATH,
  canonicalize,
  checkAnchors,
  eventSha,
  parseAnchorLine,
  parseEventLine,
  readAnchorVersions,
  readBlobs,
  run,
  SOURCE,
  verifyAnchorHistory,
  verifyLog,
} from '../verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

// ---------------------------------------------------------------- builders

let n = 0;
function chain(timestamps, start = null) {
  const out = [];
  let prev = start;
  for (const timestamp of timestamps) {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const rec = { version: 1, id, type: 'heartbeat', timestamp, parents: prev ? [prev] : [], payload: { dedupe_key: `k${n}`, dry_run: true } };
    const ev = { ...rec, sha: eventSha(rec) };
    out.push(ev);
    prev = ev.sha;
  }
  return out;
}

function files(events) {
  const by = new Map();
  for (const e of events) {
    const [y, m, d] = e.timestamp.slice(0, 10).split('-');
    const p = `audit/${y}/${m}/${d}.jsonl`;
    by.set(p, `${by.get(p) ?? ''}${canonicalize(e)}\n`);
  }
  return [...by].map(([path, content]) => ({ path, content }));
}

const TS = ['2026-10-15T22:00:00Z', '2026-10-15T23:00:00Z', '2026-10-16T00:00:00Z', '2026-10-16T01:00:00Z'];
const HEAD = 'a'.repeat(40);
const anchorFor = (events, count, at, runId = 1) =>
  canonicalize({ at, audit_head: HEAD, events: count, last_sha: count ? events[count - 1].sha : null, run_id: runId, source: SOURCE, v: 1 });
const versionsOf = (...contents) => contents.map((content, i) => ({ commit: `${i}`.repeat(40).slice(0, 40), parents: i ? [`${i - 1}`.repeat(40).slice(0, 40)] : [], content }));

// ---------------------------------------------------------------- log

describe('log', () => {
  it('verifies the chain from genesis across day files', () => {
    const r = verifyLog(files(chain(TS)));
    assert.ok(r.ok, r.errors.join());
    assert.equal(r.events.length, 4);
  });

  it('accepts a real controller event line (format compatibility)', () => {
    const line = readFileSync(join(HERE, 'fixtures', 'controller-line.jsonl'), 'utf8').trim();
    assert.equal(parseEventLine(line).type, 'pr_opened');
  });

  it('rejects tampering, non-canonical lines, a missing start, wrong day files and stray files', () => {
    const ev = chain(TS);
    const f = files(ev);
    const tamper = (fn) => verifyLog(f.map((x) => ({ ...x, content: fn(x.content) })));
    assert.match(tamper((c) => c.replace('"dry_run":true', '"dry_run":false')).errors[0], /sha mismatch/);
    assert.match(tamper((c) => c.replace('{"id"', '{ "id"')).errors[0], /not canonical/);
    assert.match(verifyLog(files(ev.slice(1))).errors[0], /not a genesis event/);
    assert.match(verifyLog([{ path: 'audit/2026/10/15.jsonl', content: f.map((x) => x.content).join('') }]).errors[0], /not in its own day file/);
    assert.match(verifyLog([...f, { path: 'README.md', content: 'x\n' }]).errors[0], /unexpected file/);
    assert.match(verifyLog([...f, { path: 'audit/2026/10/14.jsonl', content: '' }]).errors[0], /empty day file/);
    assert.match(verifyLog(f.map((x) => ({ ...x, content: x.content.slice(0, -1) }))).errors[0], /newline/);
    // Sep 31 is not a real date.
    const bad = chain(['2026-09-31T10:00:00Z']);
    assert.match(verifyLog([{ path: 'audit/2026/09/31.jsonl', content: `${canonicalize(bad[0])}\n` }]).errors[0], /real UTC second/);
  });
});

// ---------------------------------------------------------------- anchors

describe('anchors', () => {
  const ev = chain(TS);
  const a1 = anchorFor(ev, 2, '2026-10-16T00:30:00Z');
  const a2 = anchorFor(ev, 4, '2026-10-16T01:30:00Z', 2);

  it('round-trips the anchor format and rejects anything else', () => {
    assert.equal(parseAnchorLine(a1).events, 2);
    assert.throws(() => parseAnchorLine(a1.replace('"v":1', '"v":2')), /v is not 1/);
    assert.throws(() => parseAnchorLine(a1.replace(SOURCE, 'other/repo')), /wrong source/);
    assert.throws(() => parseAnchorLine(anchorFor(ev, 0, '2026-10-16T00:30:00Z').replace('null,"run', `"${ev[0].sha}","run`)), /last_sha/);
    assert.throws(() => parseAnchorLine(`${a1} `), /canonical|JSON/);
  });

  it('accepts an append-only history and checks every anchor', () => {
    const h = verifyAnchorHistory(versionsOf(`${a1}\n`, `${a1}\n${a2}\n`));
    assert.ok(h.ok, h.errors.join());
    assert.equal(h.anchors.length, 2);
    assert.deepEqual(checkAnchors(ev, HEAD, h.anchors), []);
  });

  it('fails when a later commit edits or drops anchors, history is not linear, or the file disappears', () => {
    assert.match(verifyAnchorHistory(versionsOf(`${a1}\n${a2}\n`, `${a2}\n`)).errors[0], /not only appended/);
    assert.match(verifyAnchorHistory(versionsOf(`${a1}\n`, `${a1}\n`)).errors[0], /not only appended/);
    assert.match(verifyAnchorHistory(versionsOf(`${a1}\n`, null)).errors[0], /missing/);
    const v = versionsOf(`${a1}\n`, `${a1}\n${a2}\n`);
    v[1].parents = [];
    assert.match(verifyAnchorHistory(v).errors[0], /not linear/);
    assert.match(verifyAnchorHistory([]).errors[0], /no commits/);
    assert.match(verifyAnchorHistory(versionsOf(`${a2}\n`, `${a2}\n${a1}\n`)).errors.join(), /fewer events/);
  });

  it('detects a truncated tail, rewritten history and a deleted audit branch', () => {
    const anchors = [parseAnchorLine(a1), parseAnchorLine(a2)];
    assert.match(checkAnchors(ev.slice(0, 3), HEAD, anchors).join(), /log shrank: anchor #2 .* recorded 4 events, the log now has 3/);
    const rewritten = chain(['2026-10-15T22:00:00Z', '2026-10-15T23:00:00Z', '2026-10-16T00:00:01Z', '2026-10-16T01:00:00Z']);
    assert.match(checkAnchors(rewritten, HEAD, anchors).join(), /history rewritten: event #2/);
    assert.match(checkAnchors([], null, anchors).join(), /audit branch is gone/);
  });
});

// ---------------------------------------------------------------- decision

describe('run', () => {
  const ev = chain(TS);
  const base = { auditFiles: files(ev), auditHead: HEAD, at: '2026-10-16T05:00:00Z', runId: 7 };

  it('bootstraps only when asked; a scheduled run without the anchors branch fails', () => {
    assert.match(run({ ...base, anchorVersions: null, bootstrap: false }).errors[0], /anchors branch is missing/);
    const r = run({ ...base, anchorVersions: null, bootstrap: true });
    assert.ok(r.ok);
    assert.equal(r.next, `${anchorFor(ev, 4, '2026-10-16T05:00:00Z', 7)}\n`);
  });

  it('appends exactly one anchor after verifying against all earlier ones', () => {
    const old = `${anchorFor(ev, 2, '2026-10-16T00:30:00Z')}\n`;
    const r = run({ ...base, anchorVersions: versionsOf(old), bootstrap: false });
    assert.ok(r.ok, r.errors.join());
    assert.equal(r.anchors, 2);
    assert.ok(r.next.startsWith(old));
    assert.equal(r.next.split('\n').length, 3);
  });

  it('fails (and writes nothing) on a truncated log, and when the clock is not after the newest anchor', () => {
    const old = `${anchorFor(ev, 4, '2026-10-16T02:00:00Z')}\n`;
    const r = run({ ...base, auditFiles: files(ev.slice(0, 3)), anchorVersions: versionsOf(old), bootstrap: false });
    assert.equal(r.ok, false);
    assert.equal(r.next, null);
    assert.match(run({ ...base, at: '2026-10-16T02:00:00Z', anchorVersions: versionsOf(old), bootstrap: false }).errors[0], /clock/);
  });

  it('an empty audit branch with no anchors bootstraps to a zero anchor', () => {
    const r = run({ auditFiles: [], auditHead: null, anchorVersions: null, bootstrap: true, at: '2026-10-16T05:00:00Z', runId: 1 });
    assert.ok(r.ok);
    assert.equal(parseAnchorLine(r.next.trim()).events, 0);
  });
});

// ---------------------------------------------------------------- real git objects

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'verifier-'));
  temps.push(dir);
  const g = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args]).toString().trim();
  g('init', '-q', '-b', 'main');
  const commit = (fileMap, msg) => {
    for (const [p, c] of Object.entries(fileMap)) {
      mkdirSync(join(dir, dirname(p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    g('add', '-A');
    g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  return { dir, g, commit };
}

describe('git objects', () => {
  it('reads every blob even when .gitattributes would hide it from git archive (export-ignore)', () => {
    const ev = chain(TS);
    const repo = gitRepo();
    const map = Object.fromEntries(files(ev).map((f) => [f.path, f.content]));
    const head = repo.commit({ ...map, '.gitattributes': 'audit/2026/10/16.jsonl export-ignore\n' }, 'log');
    const blobs = readBlobs(repo.dir, head);
    assert.ok(blobs.some((b) => b.path === 'audit/2026/10/16.jsonl'));
    // ...and the stray .gitattributes itself fails verification.
    assert.match(verifyLog(blobs).errors[0], /unexpected file on the audit branch: .gitattributes/);
  });

  it('refuses symlinks and non-UTF-8 content instead of skipping them', () => {
    const repo = gitRepo();
    repo.commit({ 'audit/2026/10/15.jsonl': 'x\n' }, 'a');
    repo.g('rm', '-q', 'audit/2026/10/15.jsonl');
    mkdirSync(join(repo.dir, 'audit/2026/10'), { recursive: true });
    execFileSync('ln', ['-s', 'elsewhere', join(repo.dir, 'audit/2026/10/15.jsonl')]);
    repo.g('add', '-A');
    repo.g('commit', '-q', '-m', 'link');
    assert.throws(() => readBlobs(repo.dir, repo.g('rev-parse', 'HEAD')), /refusing audit\/2026\/10\/15.jsonl \(mode 120000/);

    const bin = gitRepo();
    const head = bin.commit({ 'audit/2026/10/15.jsonl': Buffer.from([0xff, 0xfe, 0x0a]) }, 'bin');
    assert.throws(() => readBlobs(bin.dir, head), /encoded|decode|invalid/i);
  });

  it('reads the anchors history commit by commit, and rejects extra files', () => {
    const ev = chain(TS);
    const repo = gitRepo();
    const a1 = `${anchorFor(ev, 2, '2026-10-16T00:30:00Z')}\n`;
    repo.commit({ [ANCHORS_PATH]: a1 }, '1');
    repo.commit({ [ANCHORS_PATH]: `${a1}${anchorFor(ev, 4, '2026-10-16T01:30:00Z', 2)}\n` }, '2');
    const v = readAnchorVersions(repo.dir, 'HEAD');
    assert.equal(v.length, 2);
    assert.ok(verifyAnchorHistory(v).ok);
    repo.commit({ 'notes.txt': 'x' }, '3');
    assert.throws(() => readAnchorVersions(repo.dir, 'HEAD'), /unexpected file notes.txt/);
  });

  it('CLI: fails closed with ::error:: and writes nothing when a fast-forward commit drops an anchor', () => {
    const ev = chain(TS);
    const audit = gitRepo();
    const head = audit.commit(Object.fromEntries(files(ev).map((f) => [f.path, f.content])), 'log');
    const anchors = gitRepo();
    const a1 = `${anchorFor(ev, 2, '2026-10-16T00:30:00Z')}\n`;
    const a2 = `${anchorFor(ev, 4, '2026-10-16T01:30:00Z', 2)}\n`;
    anchors.commit({ [ANCHORS_PATH]: `${a1}${a2}` }, '1');
    anchors.commit({ [ANCHORS_PATH]: a1 }, 'drop the newest anchor (a fast-forward)');
    const next = join(anchors.dir, 'next.jsonl');
    const r = spawnSync(process.execPath, [join(HERE, '..', 'verify.mjs')], {
      env: { PATH: process.env.PATH, AUDIT_HEAD: head, AUDIT_GIT_DIR: audit.dir, ANCHORS_REF: 'HEAD', ANCHORS_GIT_DIR: anchors.dir, NEXT_FILE: next, GITHUB_RUN_ID: '9' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::anchors commit [0-9a-f]{7}: anchors were changed or removed/);
    assert.throws(() => readFileSync(next));
  });

  it('CLI: verifies and writes the next anchors file', () => {
    const ev = chain(TS);
    const audit = gitRepo();
    const head = audit.commit(Object.fromEntries(files(ev).map((f) => [f.path, f.content])), 'log');
    const next = join(audit.dir, '..', `next-${Date.now()}.jsonl`);
    temps.push(next);
    const r = spawnSync(process.execPath, [join(HERE, '..', 'verify.mjs')], {
      env: { PATH: process.env.PATH, AUDIT_HEAD: head, AUDIT_GIT_DIR: audit.dir, BOOTSTRAP: 'true', NEXT_FILE: next, GITHUB_RUN_ID: '9' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout);
    const a = parseAnchorLine(readFileSync(next, 'utf8').trim());
    assert.deepEqual([a.events, a.audit_head, a.last_sha, a.run_id], [4, head, ev[3].sha, 9]);
  });
});
