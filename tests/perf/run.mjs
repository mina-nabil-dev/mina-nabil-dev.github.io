#!/usr/bin/env node
/* ---------------------------------------------------------------
   Headless performance run. Zero dependencies (Node 22+).

   Serves the site, starts Chrome/Edge over the DevTools protocol, runs
   the harness (index.html?auto=1) and adds per-scenario engine counters
   a page cannot read on its own: layouts, style recalcs, script and
   task time, main-thread busy %.

     node tests/perf/run.mjs                     desktop 1366×768, no throttling
     node tests/perf/run.mjs --profile mobile    390×844, touch, 4× CPU slowdown
     node tests/perf/run.mjs --cpu 6 --headed    custom slowdown, visible window (real GPU)
     node tests/perf/run.mjs --net slow4g        network throttling for the load numbers
     node tests/perf/run.mjs --only ring_drag,modal
     node tests/perf/run.mjs --baseline          save this run as the comparison point

   Writes tests/perf/reports/<profile>-latest.json and compares it with
   <profile>-baseline.json when one exists. Exit code 1 when a budget in
   budgets.json is exceeded (unless --no-fail), 2 when the run breaks.
   --------------------------------------------------------------- */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const PROFILES = {
  desktop: { width: 1366, height: 768, dpr: 1, mobile: false, cpu: 1 },
  mobile: { width: 390, height: 844, dpr: 2, mobile: true, cpu: 4 },
};
// same presets Lighthouse uses; throughput in bytes/s
const NETWORKS = {
  none: null,
  fast4g: { latency: 40, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 },
  slow4g: { latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 },
};

const USAGE = `Usage: node tests/perf/run.mjs [options]
  --profile desktop|mobile   viewport, touch and default CPU slowdown (default desktop)
  --cpu <n>                  CPU slowdown factor (default 1 desktop, 4 mobile)
  --net none|fast4g|slow4g   network throttling (default none)
  --only <id,id>             run only these scenarios (ids from harness.js)
  --headed                   show the browser window (real GPU compositing)
  --browser <path>           Chrome/Edge/Chromium binary (or set CHROME_PATH)
  --baseline                 save this run as tests/perf/reports/<profile>-baseline.json
  --no-fail                  exit 0 even when budgets fail`;

/* ---- args ---- */
function parseArgs(argv) {
  const o = { profile: 'desktop', cpu: null, net: 'none', only: null, headed: false, browser: process.env.CHROME_PATH || null, baseline: false, fail: true, timeout: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
    if (a === '--profile') o.profile = value();
    else if (a === '--cpu') o.cpu = Number(value());
    else if (a === '--net') o.net = value();
    else if (a === '--only') o.only = value();
    else if (a === '--headed') o.headed = true;
    else if (a === '--browser') o.browser = value();
    else if (a === '--baseline') o.baseline = true;
    else if (a === '--no-fail') o.fail = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown option ${a}\n\n${USAGE}`);
  }
  if (!PROFILES[o.profile]) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`);
  if (!(o.net in NETWORKS)) throw new Error(`--net must be one of ${Object.keys(NETWORKS).join(', ')}`);
  if (o.cpu != null && !(o.cpu >= 1)) throw new Error('--cpu must be a number ≥ 1');
  return o;
}

/* ---- static server for the repo ---- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serve(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      let st = await fsp.stat(file).catch(() => null);
      if (st && st.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file).catch(() => null); }
      if (!st) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---- browser ---- */
function playwrightChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || (
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
      : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
        : path.join(os.homedir(), '.cache/ms-playwright'));
  try {
    return fs.readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
      .flatMap((d) => ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
        .map((p) => path.join(base, d, p)));
  } catch (e) {
    return [];
  }
}

function findBrowser(explicit) {
  const env = process.env;
  const pf = env.PROGRAMFILES;
  const pf86 = env['PROGRAMFILES(X86)'];
  const candidates = [
    explicit,
    pf && path.join(pf, 'Google/Chrome/Application/chrome.exe'),
    pf86 && path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    pf86 && path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    pf && path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    ...playwrightChromium(),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

async function launch(exe, { headed, width, height }) {
  const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'perf-chrome-'));
  const args = [
    `--user-data-dir=${userDir}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--mute-audio',
    // keep frames coming even when the window is covered
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${width},${height + 120}`,
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('The browser did not open a DevTools endpoint within 20 s')), 20000);
    proc.stderr.on('data', (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`The browser exited early (code ${code})\n${log.slice(-600)}`)); });
  });
  return { proc, wsUrl, userDir };
}

