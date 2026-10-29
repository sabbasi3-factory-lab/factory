// The 5-second glance test: word budgets, the one-screen layout and keyboard behaviour measured
// on the rendered sample pages in headless Chrome. The budgets are checked on both fixtures:
// ?fixture=1 (a busy factory: two tasks running, two need the owner, two waiting, two done, one
// manual step, a build cost and a drill record) and ?fixture=quiet (nothing needs the owner,
// factory off, dry run, all three tasks done, no build cost: the "unavailable" wording). No npm
// dependencies: see
// headless.mjs. Word, fold and sentence rules are defined on measureGlance() in
// glance-measure.mjs. Chrome is found via CHROME_PATH, common Linux names or the macOS
// app; without it the test is skipped locally and fails in CI (process.env.CI).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, serveDir } from './headless.mjs';
import { CADENCE_NOTE, anchorTimes, cadenceText, heartbeatTimes, observedCadence, parseAnchors, parseJsonl } from '../lib.js';
import { META_FIXTURE_PATH, QUIET_ANCHORS_FIXTURE_PATH, QUIET_FIXTURE_NOW, QUIET_FIXTURE_PATH } from './make-fixture.mjs';
import { BUDGETS, READY_EXPR, formatDetails, formatMeasurement, measureGlance, measureLayout } from './glance-measure.mjs';

const chrome = findChrome();
const skip = !chrome && !process.env.CI ? 'Chrome not found (set CHROME_PATH); the glance budgets were not measured' : false;
if (skip) console.log(`# glance test skipped: ${skip}`);

