// The 5-second glance test: word budgets, the one-screen layout and keyboard behaviour measured
// on the rendered sample pages in headless Chrome. The budgets are checked on both fixtures:
// ?fixture=1 (a busy factory: two tasks running, two need the owner, two waiting, two done) and
// ?fixture=quiet (the quiet state: nothing needs the owner, factory off, dry run, all three
// tasks done, the verifier OK, ten merged owner PRs). No npm dependencies: see
// headless.mjs. Word, fold and sentence rules are defined on measureGlance() in
// glance-measure.mjs. Chrome is found via CHROME_PATH, common Linux names or the macOS
// app; without it the test is skipped locally and fails in CI (process.env.CI).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, serveDir } from './headless.mjs';
import { CADENCE_NOTE, anchorTimes, cadenceText, heartbeatTimes, observedCadence, parseAnchors, parseJsonl } from '../lib.js';
import { FIXTURE_PATH, QUIET_ANCHORS_FIXTURE_PATH, QUIET_FIXTURE_NOW, QUIET_FIXTURE_PATH } from './make-fixture.mjs';
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

  test('quiet: the quiet state reads at a glance, and nothing needs you is a green ✓ 0', async () => {
    await open('quiet');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => {
      const text = (id) => document.getElementById(id)?.innerText.trim() ?? null;
      const panel = document.getElementById('needs-panel');
      const ok = panel.querySelector('.needs-ok');
      const stat = (id) => [...document.querySelectorAll('#' + id + ' .stat')].map((p) => p.innerText.replace(/\\s+/g, ' ').trim());
      return {
        chips: ['health', 'kill-chip', 'state-chip', 'dry-badge'].map(text),
        said: (document.body.innerText.match(/Nothing needs you/g) || []).length,
        panel: { heading: document.getElementById('needs-h').textContent.trim(), body: text('needs'), clear: panel.classList.contains('needs--clear'),
          okLabel: ok?.getAttribute('role') === 'img' ? ok.getAttribute('aria-label') : null, tip: !!document.querySelector('#needs .has-tip'),
          // The ✓ and the 0 are both the "ok" colour, never the amber of a waiting count.
          green: (() => { const probe = document.createElement('i'); probe.style.color = 'var(--ok)'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove();
            return [ok, panel.querySelector('.needs-n')].every((e) => e && getComputedStyle(e).color === c); })() },
        numbers: [...document.querySelectorAll('#numbers .ntile')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()),
        tiles: [...document.querySelectorAll('#board .tile')].map((t) => [t.getAttribute('aria-label'), t.querySelector('use').getAttribute('href')]),
        groups: [...document.querySelectorAll('#board .group-h')].map((g) => g.textContent.trim()),
        legend: text('board-legend'),
        live: stat('live'),
        cost: stat('cost'),
      };
    })()`);
    assert.deepEqual(r.chips, ['Healthy', 'Factory off', 'Idle: all 3 tasks done', 'Dry run']);
    assert.equal(r.said, 0, 'the ✓ says "Nothing needs you" to screen readers; no visible sentence repeats it');
    assert.deepEqual(r.panel, { heading: 'Needs you', body: '0', clear: true, okLabel: 'Nothing needs you', tip: true, green: true });
    assert.deepEqual(r.numbers, ['Tasks done 3/3 auto 2 · auto-strict 1', 'Issue → merged 14m median, 14 days', 'Cost per task — median']);
    assert.deepEqual(r.tiles, [
      ['casual-time-parser: done', '#i-ok'], ['month-name-parser: done', '#i-ok'], ['iso-format-parser: done', '#i-ok'],
    ]);
    assert.deepEqual(r.groups, ['Casual', 'Month names', 'Common parsers']);
    assert.equal(r.legend, '', 'one state only: the "Tasks done" number says it');
    // The clock is pinned 12 min after the last event (a heartbeat) and then runs on.
    assert.match(r.live[0], /^Polled 1[23]m ago$/);
    assert.match(r.live[1], /^Next ~in 4[78]m$/, 'nothing in flight: the next hourly run');
    // Dry run: no real spend snapshot, so no measured runs. The window reaches the log's start.
    assert.deepEqual(r.cost, ['$0.00 today, cap $100', '— to date']);
  });

  test('quiet: the liveness and health tooltips show the observed cadence and the limits', async () => {
    await open('quiet');
    await page.setViewport(1440, 900);
    const events = parseJsonl(readFileSync(QUIET_FIXTURE_PATH, 'utf8'), 'quiet.jsonl').map((rec) => rec.event);
    const { anchors } = parseAnchors(readFileSync(QUIET_ANCHORS_FIXTURE_PATH, 'utf8'));
    const hbLine = cadenceText('Heartbeats', observedCadence(heartbeatTimes(events)), 14);
    const vfLine = cadenceText('Verifications', observedCadence(anchorTimes(anchors, { now: Date.parse(QUIET_FIXTURE_NOW), days: 14 })), 14);
    assert.equal(hbLine, 'Heartbeats: median every 2.4 h, longest gap 7.6 h (14 days)');
    assert.equal(vfLine, 'Verifications: median every 2.9 h, longest gap 5.1 h (14 days)');
    const before = await measure(1440, 900);
    const tipOf = (expr) => page.evaluate(`(() => { const el = ${expr}; el.focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()`);
    const polled = await tipOf("document.querySelector('#live .stat')");
    const next = await tipOf("document.querySelectorAll('#live .stat')[1]");
    const health = await tipOf("document.getElementById('health')");
    await press('Escape');
    for (const [tip, lines] of [
      [polled, [hbLine, 'Heartbeat: green up to 8 h, amber after 8 h, red after 12 h', CADENCE_NOTE]],
      [next, ["GitHub's cron often runs scheduled jobs hours late on Free plans.", hbLine]],
      [health, [`Observed: ${hbLine}`, `Observed: ${vfLine}`, CADENCE_NOTE]],
    ]) {
      const got = (tip ?? '').split('\n');
      for (const line of lines) assert.ok(got.includes(line), `tooltip has "${line}":\n${tip}`);
    }
    assert.match(health, /^Healthy: fresh data, verified chain, heartbeat within 8 h, verifier anchor within 8 h\.$/m);
    assert.match(health, /heartbeat missing or over 12 h, verifier over 26 h or unreadable\.$/m);
    // Tooltips only: the visible words don't change.
    const after = await measure(1440, 900);
    assert.deepEqual([after.aboveFoldWords, after.totalWords], [before.aboveFoldWords, before.totalWords]);
    assert.ok(!(await page.evaluate("document.body.innerText")).includes('median every'), 'the cadence is not visible text');
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
      const outbound = [...document.querySelectorAll('#needs a.btn')].map((a) => a.innerText.trim());
      return { out, outbound };
    })()`);
    assert.deepEqual(found.out, []);
    assert.ok(found.outbound.length > 0, 'the sample Needs-you items have outbound buttons');
    for (const label of found.outbound) assert.match(label, /^View (PR|issue)$/);
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
    test(`${fx.name}: layout at 1440x900: one screen, the numbers in a row and every panel above the fold`, async () => {
      await open(fx.param);
      await page.setViewport(1440, 900);
      const L = await page.call(measureLayout);
      const detail = JSON.stringify(L);
      assert.equal(L.numbers.length, 4, `three numbers and Needs you: ${detail}`);
      assert.equal(new Set(L.numbers.map((n) => n.top)).size, 1, `the numbers share a row: ${detail}`);
      assert.ok(L.board && L.board.bottom <= BUDGETS.foldY, `the task board ends above the fold: ${detail}`);
      assert.ok(L.tiles > 0, `the board has tiles: ${detail}`);
      assert.equal(L.minis.length, 5, detail);
      assert.equal(new Set(L.minis.map((p) => p.top)).size, 1, `the small panels share a row: ${detail}`);
      for (const p of L.minis) assert.ok(p.bottom <= BUDGETS.foldY, `${p.id} ends above the fold: ${detail}`);
      assert.ok(L.minis[0].top > L.board.bottom && L.board.top > L.numbers[0].bottom, `numbers, board, panels, top to bottom: ${detail}`);
      assert.equal(L.folds.length, 4, `four folded sections: ${detail}`);
      assert.ok(L.folds.every((f) => f.top > L.minis[0].bottom), detail);
      assert.equal(await page.evaluate("[...document.querySelectorAll('main details')].filter((d) => d.open).length"), 0, 'the details start closed');
    });

    test(`${fx.name}: no raw ISO time is visible; times are relative`, async () => {
      await open(fx.param);
      await page.setViewport(1440, 900);
      const text = await page.evaluate("document.body.innerText");
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b\d{2}:\d{2}(:\d{2})?Z\b/);
      assert.match(text, /\d+[mhd] ago|just now/);
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
      color: getComputedStyle(t).borderLeftColor, tip: document.getElementById(t.getAttribute('aria-describedby'))?.textContent ?? '' })))()`);
    assert.deepEqual(r.map((t) => [t.label, t.icon]), [
      ['iso-date: waiting', '#i-wait'], ['ordinal: done', '#i-ok'], ['weekday-parser: done', '#i-ok'], ['casual-date: running', '#i-play'],
      ['time-expression: needs you', '#i-warn'], ['month-parser: running', '#i-play'], ['range: waiting', '#i-wait'], ['relative: needs you', '#i-warn'],
    ]);
    // Each state has its own colour as well as its own icon.
    const colorOf = (label) => r.find((t) => t.label === label).color;
    assert.equal(new Set(['iso-date: waiting', 'ordinal: done', 'casual-date: running', 'time-expression: needs you'].map(colorOf)).size, 4);
    assert.equal(r.find((t) => t.label === 'ordinal: done').href, 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/41');
    assert.match(r.find((t) => t.label === 'ordinal: done').tip, /^State: done \(issue closed as completed\)$/m);
    assert.match(r.find((t) => t.label === 'casual-date: running').tip, /^Issue: open$/m);
    assert.match(r.find((t) => t.label === 'range: waiting').tip, /^No task issue found$/m);
    const range = r.find((t) => t.label === 'range: waiting');
    assert.match(range.tip, /^en\/range · Port Range$/m);
    assert.match(range.tip, /^Tier: auto$/m);
    assert.match(range.tip, /^State: waiting \(waiting on month-parser\)$/m);
    assert.match(r.find((t) => t.label === 'month-parser: running').tip, /^Since \d+[mhd] ago \(2026-10-16T10:00:00Z\)$/m);
    // No issue in the events: the tile links to the task's contract instead.
    assert.equal(r.find((t) => t.label === 'range: waiting').href, 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/blob/main/contracts/en/range.yaml');
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#board .group-h')].map((g) => g.textContent)"), ['Common parsers', 'Numeric dates', 'Casual', 'Month names', 'Relative']);
    assert.equal(await page.evaluate("document.getElementById('state-chip').innerText.trim()"), 'Running: 2 tasks');
    assert.equal(await page.evaluate("document.getElementById('board-legend').innerText.replace(/\\s+/g, ' ').trim()"), '2 done 2 running 2 needs you 2 waiting');
    // Keyboard: a tile takes focus and shows its tooltip.
    const tip = await page.evaluate("(() => { document.querySelector('#board .tile').focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()");
    assert.match(tip ?? '', /^common\/iso-date · Port IsoDate$/m);
    await press('Escape');
  });

  test('sample: the key numbers and small panels show their numbers', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => {
      const stat = (id) => [...document.querySelectorAll('#' + id + ' .stat')].map((p) => p.innerText.replace(/\\s+/g, ' ').trim());
      return {
        numbers: [...document.querySelectorAll('#numbers .ntile')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()),
        needs: document.querySelector('#needs .needs-n').innerText.trim(),
        cost: stat('cost'), quality: stat('quality'), human: stat('human'), live: stat('live'),
        recent: [...document.querySelectorAll('#recent li')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim()),
      };
    })()`);
    assert.deepEqual(r.numbers, ['Tasks done 2/8 auto 2 · auto-strict 0', 'Issue → merged 1h 16m median, 14 days', 'Cost per task $3.44 median']);
    assert.equal(r.needs, '2');
    assert.deepEqual(r.cost, ['$26.17 today, cap $100', '$10.97 to date']);
    assert.deepEqual(r.quality, ['0 reverts', '1 escaped defect', '0 reviewer objections', 'Repairs worked: —']);
    assert.deepEqual(r.human, ['5 actions, 7 days', '— to unblock']);
    assert.match(r.live[0], /^Polled 1[12]m ago$/);
    // Two tasks running, but the follow-up poll due 10 min after the last one hasn't come: the next hourly run.
    assert.match(r.live[1], /^Next ~in 4[78]m$/);
    // One line per task or PR (its latest event): #9 shows once.
    assert.deepEqual(r.recent.map((x) => x.replace(/ \d+[mh]$/, '')), ['#47 iso-date ready', '#9 queued by hand', '#46 relative contract changed', '#44 casual-date started', '#43 month-parser repairing']);
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
    // A key number is focusable and its tooltip carries the detail that left the tile.
    const tileTip = await page.evaluate("(() => { const k = document.querySelector('#numbers .ntile'); k.focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()");
    assert.match(tileTip ?? '', /^auto: 2 of 7 done$/m);
    assert.match(tileTip ?? '', /drill\/\* tasks were fire drills/);
  });

  test('"View all" expands the checks with Enter and collapses with Space, keeping focus', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    await page.evaluate("document.getElementById('checks-fold').open = true");
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
    await page.evaluate("document.getElementById('checks-fold').open = false");
  });

  test('focus returns to the same element after new data re-renders its section', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const key = await page.evaluate(`(() => {
      const a = document.querySelector('#needs li:nth-child(2) a.btn');
      a.focus();
      window.__glanceOld = a;
      document.getElementById('refresh').click(); // in sample mode this reloads the data
      return a.getAttribute('data-focus-key');
    })()`);
    assert.ok(key, 'the focused link has a focus key');
    await page.waitFor('document.activeElement !== window.__glanceOld && document.activeElement?.closest("#needs") != null', { timeoutMs: 10000, what: 'the re-render' });
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
      await page.waitFor("document.querySelectorAll('#numbers .ntile').length > 0", { what: 'the first render' });
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
          numbers: [...document.querySelectorAll('#numbers .num-v')].map((v) => v.innerText.trim()),
          stateChip: document.getElementById('state-chip').hidden,
          tiles: document.querySelectorAll('#board .tile').length,
          ready: document.documentElement.dataset.ready ?? null,
          out,
        };
      })()`);
      assert.equal(seen.ready, null, 'still loading');
      assert.equal(seen.health, '… Loading');
      assert.deepEqual(seen.numbers, ['…', '…', '…']);
      assert.equal(seen.stateChip, true, 'no state before the data arrives');
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

  test('"Factory off" is neutral grey with its power icon, not red', async () => {
    // Serve the sample with the kill switch off. (Its hashes no longer match, so the chain
    // reads as broken; only the kill-switch chip is checked here.)
    const off = readFileSync(FIXTURE_PATH, 'utf8').replaceAll('"factory_enabled":true', '"factory_enabled":false');
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*test/fixtures/sample.jsonl*' }] });
    try {
      const paused = page.once('Fetch.requestPaused', 30000);
      await page.navigate(`${server.url}index.html?fixture=1`);
      const { requestId } = await paused;
      await page.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }],
        body: Buffer.from(off).toString('base64'),
      });
      await page.waitFor(READY_EXPR, { timeoutMs: 30000, what: 'the modified sample to render' });
    } finally {
      await page.send('Fetch.disable');
    }
    const r = await page.evaluate(`(() => {
      const chip = document.getElementById('kill-chip');
      const probe = (v) => { const e = document.createElement('i'); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      return { text: chip.innerText.trim(), icon: !!chip.querySelector('svg use[href="#i-power"]'), color: getComputedStyle(chip).color,
        muted: probe('var(--muted)'), alert: probe('var(--alert)'), alertBg: probe('var(--alert-bg)'), bg: getComputedStyle(chip).backgroundColor };
    })()`);
    assert.equal(r.text, 'Factory off');
    assert.ok(r.icon, 'keeps the power icon');
    assert.equal(r.color, r.muted, 'neutral grey text');
    assert.notEqual(r.color, r.alert);
    assert.notEqual(r.bg, r.alertBg);
    // Back to the untouched sample for the remaining checks.
    await open('1', { force: true });
  });

  test('both themes: the dark theme really changes the colours, and the tiles stay told apart', async () => {
    await open('1');
    const colours = async (scheme) => {
      await page.setColorScheme(scheme);
      return page.evaluate(`(() => ({ bg: getComputedStyle(document.body).backgroundColor,
        tiles: [...new Set([...document.querySelectorAll('#board .tile')].map((t) => getComputedStyle(t).borderLeftColor))].length }))()`);
    };
    const dark = await colours('dark');
    const light = await colours('light');
    assert.notEqual(dark.bg, light.bg);
    assert.equal(dark.bg, 'rgb(13, 17, 23)');
    assert.equal(dark.tiles, 4);
    assert.equal(light.tiles, 4);
  });

  test('the console stays clean', () => {
    const noisy = page.console.filter((c) => !['debug', 'verbose'].includes(c.level));
    assert.deepEqual(noisy, []);
  });
});
