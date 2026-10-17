// A tiny headless-Chrome driver for the glance test, with no npm dependencies: a static
// file server for dashboard/, Chrome started with --remote-debugging-port=0, and the
// DevTools protocol spoken over Node's global WebSocket (Node 22+).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, extname, join, normalize, resolve, sep } from 'node:path';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/** CHROME_PATH, then the usual Linux names on PATH, then the macOS app. Null if none. */
export function findChrome(env = process.env) {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  for (const name of LINUX_NAMES) {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (!dir) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return existsSync(MAC_CHROME) ? MAC_CHROME : null;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Serves `root` read-only on 127.0.0.1 at an ephemeral port. */
export async function serveDir(root) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = normalize(join(base, path));
      if (file !== base && !file.startsWith(base + sep)) throw Object.assign(new Error('outside root'), { code: 'ENOENT' });
      if (path.endsWith('/')) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((ok) => {
      server.closeAllConnections?.();
      server.close(() => ok());
    }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`timed out after ${ms} ms: ${what}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts headless Chrome with a throwaway profile. Returns { page, close }; close() always
 * kills Chrome and removes the profile directory, and is safe to call more than once.
 */
export async function launchChrome(chromePath, { width = 1440, height = 900, timeoutMs = 30000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'glance-chrome-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--mute-audio', '--hide-scrollbars',
    `--window-size=${width},${height}`, '--force-device-scale-factor=1', '--lang=en-US',
  ];
  // CI runners (and root) often can't use Chrome's sandbox; the page is local test content.
  if (process.platform === 'linux' && (process.env.CI || process.getuid?.() === 0)) args.push('--no-sandbox', '--disable-dev-shm-usage');
  args.push('about:blank');

  // Its own process group, so close() can stop Chrome and every helper it started.
  const group = process.platform !== 'win32';
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: group });
  const signal = (sig) => {
    try {
      if (group) process.kill(-proc.pid, sig);
      else proc.kill(sig);
    } catch {
      /* already gone */
    }
  };
  // Last resort if the test process exits without calling close().
  const onExit = () => {
    signal('SIGKILL');
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best effort while exiting */
    }
  };
  process.once('exit', onExit);
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  const exited = new Promise((r) => proc.once('exit', r));
  let ws = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    if (proc.exitCode == null && proc.signalCode == null) {
      signal('SIGTERM');
      const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!done) {
        signal('SIGKILL');
        await Promise.race([exited, sleep(5000)]);
      }
    }
    signal('SIGKILL'); // helpers that outlived the browser process
    process.removeListener('exit', onExit);
    // Helpers may still be flushing the profile for a moment after the browser exits.
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (!existsSync(profile)) break;
      } catch {
        /* retry */
      }
      await sleep(250);
    }
  };

  try {
    const portFile = join(profile, 'DevToolsActivePort');
    const port = await withTimeout((async () => {
      for (;;) {
        if (proc.exitCode != null) throw new Error(`Chrome exited early (code ${proc.exitCode}): ${stderr}`);
        const fromStderr = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(stderr);
        if (fromStderr) return Number(fromStderr[1]);
        if (existsSync(portFile)) {
          const first = readFileSync(portFile, 'utf8').split('\n')[0];
          if (/^\d+$/.test(first)) return Number(first);
        }
        await sleep(50);
      }
    })(), timeoutMs, 'Chrome DevTools port');
    const targets = await withTimeout((async () => {
      for (;;) {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
        const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pages.length) return pages;
        await sleep(100);
      }
    })(), timeoutMs, 'Chrome page target');
    ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await withTimeout(new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error('DevTools WebSocket failed to open')), { once: true });
    }), timeoutMs, 'DevTools WebSocket');
    const page = new Page(ws, timeoutMs);
    await page.init({ width, height });
    return { page, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** One page target, driven over the DevTools protocol. */
export class Page {
  constructor(ws, timeoutMs) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.console = []; // { level, text } for console calls, log entries and exceptions
    ws.addEventListener('message', (e) => this.#onMessage(JSON.parse(String(e.data))));
    ws.addEventListener('close', () => {
      for (const { fail } of this.pending.values()) fail(new Error('DevTools connection closed'));
      this.pending.clear();
    });
  }

  #onMessage(msg) {
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message}`));
      else p.ok(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      this.console.push({ level: msg.params.type, text });
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      this.console.push({ level: e.level, text: `${e.source}: ${e.text}${e.url ? ` (${e.url})` : ''}` });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.console.push({ level: 'error', text: `exception: ${d.exception?.description ?? d.text}` });
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return withTimeout(new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    }), this.timeoutMs, method);
  }

  async init({ width, height }) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }); // focus events in headless
    await this.setViewport(width, height);
  }

  async setViewport(width, height) {
    const mobile = width < 600;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  }

  setColorScheme(scheme) {
    return this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  }

  /** Evaluates an expression in the page and returns its value (awaiting promises). */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page evaluation failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Calls a self-contained function in the page with JSON-serializable arguments. */
  call(fn, ...args) {
    return this.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  }

  async navigate(url) {
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`);
  }

  /** Polls `expression` until it is truthy. */
  async waitFor(expression, { timeoutMs = this.timeoutMs, intervalMs = 100, what = expression } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.evaluate(expression).catch(() => false);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await sleep(intervalMs);
    }
  }

  async key(key, { code = key, keyCode = 0, text } = {}) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** PNG of the whole page (or just the viewport) as a Buffer. */
  async screenshot({ fullPage = true } = {}) {
    const params = { format: 'png' };
    if (fullPage) {
      const { cssContentSize } = await this.send('Page.getLayoutMetrics');
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  }
}