const KEYS = {
  Tab: { code: 'Tab', keyCode: 9 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Escape: { code: 'Escape', keyCode: 27 },
};

// The fixtures the budgets are measured on, by their ?fixture= value.
const FIXTURES = [
  { param: '1', name: 'sample' },
  { param: 'quiet', name: 'quiet' },
];

describe('glance: rendered sample pages', { skip, timeout: 180000 }, () => {
  let server = null;
  let browser = null;
  let page = null;
  let loaded = null; // the ?fixture= value of the page that's open
  const press = (key) => page.key(key, KEYS[key]);
  // Opens a fixture and waits for it to render, unless it's already open.
  const open = async (param = '1', { force = false } = {}) => {
    if (loaded === param && !force) return;
    await page.setViewport(1440, 900);
    await page.navigate(`${server.url}index.html?fixture=${param}`);
    await page.waitFor(READY_EXPR, { timeoutMs: 30000, what: `the dashboard to render ?fixture=${param}` });
    loaded = param;
  };
  const measure = async (width, height) => {
    await page.setViewport(width, height);
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    return page.call(measureGlance, { foldY: BUDGETS.foldY, maxSentenceWords: BUDGETS.sentenceWords });
  };
  const report = (label, r, opts) => `${formatMeasurement(label, r)}\n${formatDetails(r, opts)}`;

  before(async () => {
    assert.ok(chrome, 'Chrome is required in CI: install google-chrome or set CHROME_PATH');
    server = await serveDir(fileURLToPath(new URL('..', import.meta.url)));
    browser = await launchChrome(chrome, { width: 1440, height: 900, timeoutMs: 30000 });
    page = browser.page;
    await page.setColorScheme('light');
    await open('1');
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  for (const fx of FIXTURES) {
    test(`${fx.name}: 1440x900: at most ${BUDGETS.foldWords} words above the fold`, async () => {
      await open(fx.param);
      const r = await measure(1440, 900);
      assert.ok(r.aboveFoldWords <= BUDGETS.foldWords, report(`${fx.name} 1440x900`, r, { total: false, sentences: false }));
    });

    test(`${fx.name}: 1440x900: at most ${BUDGETS.totalWords} visible words`, async () => {
      await open(fx.param);
      const r = await measure(1440, 900);
      assert.ok(r.totalWords > 40, `suspiciously few words (${r.totalWords}): did the page render?`);
      assert.ok(r.totalWords <= BUDGETS.totalWords, report(`${fx.name} 1440x900`, r, { fold: false, sentences: false }));
    });

    test(`${fx.name}: 1440x900: no visible sentence over ${BUDGETS.sentenceWords} words`, async () => {
      await open(fx.param);
      const r = await measure(1440, 900);
      assert.deepEqual(r.longSentences, [], report(`${fx.name} 1440x900`, r, { fold: false, total: false }));
    });

    test(`${fx.name}: 390x844: at most ${BUDGETS.totalWords} visible words and no sentence over ${BUDGETS.sentenceWords} words`, async () => {
      await open(fx.param);
      const r = await measure(390, 844);
      await page.setViewport(1440, 900);
      assert.ok(r.totalWords <= BUDGETS.totalWords, report(`${fx.name} 390x844`, r, { fold: false, sentences: false }));
      assert.deepEqual(r.longSentences, [], report(`${fx.name} 390x844`, r, { fold: false, total: false }));
    });
  }

  test('quiet: the status pill and the KPI cards read as labelled phrases', async () => {
    await open('quiet');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => {
      const flat = (el) => el?.innerText.replace(/\\s+/g, ' ').trim() ?? null;
      return {
        status: flat(document.querySelector('.glance')),
        score: [...document.querySelectorAll('#score .score-item')].map((li) => [...li.querySelectorAll('p')].map(flat).join(' / ')),
        bigs: [...document.querySelectorAll('#score .score-item')].map((li) => li.querySelectorAll('.big').length),
        tiles: [...document.querySelectorAll('#board .tile')].map((t) => [t.getAttribute('aria-label'), t.querySelector('use').getAttribute('href')]),
        groups: [...document.querySelectorAll('#board .group-h')].map((g) => g.textContent.trim()),
        legend: flat(document.getElementById('board-legend')),
        costTip: document.getElementById(document.querySelector('.score--cost').getAttribute('aria-describedby')).textContent,
        drillsHref: document.querySelector('.score--quality a')?.getAttribute('href'),
      };
    })()`);
    assert.equal(r.status, 'Healthy · switched off · nothing needs you · Dry run · Sample');
    assert.deepEqual(r.score, [
      'Shipped / 3/3 tasks / 2 routine · 1 core / gh-aw Outcomes not available yet',
      'Speed / 15 min / per task · Oct 15 → 16',
      'Running cost / $0.00 / agent runs',
      'Hands-off / — / gh-aw Outcomes not available yet / 0 manual steps; not live yet',
      'Quality / 0 reverts / 0 changes blocked · 1 drill passed',
    ]);
    assert.deepEqual(r.bigs, [1, 1, 1, 1, 1], 'one big number per card');
    assert.equal(r.costTip, "Build cost unavailable: buildCost missing from the sample. Run: the real and drill split needs gh-aw Outcomes, not available yet.");
    assert.equal(r.drillsHref, 'https://github.com/sabbasi3-factory-lab/factory/blob/main/docs/JOURNAL.md');
    assert.deepEqual(r.tiles, [
      ['casual-time-parser: done', '#i-ok'], ['month-name-parser: done', '#i-ok'], ['iso-format-parser: done', '#i-ok'],
    ]);
    assert.deepEqual(r.groups, ['Casual', 'Months', 'Common parsers']);
    assert.equal(r.legend, '', 'one state only: the progress bar says it');
    // Switched off is the deliberate safe state: muted, not the alert colour.
    const colour = await page.evaluate(`(() => { const probe = (v) => { const e = document.createElement('i'); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      return [getComputedStyle(document.getElementById('state-part')).color, probe('var(--muted)'), probe('var(--alert)')]; })()`);
    assert.equal(colour[0], colour[1]);
    assert.notEqual(colour[0], colour[2]);
  });

  test('quiet: Details shows the observed cadence and the health rule; the tooltips stay short', async () => {
    await open('quiet');
    await page.setViewport(1440, 900);
    const events = parseJsonl(readFileSync(QUIET_FIXTURE_PATH, 'utf8'), 'quiet.jsonl').map((rec) => rec.event);
    const { anchors } = parseAnchors(readFileSync(QUIET_ANCHORS_FIXTURE_PATH, 'utf8'));
    const hbLine = cadenceText('Check-ins', observedCadence(heartbeatTimes(events)), 14);
    const vfLine = cadenceText('Verifications', observedCadence(anchorTimes(anchors, { now: Date.parse(QUIET_FIXTURE_NOW), days: 14 })), 14);
    assert.equal(hbLine, 'Check-ins: median every 2.4 h, longest gap 7.6 h (14 days)');
    assert.equal(vfLine, 'Verifications: median every 2.9 h, longest gap 5.1 h (14 days)');
    const before = await measure(1440, 900);
    const tipOf = (expr) => page.evaluate(`(() => { const el = ${expr}; el.focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()`);
    const health = await tipOf("document.getElementById('health')");
    await press('Escape');
    assert.match(health, /^Healthy: the audit log is verified, and the factory checked in 1[23]m ago\.$/);
    await page.evaluate("document.getElementById('details').open = true; document.getElementById('live-fold').open = true");
    const live = await page.evaluate("document.getElementById('live').innerText");
    const polled = await tipOf("document.querySelector('#live .stat')");
    const next = await tipOf("document.querySelectorAll('#live .stat')[1]");
    await press('Escape');
    await page.evaluate("document.getElementById('live-fold').open = false; document.getElementById('details').open = false");
    for (const line of [`Observed: ${hbLine}`, `Observed: ${vfLine}`, `Check-in: green up to 8 h, amber after 8 h, red after 12 h. ${CADENCE_NOTE}.`,
      'Healthy: fresh data, verified chain, heartbeat within 8 h, verifier anchor within 8 h.']) {
      assert.ok(live.split('\n').includes(line), `Details, Liveness shows "${line}":\n${live}`);
    }
    assert.match(polled, /^The factory's last check-in, 1[23]m ago\. Amber after 8 h without one, red after 12 h\.$/);
    assert.equal(next, 'Expected at the next hourly run. GitHub often runs these hours late.');
    // Closed Details: the visible words above the fold don't change.
    const after = await measure(1440, 900);
    assert.deepEqual([after.aboveFoldWords, after.totalWords], [before.aboveFoldWords, before.totalWords]);
  });

  test('the word rules: separators split sentences, icons are not words, closed details and hidden tips are skipped', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => {
      const el = (tag, attrs, ...kids) => {
        const e = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
        e.append(...kids);
        return e;
      };
      const box = el('div', { id: 'glance-probe' },
        el('p', {}, 'one two · three four | five'),
        el('p', {}, 'six seven. eight'),
        el('p', {}, '🟢 ✓ — ⓘ'),
        el('details', {}, el('summary', {}, 'Shown summary'), el('p', {}, 'hidden detail words here')),
        el('span', { hidden: '' }, 'hidden tip text'),
        el('span', { class: 'sr-only' }, 'screen reader only'));
      document.querySelector('main').prepend(box);
      try {
        const m = (${measureGlance.toString()})({ foldY: 100000, maxSentenceWords: 1 });
        const mine = (list) => list.filter((g) => g.where.includes('glance-probe'));
        return { words: mine(m.allByPlace).map((g) => g.text).join(' '), multi: mine(m.longSentences).map((s) => s.text) };
      } finally {
        box.remove();
      }
    })()`);
    assert.deepEqual(r.words.split(' ').sort(), ['Shown', 'eight', 'five', 'four', 'one', 'seven.', 'six', 'summary', 'three', 'two'].sort());
    assert.deepEqual(r.multi.sort(), ['Shown summary', 'one two', 'six seven.', 'three four'].sort());
  });

  test('no visible button or link text starts with "Open" (GitHub links say "View …")', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const found = await page.evaluate(`(() => {
      const opened = [...document.querySelectorAll('details:not([open])')];
      opened.forEach((d) => { d.open = true; });
      const out = [];
      for (const el of document.querySelectorAll('a, button, summary, [role="button"]')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
        for (const text of [el.innerText, el.getAttribute('aria-label')]) {
          if (text && /^\\s*open\\b/i.test(text)) out.push(text.trim());
        }
      }
      opened.forEach((d) => { d.open = false; });
      const outbound = [...document.querySelectorAll('#needs-part a')].map((a) => [a.innerText.trim(), a.getAttribute('href')]);
      return { out, outbound };
    })()`);
    assert.deepEqual(found.out, []);
    assert.deepEqual(found.outbound, [
      ['#45', 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/45'],
      ['#46', 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/46'],
    ], 'what needs you links to its issue');
  });

  test('cursors: nothing uses the "help" cursor; tooltip-only elements use the default, clickable ones the pointer', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => {
      const help = [], tipPointer = [], clickNoPointer = [];
      const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
      const clickable = (el) => el.matches('a[href], button, summary, [role="button"]');
      for (const el of document.querySelectorAll('*')) {
        const c = getComputedStyle(el).cursor;
        if (c === 'help') help.push(name(el));
        if (el.classList.contains('has-tip') && !clickable(el) && !el.closest('a[href], button, summary') && c !== 'default' && c !== 'auto') tipPointer.push(name(el) + ':' + c);
        if (clickable(el) && !el.disabled && el.getBoundingClientRect().width && c !== 'pointer') clickNoPointer.push(name(el) + ':' + c);
      }
      return { help, tipPointer, clickNoPointer };
    })()`);
    assert.deepEqual(r.help, [], 'no element may use cursor: help');
    assert.deepEqual(r.tipPointer, [], 'tooltip-only elements use the default cursor');
    assert.deepEqual(r.clickNoPointer, [], 'clickable elements use the pointer cursor');
  });

  for (const fx of FIXTURES) {
    test(`${fx.name}: layout at 1440x900: the status pill and the five KPI cards above the fold, then the tasks, then Details`, async () => {
      await open(fx.param);
      await page.setViewport(1440, 900);
      const L = await page.call(measureLayout);
      const detail = JSON.stringify(L);
      assert.equal(L.items.length, 5, detail);
      assert.equal(new Set(L.items.map((it) => it.top)).size, 1, `five KPI cards in one row: ${detail}`);
      assert.ok(Math.max(...L.items.map((it) => it.width)) - Math.min(...L.items.map((it) => it.width)) <= 1, `equal cards: ${detail}`);
      assert.ok(L.status.bottom <= L.score.top, detail);
      for (const it of L.items) assert.ok(it.bottom <= BUDGETS.foldY, `every scoreboard sentence is above the fold: ${detail}`);
      assert.ok(L.board.top > L.score.bottom && L.details.top > L.board.bottom, `scoreboard, board, Details, top to bottom: ${detail}`);
      assert.ok(L.tiles > 0, detail);
      assert.equal(await page.evaluate("[...document.querySelectorAll('main details')].filter((d) => d.open).length"), 0, 'Details starts closed');
      assert.equal(await page.evaluate("document.querySelectorAll('main > section > details').length"), 1, 'one Details fold holds the rest');
    });

    test(`${fx.name}: no raw ISO time is visible; times are relative`, async () => {
      await open(fx.param);
      await page.setViewport(1440, 900);
      const text = await page.evaluate("document.body.innerText");
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b\d{2}:\d{2}(:\d{2})?Z\b/);
      // No jargon on the visible page.
      assert.doesNotMatch(text, /\bAIC\b|auto-strict|escaped defect|dispatch|heartbeat/i);
      assert.match(text, /\d+[smhd] ago|just now/);
    });

    test(`${fx.name}: sample mode makes no request to GitHub`, async () => {
      await open(fx.param);
      const urls = await page.evaluate("performance.getEntriesByType('resource').map((e) => e.name)");
      assert.deepEqual(urls.filter((u) => /github/.test(u)), []);
      assert.ok(urls.some((u) => /fixtures\/(sample|quiet)-meta\.json/.test(u)), 'the meta stand-in is read');
    });
  }

  test('sample: the task board shows each state with its own icon, links to the issue, and has a tooltip', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => [...document.querySelectorAll('#board .tile')].map((t) => ({
      label: t.getAttribute('aria-label'), icon: t.querySelector('use').getAttribute('href'), href: t.getAttribute('href'),
      color: getComputedStyle(t.querySelector('.tile-i')).color, tip: document.getElementById(t.getAttribute('aria-describedby'))?.textContent ?? '' })))()`);
    assert.deepEqual(r.map((t) => [t.label, t.icon]), [
      ['iso-date: waiting', '#i-wait'], ['ordinal: done', '#i-ok'], ['weekday-parser: done', '#i-ok'], ['casual-date: running', '#i-play'],
      ['time-expression: needs you', '#i-warn'], ['month-parser: running', '#i-play'], ['range: waiting', '#i-wait'], ['relative: needs you', '#i-warn'],
    ]);
    // Each state has its own colour as well as its own icon.
    const colorOf = (label) => r.find((t) => t.label === label).color;
    assert.equal(new Set(['iso-date: waiting', 'ordinal: done', 'casual-date: running', 'time-expression: needs you'].map(colorOf)).size, 4);
    assert.equal(r.find((t) => t.label === 'ordinal: done').href, 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/41');
    const tipOfTile = (label) => r.find((t) => t.label === label).tip;
    assert.match(tipOfTile('ordinal: done'), /^en\/ordinal: done \d+[mhd] ago\. Routine task; select to view issue #41\.$/);
    assert.equal(tipOfTile('casual-date: running'), 'en/casual-date: running, implement agent running. Routine task; select to view issue #44.');
    assert.equal(tipOfTile('range: waiting'), 'en/range: waiting on month-parser. Routine task; select to view its contract.');
    assert.equal(tipOfTile('time-expression: needs you'), 'en/time-expression: needs you: the same failure repeated. Routine task; select to view issue #45.');
    // No issue in the events: the tile links to the task's contract instead.
    assert.equal(r.find((t) => t.label === 'range: waiting').href, 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/blob/main/contracts/en/range.yaml');
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#board .group-h')].map((g) => g.textContent)"), ['Common parsers', 'Numeric', 'Casual', 'Months', 'Relative']);
    assert.equal(await page.evaluate("document.getElementById('board-legend').innerText.replace(/\\s+/g, ' ').trim()"), '2 done 2 running 2 needs you 2 waiting');
    // The owner asked for what a task is, on the page: a caption under the heading, and the info tooltip.
    const def = await page.evaluate(`(() => { const c = document.getElementById('board-caption'); const r = c.getBoundingClientRect();
      return { text: c.innerText.trim(), shown: r.height > 0, below: r.top >= document.getElementById('board-h').getBoundingClientRect().bottom && r.bottom <= document.getElementById('board').getBoundingClientRect().top,
        tip: document.getElementById('board-info-tip').textContent }; })()`);
    assert.deepEqual(def, { text: 'Task = one chrono-node parser or refiner, in Rust. One contract, one issue, one PR.', shown: true, below: true,
      tip: "One task = one chrono-node parser or refiner in Rust; drills and infrastructure PRs aren't tasks. Select a chip to view its issue; icons show state." });
    // Progress: the overall bar (2 of 8 done), then each area's count and thin bar, in board order.
    const prog = await page.evaluate(`(() => { const bar = document.querySelector('#board-progress [role="progressbar"]'); const fill = (b) => Math.round(100 * b.querySelector('.bar-fill').getBoundingClientRect().width / b.getBoundingClientRect().width);
      return { text: document.getElementById('board-progress').innerText.replace(/\\s+/g, ' ').trim(), now: bar.getAttribute('aria-valuenow'), max: bar.getAttribute('aria-valuemax'), label: bar.getAttribute('aria-label'), fill: fill(bar),
        groups: [...document.querySelectorAll('#board .group')].map((g) => [g.querySelector('.group-h').textContent, g.querySelector('.group-count').textContent, fill(g.querySelector('.bar'))]) }; })()`);
    assert.deepEqual(prog, { text: '2 of 8 done', now: '2', max: '8', label: 'Tasks done', fill: 25,
      groups: [['Common parsers', '0/1', 0], ['Numeric', '1/1', 100], ['Casual', '1/3', 33], ['Months', '0/2', 0], ['Relative', '0/1', 0]] });
    // Chips are quiet: no full-width bars; a done chip is neutral, the others take their soft tone.
    const chips = await page.evaluate(`(() => { const t = [...document.querySelectorAll('#board .tile')]; const probe = (v) => { const e = document.createElement('i'); e.style.backgroundColor = v; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; };
      return { maxShare: Math.max(...t.map((x) => x.getBoundingClientRect().width / x.closest('.group').getBoundingClientRect().width)),
        bg: Object.fromEntries(['done', 'running', 'needs', 'waiting'].map((st) => [st, getComputedStyle(document.querySelector('#board .tile--' + st)).backgroundColor === probe(st === 'done' ? 'var(--panel)' : 'var(--' + (st === 'running' ? 'info' : st === 'needs' ? 'needs' : 'warn') + '-bg)')])) }; })()`);
    assert.ok(chips.maxShare < 0.9, `chips are not full-width bars: ${JSON.stringify(chips)}`);
    assert.deepEqual(chips.bg, { done: true, running: true, needs: true, waiting: true });
    // Keyboard: a tile takes focus and shows its tooltip.
    const tip = await page.evaluate("(() => { document.querySelector('#board .tile').focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()");
    assert.equal(tip, 'common/iso-date: ready, waiting for a free slot. Core task; select to view issue #47.');
    await press('Escape');
  });

  test('sample: the status line, the five sentences and the human-steps list', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => {
      const flat = (el) => el?.innerText.replace(/\\s+/g, ' ').trim() ?? null;
      return {
        status: flat(document.querySelector('.glance')),
        score: [...document.querySelectorAll('#score .score-item')].map((li) => [...li.querySelectorAll('p')].map(flat).join(' / ')),
        running: [...document.querySelectorAll('#state-part a')].map((a) => a.getAttribute('href')),
        stepsLink: document.querySelector('.score--hands a').getAttribute('href'),
      };
    })()`);
    assert.equal(r.status, 'Healthy · working on 2 tasks: casual-date, month-parser · 2 tasks need you: #45, #46 · Sample');
    assert.deepEqual(r.running, ['https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/44', 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/43']);
    assert.deepEqual(r.score, [
      'Shipped / 2/8 tasks / 2 routine · 0 core / gh-aw: 2 accepted · 0 rejected · 1 pending',
      'Speed / 77 min / per task · Oct 15 → 16',
      'Total cost / $1,121 / $1,110 build + $10.97 run / $5.49 per accepted PR',
      'Hands-off / 1/2 / PRs with no human edits / 1 manual step',
      'Quality / 0 reverts / 0 changes blocked · 2 drills passed',
    ]);
    // The link opens Details at the list of steps.
    assert.equal(r.stepsLink, '#human-steps');
    await page.evaluate("document.querySelector('.score--hands a').click()");
    await page.waitFor("document.getElementById('details').open && document.getElementById('human-fold').open", { what: 'Details to open at the steps' });
    assert.equal(await page.evaluate('document.activeElement.id'), 'human-steps', 'focus moves to the list');
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#human-steps li')].map((li) => li.innerText.replace(/\\s+/g, ' ').replace(/ \\d+[mhd] ago$/, '').trim())"),
      ['#6 ordinal · put an agent PR in the merge queue']);
    await page.evaluate("document.getElementById('human-fold').open = false; document.getElementById('details').open = false");
    // Details › Outcomes (gh-aw): the per-status table, freshness, the cost note and how to reproduce.
    const o = await page.evaluate(`(() => {
      document.getElementById('details').open = true; document.getElementById('outcomes-fold').open = true; document.getElementById('about-fold').open = true;
      const el = document.getElementById('outcomes');
      const out = { about: document.getElementById('about').innerText.replace(/\\s+/g, ' '), runs: el.querySelectorAll('#outcome-runs li').length, text: el.innerText.replace(/\\s+/g, ' '), rows: [...el.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((c) => c.innerText.trim())) };
      document.getElementById('outcomes-fold').open = false; document.getElementById('about-fold').open = false; document.getElementById('details').open = false;
      return out;
    })()`);
    assert.deepEqual(o.rows.slice(0, 3), [['accepted', '2', '0', '2', '0'], ['rejected', '0', '1', '0', '1'], ['pending', '1', '0', '3', '0']]);
    assert.match(o.text, /Last evaluated \d+[smhd] ago\. gh-aw v0\.92\.0, 7 runs\./);
    assert.match(o.text, /gh-aw's own credit figure excludes the threat-detection job; this page uses the full cost\./);
    // `gh aw outcomes` takes an agent run id (the newest real coder run with a PR).
    assert.match(o.text, /Reproduce for one agent run: gh aw outcomes 4102, or any run id below\. 1 malformed entry skipped\./);
    assert.match(o.text, /over the 4 of 4 measured real runs that have both figures/);
    assert.equal(o.runs, 7);
    // Repairs are ours (Outcomes can't see them): plain sentences in Details, drills apart.
    // What a task is, in Details: one parser or refiner, one contract, issue and PR; drills and infrastructure PRs aren't tasks.
    assert.match(o.about, /What's a task A task is one upstream chrono-node step, a parser or a refiner, ported to one Rust file\. Each has one contract \(contracts\/<id>\.yaml\), one GitHub issue labelled factory:task and normally one agent PR; there are 8: 7 routine \(English\) and 1 core \(shared\)\. Safety drills and plain infrastructure PRs are not tasks\./);
    assert.match(o.about, /Repairs 1 repair: 0 fixed the PR, 1 still running\. Safety drills: No repairs\./);
    // The sample reads its own outcomes.json, same-origin; no Actions API request at all.
    const urls = await page.evaluate("performance.getEntriesByType('resource').map((e) => e.name)");
    assert.deepEqual(urls.filter((u) => /\/actions\//.test(u)), []);
    assert.ok(urls.some((u) => /test\/fixtures\/outcomes\.json$/.test(u)));
  });

  test('tooltips are reachable by Tab, show on focus and hide on Escape', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    // Start the tab sequence at the top of the page (earlier tests leave focus further down).
    await page.evaluate("document.querySelector('a.skip').focus(); document.activeElement.blur(); window.scrollTo(0, 0); document.getElementById('tip').hidden = true");
    let focused = '';
    for (let i = 0; i < 12 && focused !== 'health'; i++) {
      await press('Tab');
      focused = await page.evaluate('document.activeElement?.id ?? ""');
    }
    assert.equal(focused, 'health', 'the health chip is in the tab order');
    const shown = await page.evaluate("(() => { const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()");
    assert.match(shown ?? '', /Healthy:/, 'the health rule shows on focus');
    assert.equal(await page.evaluate("document.getElementById('health').getAttribute('aria-describedby')"), 'health-tip');
    await press('Escape');
    assert.equal(await page.evaluate("document.getElementById('tip').hidden"), true);
    // A scoreboard sentence is focusable and its tooltip has the definitions.
    const tileTip = await page.evaluate("(() => { const k = document.querySelector('#score .score-item'); k.focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()");
    assert.equal(tileTip, 'Task = one chrono-node parser or refiner in Rust; done when its issue closes as completed. gh-aw Outcomes judges each agent PR; real work only.');
    // The hands-off sentence: gh-aw's zero-touch, in the owner's words.
    const handsTip = await page.evaluate("(() => { document.querySelector('.score--hands').focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()");
    assert.equal(handsTip, 'gh-aw counts a PR as zero-touch if no person edited it. Manual steps outside the PR are counted separately below.');
  });

  test('"View all" expands the checks with Enter and collapses with Space, keeping focus', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    await page.evaluate("document.getElementById('details').open = true; document.getElementById('checks-fold').open = true");
    const state = () => page.evaluate(`(() => {
      const b = document.querySelector('#checks button.more');
      return { expanded: b?.getAttribute('aria-expanded'), text: b?.innerText.trim(), rows: document.querySelectorAll('#checks li').length,
        focused: document.activeElement === b };
    })()`);
    await page.evaluate("document.querySelector('#checks button.more').focus()");
    assert.deepEqual(await state(), { expanded: 'false', text: 'View all', rows: 5, focused: true });
    await press('Enter');
    assert.deepEqual(await state(), { expanded: 'true', text: 'Fewer', rows: 8, focused: true });
    await press(' ');
    assert.deepEqual(await state(), { expanded: 'false', text: 'View all', rows: 5, focused: true });
    await page.evaluate("document.getElementById('checks-fold').open = false; document.getElementById('details').open = false");
  });

  test('focus returns to the same element after new data re-renders its section', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const key = await page.evaluate(`(() => {
      const a = document.querySelectorAll('#score a')[1];
      a.focus();
      window.__glanceOld = a;
      document.getElementById('refresh').click(); // in sample mode this reloads the data
      return a.getAttribute('data-focus-key');
    })()`);
    assert.ok(key, 'the focused link has a focus key');
    await page.waitFor('document.activeElement !== window.__glanceOld && document.activeElement?.closest("#score") != null', { timeoutMs: 10000, what: 'the re-render' });
    assert.equal(await page.evaluate('document.activeElement.getAttribute("data-focus-key")'), key);
    assert.equal(await page.evaluate('window.__glanceOld.isConnected'), false, 'the section really was rebuilt');
  });

  test('before the data arrives nothing is red or amber: "… Loading" is neutral', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    // Hold the sample data so the page stays in its first, not-loaded-yet render.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*test/fixtures/sample.jsonl*' }] });
    let requestId = null;
    try {
      const paused = page.once('Fetch.requestPaused', 30000);
      await page.navigate(`${server.url}index.html?fixture=1`);
      ({ requestId } = await paused);
      await page.waitFor("document.querySelectorAll('#score .score-item').length > 0", { what: 'the first render' });
      const seen = await page.evaluate(`(() => {
        const probe = (v) => { const e = document.createElement('i'); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
        const bad = new Set([probe('var(--alert)'), probe('var(--warn)')]);
        const badBg = new Set([probe('var(--alert-bg)'), probe('var(--warn-bg)')]);
        const out = [];
        for (const el of document.body.querySelectorAll('*')) {
          if (el.closest('#tip, .sprite, details:not([open]) > :not(summary)')) continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (!r.width || !r.height || cs.visibility === 'hidden') continue;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim()) || el.matches('svg.i');
          if ((own && bad.has(cs.color)) || badBg.has(cs.backgroundColor)) out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + [...el.classList].join('.') + ' ' + (el.textContent || '').trim().slice(0, 30));
        }
        return {
          health: document.getElementById('health').innerText.trim(),
          score: document.getElementById('score').innerText.trim(),
          parts: ['state-part', 'needs-part'].map((id) => document.getElementById(id).hidden),
          tiles: document.querySelectorAll('#board .tile').length,
          ready: document.documentElement.dataset.ready ?? null,
          out,
        };
      })()`);
      assert.equal(seen.ready, null, 'still loading');
      assert.equal(seen.health, '… Loading');
      assert.equal(seen.score, '…');
      assert.deepEqual(seen.parts, [true, true], 'no state before the data arrives');
      assert.equal(seen.tiles, 0, 'no task states before the data arrives');
      assert.deepEqual(seen.out, [], 'no alert- or warning-coloured elements while loading');
    } finally {
      if (requestId) await page.send('Fetch.continueRequest', { requestId });
      await page.send('Fetch.disable');
    }
    await page.waitFor(READY_EXPR, { timeoutMs: 30000, what: 'the data to load after the pause' });
    loaded = '1';
    assert.equal(await page.evaluate("document.getElementById('health').innerText.trim()"), 'Healthy');
  });

  test('an unreadable build cost or drill record drops only that part, and the hover says why', async () => {
    const bad = JSON.parse(readFileSync(META_FIXTURE_PATH, 'utf8'));
    bad.buildCost = { ...bad.buildCost, usd: -5 };
    bad.drills = { ...bad.drills, extra: true };
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*test/fixtures/sample-meta.json*' }] });
    try {
      const paused = page.once('Fetch.requestPaused', 30000);
      await page.navigate(`${server.url}index.html?fixture=1`);
      const { requestId } = await paused;
      await page.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(bad)).toString('base64'),
      });
      await page.waitFor(READY_EXPR, { timeoutMs: 30000, what: 'the modified sample to render' });
    } finally {
      await page.send('Fetch.disable');
    }
    const r = await page.evaluate(`(() => {
      const item = (k) => document.querySelector('.score--' + k);
      const tipOf = (el) => document.getElementById(el.getAttribute('aria-describedby')).textContent;
      return { cost: [...item('cost').querySelectorAll('p')].map((p) => p.innerText.replace(/\\s+/g, ' ').trim()), costTip: tipOf(item('cost')),
        quality: [...item('quality').querySelectorAll('p')].map((p) => p.innerText.replace(/\\s+/g, ' ').trim()), qualityTip: tipOf(item('quality')) };
    })()`);
    assert.deepEqual(r.cost, ['Running cost', '$10.97', '$10.97 tasks', '$5.49 per accepted PR']);
    assert.match(r.costTip, /^Build cost unavailable: buildCost: usd is not a number ≥ 0\. Run: /);
    assert.deepEqual(r.quality, ['Quality', '0 reverts', '0 changes blocked']);
    assert.equal(r.qualityTip, 'Reverts and changes the reviewer blocked before merge count real work only. Drill record unavailable: drills: unexpected extra.');
    await open('1', { force: true });
  });

  test('both themes: the dark theme really changes the colours, and the task chips stay told apart', async () => {
    await open('1');
    const colours = async (scheme) => {
      await page.setColorScheme(scheme);
      return page.evaluate(`(() => ({ bg: getComputedStyle(document.body).backgroundColor,
        tiles: [...new Set([...document.querySelectorAll('#board .tile-i')].map((t) => getComputedStyle(t).color))].length }))()`);
    };
    const dark = await colours('dark');
    const light = await colours('light');
    assert.notEqual(dark.bg, light.bg);
    assert.equal(dark.bg, 'rgb(14, 17, 23)');
    assert.equal(light.bg, 'rgb(245, 246, 250)');
    assert.equal(dark.tiles, 4);
    assert.equal(light.tiles, 4);
  });

  test('both themes: text, muted text, accent links, state colours and the focus ring meet contrast; motion respects reduced-motion', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    for (const scheme of ['light', 'dark']) {
      await page.setColorScheme(scheme);
      const r = await page.evaluate(`(() => {
        const probe = (v) => { const e = document.createElement('i'); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
        const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (x, y) => { const [a, b] = [lum(rgb(probe(x))), lum(rgb(probe(y)))]; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
        const surfaces = ['var(--bg)', 'var(--panel)', 'var(--panel-2)', 'var(--accent-wash)'];
        const worst = (fg, bgs = surfaces) => Math.min(...bgs.map((b) => ratio(fg, b)));
        document.querySelector('a.skip').focus();
        return {
          fg: worst('var(--fg)'), muted: worst('var(--muted)'), accent: worst('var(--accent)'),
          tinted: Math.min(ratio('var(--ok)', 'var(--ok-bg)'), ratio('var(--warn)', 'var(--warn-bg)'), ratio('var(--alert)', 'var(--alert-bg)'), ratio('var(--needs)', 'var(--needs-bg)'),
            ratio('var(--info)', 'var(--info-bg)'), ratio('var(--accent)', 'var(--accent-bg)'), ratio('var(--muted)', 'var(--panel-2)')),
          // The status pill and the chips: text-colour text on every soft tint.
          onTint: worst('var(--fg)', ['var(--ok-bg)', 'var(--warn-bg)', 'var(--needs-bg)', 'var(--info-bg)', 'var(--accent-bg)']),
          // Icons (KPI icons on their tinted circles, chip state icons on the cards): 3:1 or more.
          icons: Math.min(ratio('var(--ok)', 'var(--panel)'), ratio('var(--info)', 'var(--panel)'), ratio('var(--needs)', 'var(--panel)'), ratio('var(--warn)', 'var(--panel)'), ratio('var(--accent)', 'var(--accent-bg)')),
          logo: ratio('var(--on-accent)', 'var(--accent)'),
        };
      })()`);
      await press('Tab');
      const ring = await page.evaluate(`(() => { const s = getComputedStyle(document.activeElement); const probe = (v) => { const e = document.createElement('i'); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), isAccent: s.outlineColor === probe('var(--accent)') }; })()`);
      const detail = `${scheme}: ${JSON.stringify({ ...r, ring })}`;
      assert.ok(r.fg >= 4.5 && r.muted >= 4.5 && r.accent >= 4.5 && r.tinted >= 4.5 && r.onTint >= 4.5, detail);
      assert.ok(r.icons >= 3, detail);
      assert.ok(r.logo >= 3, detail);
      assert.deepEqual([ring.style, ring.width >= 2, ring.isAccent], ['solid', true, true], detail);
    }
    await page.setColorScheme('light');
    const transition = () => page.evaluate("getComputedStyle(document.querySelector('#board .tile')).transitionDuration");
    assert.match(await transition(), /0\.15s/);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      assert.match(await transition(), /^0s(, 0s)*$/);
    } finally {
      await page.setColorScheme('light');
    }
  });

  test('status-line links keep keyboard focus when the page refreshes', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const key = await page.evaluate(`(() => {
      const a = document.querySelector('#state-part a');
      a.focus();
      window.__statusLink = a;
      return a.getAttribute('data-focus-key');
    })()`);
    assert.ok(key);
    // A clock refresh, then a data reload (sample mode): focus stays on the same link.
    await page.evaluate("document.getElementById('refresh').click()");
    await page.waitFor(READY_EXPR, { timeoutMs: 10000, what: 'the reload' });
    await new Promise((r) => setTimeout(r, 300));
    const after = await page.evaluate("({ same: document.activeElement === window.__statusLink, key: document.activeElement.getAttribute('data-focus-key'), inside: !!document.activeElement.closest('#state-part') })");
    assert.ok(after.inside, 'focus is still in the status line');
    assert.equal(after.key, key);
  });

  // Every tooltip: at most 2 sentences and 25 words, no lists. Measured on both samples with
  // Details and all its sections open, so every tooltip source is rendered.
  for (const fx of FIXTURES) {
    test(`${fx.name}: every tooltip is at most 2 short sentences (25 words)`, async () => {
      await open(fx.param);
      const found = await page.evaluate(`(() => {
        const folds = [...document.querySelectorAll('main details')];
        folds.forEach((d) => { d.open = true; });
        const out = [];
        const text = (el) => el.dataset.tip || (el.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        for (const el of document.querySelectorAll('[aria-describedby], [data-tip], [title]')) {
          for (const t of [text(el), el.getAttribute('title') ?? ''].filter(Boolean)) {
            const words = t.split(/\\s+/).filter((w) => /[\\p{L}\\p{N}]/u.test(w)).length;
            const sentences = t.split(/(?<=[.!?])\\s+|\\n+/).filter((x) => /[\\p{L}\\p{N}]/u.test(x)).length;
            out.push({ where: el.id || el.className || el.tagName, words, sentences, t });
          }
        }
        folds.forEach((d) => { d.open = false; });
        return out;
      })()`);
      assert.ok(found.length > 30, `found ${found.length} tooltips`);
      const bad = found.filter((x) => x.words > 25 || x.sentences > 2);
      assert.deepEqual(bad, [], bad.map((x) => `${x.words} words, ${x.sentences} sentences: ${x.t}`).join('\n'));
    });
  }

  test('the tooltip is readable: 14 px+, line-height 1.5+, 12 px padding, ~320 px wide, contrast 4.5:1+ in both themes', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    for (const scheme of ['light', 'dark']) {
      await page.setColorScheme(scheme);
      const s = await page.evaluate(`(() => {
        document.activeElement?.blur();
        document.querySelector('.score--cost').focus();
        const t = document.getElementById('tip');
        const cs = getComputedStyle(t);
        const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const [a, b] = [lum(rgb(cs.color)), lum(rgb(cs.backgroundColor))];
        return { shown: !t.hidden, font: parseFloat(cs.fontSize), lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
          pad: Math.min(...['Top', 'Right', 'Bottom', 'Left'].map((k) => parseFloat(cs['padding' + k]))), maxWidth: parseFloat(cs.maxWidth),
          contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      })()`);
      const detail = `${scheme}: ${JSON.stringify(s)}`;
      assert.ok(s.shown, detail);
      assert.ok(s.font >= 14, detail);
      assert.ok(s.lh >= 1.5, detail);
      assert.ok(s.pad >= 12, detail);
      assert.ok(s.maxWidth <= 340, detail);
      assert.ok(s.contrast >= 4.5, detail);
      await press('Escape');
    }
    await page.setColorScheme('light');
  });

  test('the console stays clean', () => {
    const noisy = page.console.filter((c) => !['debug', 'verbose'].includes(c.level));
    assert.deepEqual(noisy, []);
  });
});
