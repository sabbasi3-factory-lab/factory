// The 5-second glance test: word budgets, layout and keyboard behaviour measured on the
// rendered sample page (?fixture=1) in headless Chrome. No npm dependencies: see
// headless.mjs. Word, fold and sentence rules are defined on measureGlance() in
// glance-measure.mjs. Chrome is found via CHROME_PATH, common Linux names or the macOS
// app; without it the test is skipped locally and fails in CI (process.env.CI).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, serveDir } from './headless.mjs';
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

describe('glance: rendered sample page', { skip, timeout: 120000 }, () => {
  let server = null;
  let browser = null;
  let page = null;
  const press = (key) => page.key(key, KEYS[key]);
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
    await page.navigate(`${server.url}index.html?fixture=1`);
    await page.waitFor(READY_EXPR, { timeoutMs: 30000, what: 'the dashboard to render the sample data' });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  test(`1440x900: at most ${BUDGETS.foldWords} words above the fold`, async () => {
    const r = await measure(1440, 900);
    assert.ok(r.aboveFoldWords <= BUDGETS.foldWords, report('1440x900', r, { total: false, sentences: false }));
  });

  test(`1440x900: at most ${BUDGETS.totalWords} visible words`, async () => {
    const r = await measure(1440, 900);
    assert.ok(r.totalWords > 40, `suspiciously few words (${r.totalWords}): did the page render?`);
    assert.ok(r.totalWords <= BUDGETS.totalWords, report('1440x900', r, { fold: false, sentences: false }));
  });

  test(`1440x900: no visible sentence over ${BUDGETS.sentenceWords} words`, async () => {
    const r = await measure(1440, 900);
    assert.deepEqual(r.longSentences, [], report('1440x900', r, { fold: false, total: false }));
  });

  test(`390x844: at most ${BUDGETS.totalWords} visible words and no sentence over ${BUDGETS.sentenceWords} words`, async () => {
    const r = await measure(390, 844);
    assert.ok(r.totalWords <= BUDGETS.totalWords, report('390x844', r, { fold: false, sentences: false }));
    assert.deepEqual(r.longSentences, [], report('390x844', r, { fold: false, total: false }));
    await page.setViewport(1440, 900);
  });

  test('the word rules: separators split sentences, icons are not words, closed details and hidden tips are skipped', async () => {
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

  test('layout at 1440x900: agents/time and checks/cost are independent column stacks', async () => {
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

  test('the console stays clean', () => {
    const noisy = page.console.filter((c) => !['debug', 'verbose'].includes(c.level));
    assert.deepEqual(noisy, []);
  });
});
