// The glance budgets, measured on the rendered page. `measureGlance` runs inside the
// browser (it's serialized with Function#toString, so it must stay self-contained), and
// is shared by test/glance.test.mjs and by the CLI below, which measures the live page:
//
//   node dashboard/test/glance-measure.mjs            # live data
//   node dashboard/test/glance-measure.mjs --fixture  # sample data
//   node dashboard/test/glance-measure.mjs --shots <dir> --name <prefix>
//
// The CLI loads the page once (four API requests in live mode) and then measures and,
// with --shots, screenshots it at 1440x900 and 390x844 in the light and dark themes.

export const BUDGETS = Object.freeze({ foldWords: 80, totalWords: 250, sentenceWords: 8, foldY: 900 });

/** Truthy once the dashboard has rendered its data (app.js sets data-ready="1"). */
export const READY_EXPR = "document.documentElement.dataset.ready === '1'";

/**
 * Counts the words a person can see on the page.
 *
 * - Word: a whitespace-separated token with at least one letter or digit (\p{L} or \p{N}),
 *   so icons, emoji, "·", "—" and "ⓘ" are not words.
 * - Visible: in a text node under <body> (not script/style/svg), whose element and
 *   ancestors are not display:none, visibility:hidden/collapse or opacity:0, that is not
 *   screen-reader-only (clipped to rect(0 0 0 0) or inside a box of 1 px or less that
 *   clips its overflow), not inside a closed <details> (its <summary> stays visible), and
 *   whose own range has a non-empty client rect. Tooltips are hidden until hover or
 *   focus, and title attributes are not text, so neither counts.
 * - Above the fold: the word's first client rect starts above `foldY` with the page
 *   scrolled to the top.
 * - Sentence: a run of visible words in one run container (the nearest element whose
 *   computed display isn't "inline" or "contents"; a flex item or inline-block chip is
 *   its own container). A run ends at another container's text, a <br>, a newline in
 *   preformatted text, a "·", "|" or "•" token, or a word ending in ".", "!" or "?". So
 *   "3 need you · factory off" is two sentences, and chips are separate sentences.
 */
export function measureGlance({ foldY = 900, maxSentenceWords = 8 } = {}) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
  const SEPARATOR = /^[·|•]+$/;
  const ENDS = /[.!?]["')\]]?$/;
  const isWord = (t) => /[\p{L}\p{N}]/u.test(t);
  const styles = new Map();
  const cs = (el) => {
    let s = styles.get(el);
    if (!s) styles.set(el, (s = getComputedStyle(el)));
    return s;
  };
  const hiddenCache = new Map();
  const hidden = (el) => {
    if (!el || el === document.documentElement) return false;
    if (hiddenCache.has(el)) return hiddenCache.get(el);
    const s = cs(el);
    let h = s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0;
    if (!h && /^rect\(0px,? 0px,? 0px,? 0px\)$/.test(s.clip)) h = true;
    if (!h && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) h = true;
    }
    if (!h) h = hidden(el.parentElement);
    hiddenCache.set(el, h);
    return h;
  };
  const inClosedDetails = (el) => {
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
      if (!d.open) {
        const summary = [...d.children].find((c) => c.tagName === 'SUMMARY');
        if (!summary || !summary.contains(el)) return true;
      }
    }
    return false;
  };
  const containerOf = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const d = cs(e).display;
      if (d !== 'inline' && d !== 'contents') return e;
    }
    return document.body;
  };
  const describe = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (e.classList.length ? `.${[...e.classList].join('.')}` : ''));
      if (e.id) break;
    }
    return parts.join(' > ');
  };

  window.scrollTo(0, 0);
  const range = document.createRange();
  const words = [];
  const sentences = [];
  let current = null; // { container, words: [] }
  const endSentence = () => {
    if (current && current.words.length) sentences.push(current);
    current = null;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR') endSentence();
      continue;
    }
    const el = node.parentElement;
    if (!el || SKIP.has(el.tagName) || el.closest('svg')) continue;
    if (!/\S/.test(node.data) || hidden(el) || inClosedDetails(el)) continue;
    const container = containerOf(el);
    const pre = cs(el).whiteSpace.startsWith('pre') || cs(el).whiteSpace === 'break-spaces';
    const re = /\S+/g;
    let m;
    let lastEnd = 0;
    while ((m = re.exec(node.data))) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rect = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0);
      if (!rect) continue;
      if (pre && node.data.slice(lastEnd, m.index).includes('\n')) endSentence();
      lastEnd = m.index + m[0].length;
      if (!current || current.container !== container) {
        endSentence();
        current = { container, words: [] };
      }
      const token = m[0];
      if (SEPARATOR.test(token)) {
        endSentence();
        continue;
      }
      if (isWord(token)) {
        const w = { text: token, top: Math.round(rect.top), where: describe(container) };
        words.push(w);
        current.words.push(token);
      }
      if (ENDS.test(token)) endSentence();
    }
  }
  endSentence();

  const above = words.filter((w) => w.top < foldY);
  const runs = sentences.map((s) => ({ words: s.words.length, text: s.words.join(' '), where: describe(s.container) }));
  const longest = runs.reduce((a, b) => (b.words > a.words ? b : a), { words: 0, text: '', where: '' });
  const group = (list) => {
    const by = new Map();
    for (const w of list) {
      const g = by.get(w.where) ?? { where: w.where, count: 0, text: [] };
      g.count++;
      g.text.push(w.text);
      by.set(w.where, g);
    }
    return [...by.values()].map((g) => ({ ...g, text: g.text.join(' ') })).sort((a, b) => b.count - a.count);
  };
  return {
    viewport: { width: innerWidth, height: innerHeight },
    totalWords: words.length,
    aboveFoldWords: above.length,
    longestSentence: longest,
    longSentences: runs.filter((r) => r.words > maxSentenceWords).sort((a, b) => b.words - a.words),
    aboveFoldByPlace: group(above),
    allByPlace: group(words),
  };
}

