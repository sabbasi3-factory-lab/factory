// The 5-second glance test: word budgets, layout and keyboard behaviour measured on the
// rendered sample pages in headless Chrome. The budgets are checked on both fixtures:
// ?fixture=1 (a busy factory, two items need the owner) and ?fixture=quiet (the state the
// live page is usually in: nothing needs the owner, factory off, dry run, no agents
// running, the verifier OK, ten merged PRs). No npm dependencies: see
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

  test('quiet: the live quiet state, and "Nothing needs you" is said once (the panel keeps its place with a ✓ 0)', async () => {
    await open('quiet');
    await page.setViewport(1440, 900);
    const r = await page.evaluate(`(() => {
      const text = (id) => document.getElementById(id)?.innerText.trim() ?? null;
      const tile = (name) => [...document.querySelectorAll('#kpis .kpi')].find((k) => k.querySelector('.kpi-t').innerText.trim() === name);
      const panel = document.getElementById('needs-panel');
      const ok = panel.querySelector('.needs-ok');
      return {
        chips: ['health', 'needs-link', 'kill-chip', 'dry-badge'].map(text),
        said: (document.body.innerText.match(/Nothing needs you/g) || []).length,
        panel: { shown: panel.getBoundingClientRect().height > 40, heading: document.getElementById('needs-h').textContent.trim(), body: text('needs'), clear: panel.classList.contains('needs--clear'),
          okLabel: ok?.getAttribute('role') === 'img' ? ok.getAttribute('aria-label') : null, tip: !!document.querySelector('#needs .has-tip'),
          // The ✓ and the 0 are both the "ok" colour, never the amber of a waiting count.
          green: (() => { const probe = document.createElement('i'); probe.style.color = 'var(--ok)'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove();
            return [ok, panel.querySelector('.big')].every((e) => e && getComputedStyle(e).color === c); })() },
        heartbeat: [tile('Heartbeat').className, tile('Heartbeat').querySelector('.kpi-v').innerText.trim()],
        verified: [tile('Verified').className, tile('Verified').querySelector('.kpi-v').innerText.trim()],
        agents: document.querySelector('#agents .agents-n')?.innerText.trim(),
        lanes: [...document.querySelectorAll('#pipeline .lane')].map((l) => l.querySelector('.lane-h').innerText.replace(/\\s+/g, ' ').trim()),
        laneLabels: [...document.querySelectorAll('#pipeline .lane')].map((l) => l.getAttribute('aria-label')),
      };
    })()`);
    assert.deepEqual(r.chips, ['Healthy', 'Nothing needs you', 'Factory off', 'Dry run']);
    assert.equal(r.said, 1, '"Nothing needs you" appears once, in the header chip');
    assert.deepEqual(r.panel, { shown: true, heading: 'Needs you', body: '0', clear: true, okLabel: 'Nothing needs you', tip: true, green: true });
    assert.deepEqual(r.heartbeat, ['panel kpi kpi--ok has-tip', '12m']);
    assert.deepEqual(r.verified, ['panel kpi kpi--ok has-tip', '1h']);
    assert.equal(r.agents, '0 of 3 agents running');
    // Empty lanes show just their name; the count stays in the group's label.
    assert.deepEqual(r.lanes, ['Ready', 'Running', 'PR open', 'Checks', 'Queue', 'Merged 10', 'Deployed']);
    assert.deepEqual(r.laneLabels, ['Ready: 0', 'Running: 0', 'PR open: 0', 'Checks: 0', 'Merge queue: 0', 'Merged: 10', 'Deployed: 0']);
  });

  test('quiet: the heartbeat, verified and health tooltips show the observed cadence and the limits', async () => {
    await open('quiet');
    await page.setViewport(1440, 900);
    const events = parseJsonl(readFileSync(QUIET_FIXTURE_PATH, 'utf8'), 'quiet.jsonl').map((rec) => rec.event);
    const { anchors } = parseAnchors(readFileSync(QUIET_ANCHORS_FIXTURE_PATH, 'utf8'));
    const hbLine = cadenceText('Heartbeats', observedCadence(heartbeatTimes(events)), 7);
    const vfLine = cadenceText('Verifications', observedCadence(anchorTimes(anchors, { now: Date.parse(QUIET_FIXTURE_NOW), days: 7 })), 7);
    assert.equal(hbLine, 'Heartbeats: median every 2.4 h, longest gap 7.6 h (7 days)');
    assert.equal(vfLine, 'Verifications: median every 2.9 h, longest gap 5.1 h (7 days)');
    const before = await measure(1440, 900);
    const tipOf = (expr) => page.evaluate(`(() => { const el = ${expr}; el.focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()`);
    const tile = (name) => `[...document.querySelectorAll('#kpis .kpi')].find((k) => k.querySelector('.kpi-t').innerText.trim() === '${name}')`;
    const hb = await tipOf(tile('Heartbeat'));
    const vf = await tipOf(tile('Verified'));
    const health = await tipOf("document.getElementById('health')");
    await press('Escape');
    for (const [tip, lines] of [
      [hb, [hbLine, 'Green up to 8 h, amber after 8 h, red after 12 h', CADENCE_NOTE]],
      [vf, [vfLine, 'Independent audit-verify run: green up to 8 h, amber after 8 h, red after 26 h or if the anchors file is unreadable', CADENCE_NOTE]],
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

  test('layout at 1440x900: agents/time and checks/cost are independent column stacks', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const { cols, slack } = await page.call(measureLayout);
    const detail = JSON.stringify({ cols, slack });
    assert.equal(cols.length, 2, detail);
    assert.deepEqual(cols.map((c) => c.sections), [['agents-h', 'stages-h'], ['checks-h', 'cost-h']], detail);
    assert.ok(cols[0].left < cols[1].left && cols[0].top === cols[1].top, `side by side: ${detail}`);
    for (const c of cols) for (const off of c.offsets) assert.ok(Math.abs(off) <= 1, `each section starts a gap below the one above it: ${detail}`);
    for (const p of slack) assert.ok(p.slack <= 80, `${p.id} has ${p.slack} px of empty space below its content: ${detail}`);
  });

  test('tooltips are reachable by Tab, show on focus and hide on Escape', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    await page.evaluate("document.activeElement?.blur(); window.scrollTo(0, 0); document.getElementById('tip').hidden = true");
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
    // A KPI tile is focusable and its tooltip carries the detail that left the tile.
    const tileTip = await page.evaluate("(() => { const k = document.querySelector('#kpis .kpi'); k.focus(); const t = document.getElementById('tip'); return t.hidden ? null : t.textContent; })()");
    assert.match(tileTip ?? '', /merged factory PRs/);
  });

  test('"View all" expands the checks with Enter and collapses with Space, keeping focus', async () => {
    await open('1');
    await page.setViewport(1440, 900);
    const state = () => page.evaluate(`(() => {
      const b = document.querySelector('#checks button.more');
      return { expanded: b?.getAttribute('aria-expanded'), text: b?.innerText.trim(), rows: document.querySelectorAll('#checks li').length,
        focused: document.activeElement === b };
    })()`);
    await page.evaluate("document.querySelector('#checks button.more').focus()");
    assert.deepEqual(await state(), { expanded: 'false', text: 'View all', rows: 5, focused: true });
    await press('Enter');
    assert.deepEqual(await state(), { expanded: 'true', text: 'Fewer', rows: 7, focused: true });
    await press(' ');
    assert.deepEqual(await state(), { expanded: 'false', text: 'View all', rows: 5, focused: true });
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
      await page.waitFor("document.querySelectorAll('#kpis .kpi').length > 0", { what: 'the first render' });
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
          heartbeat: [...document.querySelectorAll('#kpis .kpi')].find((k) => /Heartbeat/.test(k.innerText))?.querySelector('.kpi-v').innerText.trim(),
          stateIcons: document.querySelectorAll('.kpi-state').length,
          ready: document.documentElement.dataset.ready ?? null,
          out,
        };
      })()`);
      assert.equal(seen.ready, null, 'still loading');
      assert.equal(seen.health, '… Loading');
      assert.equal(seen.heartbeat, '…');
      assert.equal(seen.stateIcons, 0, 'no ✓/⚠/✗ before the data arrives');
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

  test('the console stays clean', () => {
    const noisy = page.console.filter((c) => !['debug', 'verbose'].includes(c.level));
    assert.deepEqual(noisy, []);
  });
});