/* ---- minimal DevTools protocol client (Node's built-in WebSocket) ---- */
class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Could not connect to the DevTools endpoint')), { once: true });
    });
    return new CDP(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
      } else {
        this.listeners.forEach((fn) => fn(msg));
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch (e) { /* already closed */ } }
}

async function counters(s) {
  const { metrics } = await s('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/* ---- report ---- */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint(32), red = paint(31), yellow = paint(33), dim = paint(2), bold = paint(1);
const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const cell = (v, w) => String(v ?? '–').padStart(w);
const signed = (v, d = 1) => (v == null ? '–' : `${v > 0 ? '+' : ''}${round(v, d)}`);

function printReport(r, baseline) {
  const m = r.meta;
  const vp = m.viewport || {};
  console.log(`\n${bold('Performance')} · ${m.profile} ${vp.width}×${vp.height} @${vp.dpr}x · CPU ${m.cpu}× · net ${m.runner.net}`
    + ` · ${m.runner.browser} ${m.runner.headed ? 'headed' : 'headless'} · display ${m.hz} Hz${m.throttled ? red(' (throttled!)') : ''}`);

  const L = r.load;
  if (L) {
    console.log(`\n${bold('LOAD')}  FCP ${L.fcpMs} ms · LCP ${L.lcpMs} ms (${L.lcpElement}) · CLS ${L.cls} · blocking ${L.blockingMs} ms`
      + ` · ${L.requests} requests · ${L.transferKB} KB · ${L.domNodes} DOM nodes · ${L.perpetualAnimations} endless animations`);
    console.log(dim(`      heaviest: ${L.heaviest.map((h) => `${h.file} ${h.kb} KB`).join(' · ')}`));
  }

  const head = ['scenario', 'fps', 'smooth', 'p95', 'max', '>50', 'block', 'CLS', 'layouts', 'styles', 'style ms', 'script ms', 'busy%', ''];
  const widths = [22, 5, 7, 6, 6, 4, 6, 7, 8, 7, 9, 10, 6, 2];
  console.log(`\n${bold(head.map((h, i) => (i ? cell(h, widths[i]) : h.padEnd(widths[0]))).join(' '))}`);
  r.scenarios.forEach((sc) => {
    const f = sc.frames || {};
    const e = sc.engine || {};
    const row = [sc.id.padEnd(widths[0]), f.fps, f.smoothness, f.p95Ms, f.maxMs, f.longFrames, sc.blockingMs, sc.cls,
      e.layouts, e.styleRecalcs, e.styleMs, e.scriptMs, e.busyPct]
      .map((v, i) => (i ? cell(v, widths[i]) : v));
    console.log(`${row.join(' ')} ${sc.status === 'pass' ? green('✓') : sc.status === 'warn' ? yellow('~') : red('✗')}`);
  });

  const extras = r.scenarios.filter((sc) => sc.extra && Object.keys(sc.extra).length);
  if (extras.length) {
    console.log(`\n${bold('INTERACTIONS')}`);
    extras.forEach((sc) => console.log(`  ${sc.id.padEnd(20)} ${Object.entries(sc.extra).map(([k, v]) => `${k} ${v}`).join(' · ')}`));
  }

  const slow = r.scenarios.filter((sc) => sc.loaf && sc.loaf.topScripts.length);
  if (slow.length) {
    console.log(`\n${bold('SLOWEST SCRIPTS')} ${dim('(Long Animation Frames ≥ 50 ms)')}`);
    slow.forEach((sc) => sc.loaf.topScripts.slice(0, 2).forEach((s) => {
      console.log(`  ${sc.id.padEnd(20)} ${s.where} · ${s.ms} ms ×${s.count}${s.forcedLayoutMs ? ` · forced layout ${s.forcedLayoutMs} ms` : ''}`);
    }));
  }

  if (r.audit) {
    const big = r.audit.images.filter((i) => i.oversize > 1.5);
    console.log(`\n${bold('IMAGES')} ${dim(`(natural width ÷ displayed width × DPR ${r.audit.dpr})`)}`);
    (big.length ? big : r.audit.images.slice(0, 3)).forEach((i) => {
      const tag = i.oversize > 2 ? yellow(`${i.oversize}×`) : `${i.oversize}×`;
      console.log(`  ${i.file.padEnd(22)} ${i.natural.padStart(10)} shown ${String(i.shown).padStart(4)} px  ${tag}  ${i.kb} KB`);
    });
  }

  if (baseline) {
    const byId = new Map(baseline.scenarios.map((s) => [s.id, s]));
    console.log(`\n${bold('Δ vs BASELINE')} ${dim(`(${baseline.meta.date.slice(0, 16).replace('T', ' ')}; negative is better except smooth)`)}`);
    console.log(dim(`  ${'scenario'.padEnd(20)} ${cell('smooth', 8)} ${cell('p95 ms', 8)} ${cell('block', 8)} ${cell('style ms', 9)} ${cell('script ms', 10)} ${cell('busy%', 7)}`));
    r.scenarios.forEach((sc) => {
      const b = byId.get(sc.id);
      if (!b) return;
      const d = (get) => { const x = get(sc), y = get(b); return x == null || y == null ? null : x - y; };
      console.log(`  ${sc.id.padEnd(20)} ${cell(signed(d((s) => s.frames && s.frames.smoothness), 3), 8)} ${cell(signed(d((s) => s.frames && s.frames.p95Ms)), 8)}`
        + ` ${cell(signed(d((s) => s.blockingMs)), 8)} ${cell(signed(d((s) => s.engine && s.engine.styleMs)), 9)}`
        + ` ${cell(signed(d((s) => s.engine && s.engine.scriptMs)), 10)} ${cell(signed(d((s) => s.engine && s.engine.busyPct)), 7)}`);
    });
    if (baseline.load && r.load) {
      console.log(`  ${'load'.padEnd(20)} LCP ${signed(r.load.lcpMs - baseline.load.lcpMs, 0)} ms · FCP ${signed(r.load.fcpMs - baseline.load.fcpMs, 0)} ms`
        + ` · ${signed(r.load.transferKB - baseline.load.transferKB, 0)} KB · ${signed(r.load.domNodes - baseline.load.domNodes, 0)} nodes`);
    }
  }

  const fails = r.issues.filter((i) => i.level === 'fail');
  const warns = r.issues.filter((i) => i.level === 'warn');
  console.log('');
  fails.forEach((i) => console.log(red(`✗ ${i.where} · ${i.msg}`)));
  warns.forEach((i) => console.log(yellow(`! ${i.where} · ${i.msg}`)));
  console.log(fails.length ? red(bold(`\n${fails.length} budget failure(s), ${warns.length} warning(s)`))
    : green(bold(`\nAll budgets met · ${warns.length} warning(s)`)));
}

/* ---- main ---- */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }

  const prof = { ...PROFILES[opts.profile] };
  if (opts.cpu != null) prof.cpu = opts.cpu;
  const exe = findBrowser(opts.browser);
  if (!exe) throw new Error('No Chrome, Edge or Chromium found. Pass --browser <path> or set CHROME_PATH.');
  const budgets = JSON.parse(await fsp.readFile(path.join(HERE, 'budgets.json'), 'utf8'));
  const early = await fsp.readFile(path.join(HERE, 'early.js'), 'utf8');

  const server = await serve(ROOT);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser = null;
  let cdp = null;

  try {
    browser = await launch(exe, { headed: opts.headed, width: prof.width, height: prof.height });
    cdp = await CDP.connect(browser.wsUrl);
    const { product } = await cdp.send('Browser.getVersion');
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method, params) => cdp.send(method, params, sessionId);

    await Promise.all([s('Page.enable'), s('Runtime.enable'), s('Network.enable'), s('Performance.enable', { timeDomain: 'timeTicks' })]);
    await s('Network.setCacheDisabled', { cacheDisabled: true });
    if (NETWORKS[opts.net]) await s('Network.emulateNetworkConditions', { offline: false, ...NETWORKS[opts.net] });
    await s('Emulation.setDeviceMetricsOverride', { width: prof.width, height: prof.height, deviceScaleFactor: prof.dpr, mobile: prof.mobile });
    if (prof.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    if (prof.cpu > 1) await s('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: early });
    await s('Runtime.addBinding', { name: '__perfBridge' });

    console.log(dim(`${product} · ${path.basename(exe)} · serving ${ROOT} at ${origin}`));
    const marks = {};
    const pageErrors = [];
    const results = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The harness did not finish within ${opts.timeout} s`)), opts.timeout * 1000);
      cdp.on(async (msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          pageErrors.push(`${(d.exception && d.exception.description) || d.text} (${d.url || ''}:${d.lineNumber})`.split('\n')[0]);
          return;
        }
        if (msg.method !== 'Runtime.bindingCalled' || msg.params.name !== '__perfBridge') return;
        const data = JSON.parse(msg.params.payload);
        if (data.type === 'mark') {
          (marks[data.id] ||= {})[data.phase] = await counters(s);
          if (data.phase === 'end') process.stdout.write(dim(' ✓\n'));
          s('Runtime.evaluate', { expression: 'window.__perfAck && window.__perfAck()' }).catch(() => {});
        } else if (data.type === 'log') {
          process.stdout.write(dim(`  ▸ ${data.message}`));
        } else if (data.type === 'done') {
          clearTimeout(timer);
          resolve(data.results);
        } else if (data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`Harness error: ${data.message}`));
        }
      });
      const q = new URLSearchParams({ auto: '1', profile: opts.profile, cpu: String(prof.cpu), ...(opts.only ? { only: opts.only } : {}) });
      s('Page.navigate', { url: `${origin}/tests/perf/?${q}` }).catch(reject);
    });

    // engine counters per scenario, from the snapshots taken at its marks
    const fb = budgets.frames || {};
    results.scenarios.forEach((sc) => {
      const c = marks[sc.id];
      if (!c || !c.start || !c.end) return;
      const d = (k) => c.end[k] - c.start[k];
      const wall = d('Timestamp') * 1000;
      sc.engine = {
        layouts: d('LayoutCount'),
        styleRecalcs: d('RecalcStyleCount'),
        layoutMs: round(d('LayoutDuration') * 1000),
        styleMs: round(d('RecalcStyleDuration') * 1000),
        scriptMs: round(d('ScriptDuration') * 1000),
        taskMs: round(d('TaskDuration') * 1000),
        busyPct: wall > 0 ? round((d('TaskDuration') * 1000 / wall) * 100) : null,
      };
      const max = ((budgets.scenarios || {})[sc.id] || {}).maxBusyPct ?? fb.maxBusyPct;
      if (max != null && sc.engine.busyPct > max) {
        const msg = `main thread busy ${sc.engine.busyPct}% > ${max}%`;
        sc.issues.push(msg);
        sc.status = 'fail';
        results.issues.push({ where: sc.id, msg, level: 'fail' });
      }
    });
    pageErrors.forEach((e) => results.issues.push({ where: 'page', msg: `uncaught error: ${e}`, level: 'fail' }));

    // Headless Chrome rasterises on the CPU, so heavy paint (the Work ring's masks and
    // shadows) drops frames that a real GPU does not. Pacing becomes a warning there.
    if (!opts.headed) {
      results.issues.filter((i) => i.kind === 'pacing').forEach((i) => {
        i.level = 'warn';
        i.msg += ' (headless raster, confirm with --headed)';
      });
    }
    results.scenarios.forEach((sc) => {
      const mine = results.issues.filter((i) => i.where === sc.id);
      sc.status = mine.some((i) => i.level === 'fail') ? 'fail' : mine.length ? 'warn' : 'pass';
    });
    results.summary.failures = results.issues.filter((i) => i.level === 'fail').length;
    results.summary.warnings = results.issues.filter((i) => i.level === 'warn').length;
    results.meta.runner = { browser: product, binary: exe, headed: opts.headed, net: opts.net, cpu: prof.cpu };

    const outDir = path.join(HERE, 'reports');
    await fsp.mkdir(outDir, { recursive: true });
    const latest = path.join(outDir, `${opts.profile}-latest.json`);
    const basePath = path.join(outDir, `${opts.profile}-baseline.json`);
    const baseline = fs.existsSync(basePath) ? JSON.parse(await fsp.readFile(basePath, 'utf8')) : null;
    await fsp.writeFile(latest, JSON.stringify(results, null, 2));
    printReport(results, opts.baseline ? null : baseline);
    if (opts.baseline) await fsp.writeFile(basePath, JSON.stringify(results, null, 2));
    console.log(dim(`\nReport: ${path.relative(ROOT, latest)}${opts.baseline ? ` · saved as ${path.relative(ROOT, basePath)}` : ''}`));

    return results.summary.failures && opts.fail ? 1 : 0;
  } finally {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.close();
    }
    if (browser) {
      await new Promise((resolve) => {
        if (browser.proc.exitCode !== null) return resolve();
        const t = setTimeout(() => { browser.proc.kill(); resolve(); }, 3000);
        browser.proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
      await fsp.rm(browser.userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
    server.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(red(err.message)); process.exit(2); },
);