/**
 * The detail area's layout: two independent column stacks (.cols > .col), each section
 * starting right below the previous one in its column (its bottom plus the column gap),
 * and how much empty space each panel has below its content (`slack`, in px).
 */
export function measureLayout() {
  const px = (v) => Number.parseFloat(v) || 0;
  const box = (el) => el.getBoundingClientRect();
  const shown = (el) => getComputedStyle(el).display !== 'none' && box(el).height > 0;
  const cols = [...document.querySelectorAll('main .cols > .col')].map((col) => {
    const gap = px(getComputedStyle(col).rowGap);
    const sections = [...col.children].filter(shown);
    return {
      left: Math.round(box(col).left),
      top: Math.round(box(col).top),
      width: Math.round(box(col).width),
      sections: sections.map((sec) => sec.getAttribute('aria-labelledby')),
      // 0 when each section starts exactly a gap below the previous one.
      offsets: sections.slice(1).map((sec, i) => Math.round((box(sec).top - box(sections[i]).bottom - gap) * 10) / 10),
    };
  });
  const slack = [...document.querySelectorAll('main .cols .panel')].filter(shown).map((panel) => {
    const cs = getComputedStyle(panel);
    const inner = box(panel).bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom);
    const kids = [...panel.children].filter((k) => shown(k) && getComputedStyle(k).position !== 'absolute');
    const contentBottom = Math.max(box(panel).top + px(cs.borderTopWidth) + px(cs.paddingTop), ...kids.map((k) => box(k).bottom + px(getComputedStyle(k).marginBottom)));
    return { id: panel.id, slack: Math.round(inner - contentBottom) };
  });
  return { cols, slack };
}

/** A short human-readable report of one measurement. */
export function formatMeasurement(label, r, budgets = BUDGETS) {
  return `${label}: ${r.aboveFoldWords} words above the fold (budget ${budgets.foldWords}), ${r.totalWords} visible words (budget ${budgets.totalWords}), longest sentence ${r.longestSentence.words} words (budget ${budgets.sentenceWords}): "${r.longestSentence.text}"`;
}

export function formatDetails(r, { fold = true, total = true, sentences = true } = {}) {
  const out = [];
  if (sentences && r.longSentences.length) {
    out.push('  sentences over the limit:');
    for (const s of r.longSentences) out.push(`    ${s.words} words  ${s.where}: "${s.text}"`);
  }
  if (fold) {
    out.push('  words above the fold, by place:');
    for (const g of r.aboveFoldByPlace) out.push(`    ${String(g.count).padStart(3)}  ${g.where}: ${g.text}`);
  }
  if (total) {
    out.push('  all visible words, by place:');
    for (const g of r.allByPlace) out.push(`    ${String(g.count).padStart(3)}  ${g.where}: ${g.text}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

async function main(argv) {
  const { fileURLToPath } = await import('node:url');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { findChrome, launchChrome, serveDir } = await import('./headless.mjs');
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const fixture = argv.includes('--fixture');
  const verbose = argv.includes('--verbose');
  const shots = arg('--shots');
  const name = arg('--name') ?? (fixture ? 'fixture' : 'live');
  const ready = arg('--ready-expr') ?? READY_EXPR;
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found: set CHROME_PATH');
  const server = await serveDir(fileURLToPath(new URL('..', import.meta.url)));
  let browser = null;
  try {
    browser = await launchChrome(chrome, { width: 1440, height: 900, timeoutMs: 45000 });
    const { page } = browser;
    await page.setColorScheme('light');
    await page.navigate(`${server.url}index.html${fixture ? '?fixture=1' : ''}`);
    await page.waitFor(ready, { timeoutMs: 45000, what: 'the dashboard to render' });
    await new Promise((r) => setTimeout(r, 800));
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      await page.setViewport(w, h);
      for (const scheme of ['light', 'dark']) {
        await page.setColorScheme(scheme);
        await new Promise((r) => setTimeout(r, 300));
        if (scheme === 'light') {
          const r = await page.call(measureGlance, { foldY: h });
          console.log(formatMeasurement(`${name} ${w}x${h}`, r));
          if (verbose) console.log(formatDetails(r));
          if (w === 1440) console.log(`  layout: ${JSON.stringify(await page.call(measureLayout))}`);
        }
        if (shots) {
          mkdirSync(shots, { recursive: true });
          const file = join(shots, `${name}-${w === 1440 ? 1440 : 390}-${scheme}.png`);
          writeFileSync(file, await page.screenshot());
          console.log(`  saved ${file}`);
        }
      }
    }
    const noisy = page.console.filter((c) => c.level !== 'debug' && c.level !== 'verbose');
    console.log(noisy.length ? `console:\n${noisy.map((c) => `  [${c.level}] ${c.text}`).join('\n')}` : 'console: clean');
  } finally {
    await browser?.close();
    await server.close();
  }
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
