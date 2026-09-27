/* ---------------------------------------------------------------
   Performance harness for mina.dev

   Loads the site in a same-origin iframe, drives it through scripted
   scenarios and measures each one:
     frames    pacing against the display refresh: smoothness, p95,
               frames over 50 ms
     blocking  main-thread blocking from Long Animation Frames, with
               the scripts that caused it (and forced layouts inside)
     shifts    layout shift (CLS) inside the scenario window
   Some scenarios add their own numbers (handler cost per frame, time
   to open the modal, time to switch language).

   Shared by index.html (interactive) and run.mjs (headless CLI, which
   adds engine counters: layouts, style recalcs, script and task time).
   --------------------------------------------------------------- */
(function (global) {
  'use strict';

  const SCROLL_SPEED = 1200; // px/s for scripted scrolling: a brisk read, not a fling
  const SECTIONS = [
    ['hero', '.hero'],
    ['work', '#work'],
    ['about', '#about'],
    ['stack', '#stack'],
    ['contact', '#contact'],
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const pick = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  const fileOf = (url) => {
    try { const u = new URL(url); return u.pathname.split('/').pop() || u.host; } catch (e) { return url || 'inline'; }
  };
  const describe = (el) => el.tagName.toLowerCase()
    + (el.id ? `#${el.id}` : '')
    + (el.classList && el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '');

  /* ---- CLI bridge ------------------------------------------------
     run.mjs exposes window.__perfBridge (a DevTools binding). At every
     mark it snapshots the engine counters and then calls __perfAck(),
     so the scenario only starts once the "before" numbers are taken. */
  let ackResolve = null;
  global.__perfAck = () => { const r = ackResolve; ackResolve = null; if (r) r(); };

  function send(msg) {
    if (typeof global.__perfBridge === 'function') global.__perfBridge(JSON.stringify(msg));
  }

  function tell(msg) {
    if (typeof global.__perfBridge !== 'function') return Promise.resolve();
    return new Promise((resolve) => {
      ackResolve = resolve;
      setTimeout(resolve, 3000); // never hang a run on a lost ack
      send(msg);
    });
  }

  /* ---- The page under test ---- */
  class Target {
    constructor(iframe, url) { this.iframe = iframe; this.url = url; }
    get win() { return this.iframe.contentWindow; }
    get doc() { return this.iframe.contentDocument; }
    now() { return this.win.performance.now(); }
    frame() { return new Promise((r) => this.win.requestAnimationFrame(r)); }
    load() {
      return new Promise((resolve) => {
        this.iframe.addEventListener('load', () => resolve(), { once: true });
        this.iframe.src = `${this.url}${this.url.includes('?') ? '&' : '?'}run=${Date.now()}`;
      });
    }
    // the site sets scroll-behavior:smooth, so every jump has to ask for 'instant'
    scrollTo(y) { this.win.scrollTo({ top: Math.round(y), behavior: 'instant' }); }
    maxScroll() { return this.doc.documentElement.scrollHeight - this.win.innerHeight; }
    $(sel) { return this.doc.querySelector(sel); }
    topOf(sel) { const el = this.$(sel); return el ? el.getBoundingClientRect().top + this.win.scrollY : 0; }
    // scroll position that centres an element in the viewport
    centre(sel) {
      const r = this.$(sel).getBoundingClientRect();
      return r.top + this.win.scrollY - Math.max(0, (this.win.innerHeight - r.height) / 2);
    }
  }

  /* ---- Measurement ---- */
  function startProbe(t) {
    const W = t.win;
    const buckets = { loaf: [], longtask: [], shift: [] };
    const observers = [];
    const watch = (type, key) => {
      try {
        const o = new W.PerformanceObserver((list) => buckets[key].push(...list.getEntries()));
        o.observe({ type });
        observers.push([o, key]);
      } catch (e) { /* unsupported entry type */ }
    };
    watch('long-animation-frame', 'loaf');
    watch('longtask', 'longtask');
    watch('layout-shift', 'shift');

    const frames = [];
    let running = true;
    const tick = (ts) => { if (!running) return; frames.push(ts); W.requestAnimationFrame(tick); };
    W.requestAnimationFrame(tick);

    return {
      stop() {
        running = false;
        observers.forEach(([o, key]) => { buckets[key].push(...o.takeRecords()); o.disconnect(); });
        return { frames, ...buckets };
      },
    };
  }

  function frameStats(ts, refresh) {
    const d = [];
    for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
    if (!d.length) return null;
    const s = [...d].sort((a, b) => a - b);
    const dur = ts[ts.length - 1] - ts[0];
    let dropped = 0;
    d.forEach((x) => { dropped += Math.max(0, Math.round(x / refresh) - 1); });
    return {
      durationMs: round(dur, 0),
      frames: d.length,
      fps: round(d.length / (dur / 1000)),
      smoothness: round(d.length / (d.length + dropped), 3), // share of refreshes that got a new frame
      droppedFrames: dropped,
      p50Ms: round(pick(s, 0.5)),
      p95Ms: round(pick(s, 0.95)),
      p99Ms: round(pick(s, 0.99)),
      maxMs: round(s[s.length - 1]),
      longFrames: d.filter((x) => x > 50).length,
    };
  }

  function loafStats(entries) {
    const scripts = new Map();
    let total = 0, blocking = 0, worst = 0;
    entries.forEach((e) => {
      total += e.duration;
      blocking += e.blockingDuration || 0;
      worst = Math.max(worst, e.duration);
      (e.scripts || []).forEach((s) => {
        const fn = s.sourceFunctionName || s.invoker || s.invokerType || 'anonymous';
        const where = `${fn} (${fileOf(s.sourceURL)}${s.sourceCharPosition >= 0 ? `:${s.sourceCharPosition}` : ''})`;
        const cur = scripts.get(where) || { where, ms: 0, count: 0, forcedLayoutMs: 0 };
        cur.ms += s.duration;
        cur.count += 1;
        cur.forcedLayoutMs += s.forcedStyleAndLayoutDuration || 0;
        scripts.set(where, cur);
      });
    });
    return {
      count: entries.length,
      totalMs: round(total),
      blockingMs: round(blocking),
      worstMs: round(worst),
      topScripts: [...scripts.values()]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5)
        .map((s) => ({ ...s, ms: round(s.ms), forcedLayoutMs: round(s.forcedLayoutMs) })),
    };
  }

  const clsOf = (entries) => round(entries.filter((e) => !e.hadRecentInput).reduce((a, e) => a + e.value, 0), 4);
  const tbtOf = (entries) => entries.reduce((a, e) => a + Math.max(0, e.duration - 50), 0);

  async function measure(ctx, id, body) {
    const t = ctx.target;
    const perf = t.win.performance;
    perf.mark(`perf:${id}:start`); // shows up in the DevTools Performance "Timings" track
    await tell({ type: 'mark', phase: 'start', id });
    const probe = startProbe(t);
    const extra = (await body()) || {};
    await t.frame();
    const raw = probe.stop();
    await tell({ type: 'mark', phase: 'end', id });
    try { perf.measure(`perf:${id}`, `perf:${id}:start`); } catch (e) { /* page navigated */ }

    const loaf = ctx.hasLoaf ? loafStats(raw.loaf) : null;
    return {
      frames: frameStats(raw.frames, ctx.refreshMs),
      blockingMs: round(loaf ? loaf.blockingMs : tbtOf(raw.longtask)),
      longTasks: raw.longtask.length,
      loaf,
      cls: clsOf(raw.shift),
      extra,
    };
  }

  async function measureRefresh() {
    const ts = [];
    const done = new Promise((resolve) => {
      const f = (x) => { ts.push(x); if (ts.length < 48) requestAnimationFrame(f); else resolve(); };
      requestAnimationFrame(f);
    });
    await Promise.race([done, sleep(3000)]);
    if (ts.length < 10) return { refreshMs: 1000 / 60, throttled: true }; // hidden tab: rAF is paused
    const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b);
    const refreshMs = pick(d, 0.5);
    return { refreshMs, throttled: refreshMs > 34 };
  }

  function buffered(W, type) {
    return new Promise((resolve) => {
      const got = [];
      try {
        const o = new W.PerformanceObserver((l) => got.push(...l.getEntries()));
        o.observe({ type, buffered: true });
        setTimeout(() => { got.push(...o.takeRecords()); o.disconnect(); resolve(got); }, 250);
      } catch (e) { resolve(got); }
    });
  }

  /* ---- Drivers ---- */
  async function drive(t, from, to, pxPerSec = SCROLL_SPEED) {
    t.scrollTo(from);
    await t.frame();
    const dist = to - from;
    const dur = Math.max(1, (Math.abs(dist) / pxPerSec) * 1000);
    const start = t.now();
    let k = 0;
    while (k < 1) {
      await t.frame();
      k = Math.min(1, (t.now() - start) / dur);
      t.scrollTo(from + dist * k);
    }
  }

  // contiguous scroll ranges, one per section: each starts when the section's top reaches mid-screen
  function segments(t) {
    const vh = t.win.innerHeight;
    const max = t.maxScroll();
    const starts = SECTIONS.map(([, sel]) => Math.max(0, Math.min(max, t.topOf(sel) - vh * 0.5)));
    starts[0] = 0;
    return SECTIONS.map(([key], i) => ({ key, from: starts[i], to: i + 1 < starts.length ? starts[i + 1] : max }));
  }

  async function drag(t, el, dx, ms) {
    const W = t.win;
    const r = el.getBoundingClientRect();
    const y = r.top + r.height * 0.4;
    const x0 = r.left + r.width / 2 - dx / 2;
    const ev = (type, x) => new W.PointerEvent(type, {
      pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    el.dispatchEvent(ev('pointerdown', x0));
    const start = t.now();
    let k = 0;
    while (k < 1) {
      await t.frame();
      k = Math.min(1, (t.now() - start) / ms);
      el.dispatchEvent(ev('pointermove', x0 + dx * k));
    }
    el.dispatchEvent(ev('pointerup', x0 + dx));
  }

  async function toRing(ctx) {
    const t = ctx.target;
    t.scrollTo(t.centre('#cineViewport'));
    await sleep(ctx.state.ringSeen ? 600 : 3300); // the first visit plays a 2.6 s intro spin
    ctx.state.ringSeen = true;
  }

  // Sweep the pointer over a grid, one move per frame. The page answers each move in a
  // rAF callback; bracketing it with our own callbacks (one registered before the event,
  // one after) times exactly that work, forced layouts included.
  async function spotlight(ctx, id, sel) {
    const t = ctx.target;
    const W = t.win;
    const grid = t.$(sel);
    t.scrollTo(t.centre(sel));
    await sleep(1600); // let the reveal finish
    const r = grid.getBoundingClientRect();
    const ev = (type, x, y) => new W.PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y,
      bubbles: type === 'pointermove',
    });
    const costs = [];
    return measure(ctx, id, async () => {
      grid.dispatchEvent(ev('pointerenter', r.left + 4, r.top + 4));
      const start = t.now();
      while (t.now() - start < 2000) {
        const k = (t.now() - start) / 1000;
        const x = r.left + r.width * (0.5 + 0.45 * Math.sin(k * 5.1));
        const y = r.top + r.height * (0.5 + 0.42 * Math.sin(k * 7.3));
        let before = 0;
        W.requestAnimationFrame(() => { before = t.now(); });
        grid.dispatchEvent(ev('pointermove', x, y));
        await new Promise((next) => W.requestAnimationFrame(() => { costs.push(t.now() - before); next(); }));
      }
      grid.dispatchEvent(ev('pointerleave', r.left - 10, r.top - 10));
      const s = costs.sort((a, b) => a - b);
      return {
        moves: s.length,
        handlerP50Ms: round(pick(s, 0.5), 3),
        handlerP95Ms: round(pick(s, 0.95), 3),
        handlerMaxMs: round(s[s.length - 1], 3),
      };
    });
  }

  /* ---- Scenarios ----------------------------------------------------
     Run in this order, on one page load, so the scroll pass is "cold":
     the reveal animations and the ring intro happen inside it, as they
     would for a first-time visitor. `cold` scenarios get a fresh load. */
  async function runLoad(ctx) {
    const t = ctx.target;
    await tell({ type: 'mark', phase: 'start', id: 'load' });
    await t.load();
    await sleep(3000); // LCP and the hero reveal settle
    await tell({ type: 'mark', phase: 'end', id: 'load' });

    const W = t.win;
    const p = W.performance;
    const early = W.__perfEarly; // present when run.mjs injected early.js
    const entries = (type, key) => (early ? Promise.resolve(early[key].slice()) : buffered(W, type));
    const [lcpE, shiftE, loafE, ltE] = await Promise.all([
      entries('largest-contentful-paint', 'lcp'),
      entries('layout-shift', 'shift'),
      entries('long-animation-frame', 'loaf'),
      entries('longtask', 'longtask'),
    ]);
    const nav = p.getEntriesByType('navigation')[0] || {};
    const fcp = p.getEntriesByName('first-contentful-paint')[0];
    const lcp = lcpE[lcpE.length - 1];
    const res = p.getEntriesByType('resource');
    const size = (e) => e.encodedBodySize || e.transferSize || 0;
    const loaf = ctx.hasLoaf ? loafStats(loafE) : null;
    const anims = t.doc.getAnimations();

    return {
      ttfbMs: round(nav.responseStart, 0),
      domContentLoadedMs: round(nav.domContentLoadedEventEnd, 0),
      loadMs: round(nav.loadEventEnd, 0),
      fcpMs: round(fcp && fcp.startTime, 0),
      lcpMs: round(lcp && lcp.startTime, 0),
      lcpElement: lcp ? (lcp.element ? describe(lcp.element) : fileOf(lcp.url)) : null,
      cls: clsOf(shiftE),
      blockingMs: round(loaf ? loaf.blockingMs : tbtOf(ltE)),
      loaf,
      requests: res.length + 1,
      transferKB: round((res.reduce((a, e) => a + size(e), 0) + size(nav)) / 1024, 0),
      heaviest: [...res]
        .sort((a, b) => size(b) - size(a))
        .slice(0, 5)
        .map((e) => ({ file: fileOf(e.name), kb: round(size(e) / 1024), type: e.initiatorType })),
      domNodes: t.doc.getElementsByTagName('*').length,
      runningAnimations: anims.length,
      perpetualAnimations: anims.filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length,
    };
  }

  const SCENARIOS = [
    { id: 'load', label: 'Cold load', load: true },
    {
      id: 'hero_idle', label: 'Hero · idle 3 s',
      async run(ctx) { ctx.target.scrollTo(0); await sleep(400); return measure(ctx, 'hero_idle', () => sleep(3000)); },
    },
    ...SECTIONS.map(([key]) => ({
      id: `scroll_${key}`, label: `Scroll · ${key}`,
      async run(ctx) {
        const seg = segments(ctx.target).find((s) => s.key === key);
        if (key === 'work') ctx.state.ringSeen = true;
        return measure(ctx, `scroll_${key}`, () => drive(ctx.target, seg.from, seg.to));
      },
    })),
    {
      id: 'contact_idle', label: 'Contact · idle 3 s',
      async run(ctx) {
        ctx.target.scrollTo(ctx.target.maxScroll());
        await sleep(1600);
        return measure(ctx, 'contact_idle', () => sleep(3000));
      },
    },
    {
      id: 'ring_drag', label: 'Work ring · drag ×2',
      async run(ctx) {
        await toRing(ctx);
        const t = ctx.target;
        const vp = t.$('#cineViewport');
        vp.setPointerCapture = () => {}; // synthetic pointers cannot be captured
        try {
          return await measure(ctx, 'ring_drag', async () => {
            await drag(t, vp, -620, 700); await sleep(1400);
            await drag(t, vp, 620, 700); await sleep(1400);
          });
        } finally { delete vp.setPointerCapture; }
      },
    },
    {
      id: 'ring_step', label: 'Work ring · next ×6',
      async run(ctx) {
        await toRing(ctx);
        const next = ctx.target.$('#cineNext');
        return measure(ctx, 'ring_step', async () => {
          for (let i = 0; i < 6; i++) { next.click(); await sleep(220); }
          await sleep(1300);
        });
      },
    },
    { id: 'spotlight_stack', label: 'Stack · pointer sweep', run: (ctx) => spotlight(ctx, 'spotlight_stack', '.stack-groups') },
    { id: 'spotlight_contact', label: 'Contact · pointer sweep', run: (ctx) => spotlight(ctx, 'spotlight_contact', '.contact-grid') },
    {
      id: 'modal', label: 'Project modal · open + close',
      async run(ctx) {
        await toRing(ctx);
        const t = ctx.target;
        return measure(ctx, 'modal', async () => {
          let a = t.now();
          t.$('#cineDetails').click();
          const open = t.now() - a;
          await sleep(1000);
          a = t.now();
          t.$('#detailClose').click();
          const close = t.now() - a;
          await sleep(600);
          return { openScriptMs: round(open, 2), closeScriptMs: round(close, 2) };
        });
      },
    },
    {
      id: 'lang_toggle', label: 'Language · switch + back',
      async run(ctx) {
        const t = ctx.target;
        t.scrollTo(t.topOf('#about') - 80);
        await sleep(1600);
        const btn = t.$('#langToggle');
        return measure(ctx, 'lang_toggle', async () => {
          // `await null` lets the page's MutationObservers (headline re-split, ring caption) run inside the timing
          let a = t.now(); btn.click(); await null; const first = t.now() - a;
          await sleep(700);
          a = t.now(); btn.click(); await null; const second = t.now() - a;
          await sleep(700);
          return { firstToggleMs: round(first, 2), secondToggleMs: round(second, 2) };
        });
      },
    },
    {
      id: 'scroll_warm', label: 'Scroll · whole page (warm)',
      async run(ctx) {
        const t = ctx.target;
        t.scrollTo(0);
        await sleep(500);
        return measure(ctx, 'scroll_warm', () => drive(t, 0, t.maxScroll()));
      },
    },
    {
      id: 'ring_intro', label: 'Work ring · intro spin (cold)', cold: true,
      async run(ctx) {
        const t = ctx.target;
        return measure(ctx, 'ring_intro', async () => { t.scrollTo(t.centre('#cineViewport')); await sleep(3300); });
      },
    },
  ];

  /* ---- End-of-run audit: what is on the page once everything has loaded ---- */
  function audit(ctx) {
    const t = ctx.target;
    const W = t.win;
    const dpr = W.devicePixelRatio || 1;
    const sizes = new Map(W.performance.getEntriesByType('resource').map((e) => [e.name, e.encodedBodySize || e.transferSize || 0]));
    const byFile = new Map();
    [...t.doc.images].forEach((img) => {
      const shown = img.clientWidth; // layout width, ignores the ring's 3D magnification
      if (!img.naturalWidth || !shown) return;
      const cur = byFile.get(img.currentSrc) || {
        file: fileOf(img.currentSrc), natural: `${img.naturalWidth}×${img.naturalHeight}`,
        nw: img.naturalWidth, shown: 0, copies: 0, kb: round((sizes.get(img.currentSrc) || 0) / 1024),
      };
      cur.shown = Math.max(cur.shown, shown);
      cur.copies += 1;
      byFile.set(img.currentSrc, cur);
    });
    const images = [...byFile.values()]
      .map(({ nw, ...i }) => ({ ...i, shown: Math.round(i.shown), oversize: round(nw / (i.shown * dpr), 2) }))
      .sort((a, b) => b.oversize - a.oversize);
    const anims = t.doc.getAnimations();
    return {
      dpr,
      images,
      domNodes: t.doc.getElementsByTagName('*').length,
      perpetualAnimations: anims.filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length,
      heapMB: W.performance.memory ? round(W.performance.memory.usedJSHeapSize / 1048576) : null,
    };
  }

  /* ---- Budgets ---- */
  function evaluate(results, budgets) {
    const issues = [];
    const over = (v, max) => max != null && v != null && v > max;
    const add = (where, msg, level = 'fail', kind = 'budget') => issues.push({ where, msg, level, kind });
    const refresh = results.meta.refreshMs;

    const L = results.load;
    const lb = budgets.load || {};
    if (L) {
      if (over(L.fcpMs, lb.fcpMs)) add('load', `FCP ${L.fcpMs} ms > ${lb.fcpMs} ms`);
      if (over(L.lcpMs, lb.lcpMs)) add('load', `LCP ${L.lcpMs} ms > ${lb.lcpMs} ms`);
      if (over(L.cls, lb.cls)) add('load', `CLS ${L.cls} > ${lb.cls}`);
      if (over(L.blockingMs, lb.blockingMs)) add('load', `blocking ${L.blockingMs} ms > ${lb.blockingMs} ms`);
      if (over(L.domNodes, lb.domNodes)) add('load', `${L.domNodes} DOM nodes > ${lb.domNodes}`);
      if (over(L.transferKB, lb.transferKB)) add('load', `${L.transferKB} KB transferred > ${lb.transferKB} KB`);
      L.status = issues.some((i) => i.where === 'load') ? 'fail' : 'pass';
    }

    const ib = budgets.interactions || {};
    results.scenarios.forEach((sc) => {
      const b = { ...budgets.frames, ...((budgets.scenarios || {})[sc.id] || {}) };
      const f = sc.frames;
      const mine = [];
      const pacing = [];   // frame pacing depends on the GPU; run.mjs downgrades these when headless
      if (f) {
        if (b.minSmoothness != null && f.smoothness < b.minSmoothness) pacing.push(`smoothness ${f.smoothness} < ${b.minSmoothness}`);
        if (b.maxP95Factor != null && f.p95Ms > refresh * b.maxP95Factor) pacing.push(`p95 frame ${f.p95Ms} ms > ${round(refresh * b.maxP95Factor)} ms`);
        if (over(f.longFrames, b.maxLongFrames)) pacing.push(`${f.longFrames} frames over 50 ms (max ${b.maxLongFrames})`);
      }
      if (over(sc.blockingMs, b.maxBlockingMs)) mine.push(`blocking ${sc.blockingMs} ms > ${b.maxBlockingMs} ms`);
      if (over(sc.cls, b.maxCls)) mine.push(`CLS ${sc.cls} > ${b.maxCls}`);
      const x = sc.extra || {};
      if (over(x.openScriptMs, ib.modalOpenMs)) mine.push(`modal opens in ${x.openScriptMs} ms > ${ib.modalOpenMs} ms`);
      const toggle = Math.max(x.firstToggleMs || 0, x.secondToggleMs || 0);
      if (x.firstToggleMs != null && over(toggle, ib.langToggleMs)) mine.push(`language switch ${round(toggle, 2)} ms > ${ib.langToggleMs} ms`);
      if (over(x.handlerP95Ms, ib.spotlightHandlerMs)) mine.push(`pointer handler p95 ${x.handlerP95Ms} ms > ${ib.spotlightHandlerMs} ms`);
      sc.issues = [...pacing, ...mine];
      sc.status = sc.issues.length ? 'fail' : 'pass';
      pacing.forEach((m) => add(sc.id, m, 'fail', 'pacing'));
      mine.forEach((m) => add(sc.id, m));
    });

    const maxOver = (budgets.advisories || {}).maxImageOversize;
    if (results.audit && maxOver != null) {
      results.audit.images.filter((i) => i.oversize > maxOver).forEach((i) => {
        add('images', `${i.file} is ${i.oversize}× larger than displayed (${i.natural} shown at ${i.shown}px, ${i.kb} KB)`, 'warn');
      });
    }

    results.issues = issues;
    results.summary = {
      scenarios: results.scenarios.length,
      failures: issues.filter((i) => i.level === 'fail').length,
      warnings: issues.filter((i) => i.level === 'warn').length,
    };
    return results;
  }

  /* ---- Run ---- */
  async function run({ iframe, url, budgets, ids, profile = 'custom', cpu = 1, onProgress = () => {} }) {
    const t = new Target(iframe, url);
    const wanted = ids && ids.length ? new Set(ids) : null;
    const list = SCENARIOS.filter((s) => !wanted || wanted.has(s.id));
    const ctx = { target: t, state: {}, hasLoaf: (global.PerformanceObserver.supportedEntryTypes || []).includes('long-animation-frame') };

    onProgress('Measuring display refresh…');
    const { refreshMs, throttled } = await measureRefresh();
    ctx.refreshMs = refreshMs;

    const results = {
      meta: {
        date: new Date().toISOString(),
        userAgent: navigator.userAgent,
        profile, cpu,
        refreshMs: round(refreshMs, 2),
        hz: round(1000 / refreshMs, 0),
        throttled,
        loafSupported: ctx.hasLoaf,
      },
      load: null,
      scenarios: [],
      audit: null,
    };

    let loaded = false;
    for (const s of list) {
      onProgress(`${s.label}…`);
      send({ type: 'log', message: s.id });
      if (s.load) { results.load = await runLoad(ctx); loaded = true; continue; }
      if (!loaded || s.cold) {
        await t.load();
        await sleep(2500); // past the load tail: hero reveal, lazy images near the fold
        loaded = true;
        ctx.state = {};
      }
      const r = await s.run(ctx);
      results.scenarios.push({ id: s.id, label: s.label, ...r });
    }

    if (loaded) {
      results.audit = audit(ctx);
      results.meta.viewport = { width: t.win.innerWidth, height: t.win.innerHeight, dpr: t.win.devicePixelRatio };
    }
    onProgress('Done.');
    return evaluate(results, budgets);
  }

  global.PerfHarness = { SCENARIOS, run, evaluate, send };
})(window);
