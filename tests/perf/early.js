/* Injected at document start by run.mjs (Page.addScriptToEvaluateOnNewDocument),
   so the harness can read performance entries from the very first task of a
   page load. The interactive harness falls back to buffered observers. */
(() => {
  if (window.__perfEarly || !window.PerformanceObserver) return;
  const store = (window.__perfEarly = { loaf: [], longtask: [], shift: [], lcp: [] });
  const watch = (type, key) => {
    try {
      new PerformanceObserver((list) => store[key].push(...list.getEntries())).observe({ type, buffered: true });
    } catch (e) { /* entry type not supported by this browser */ }
  };
  watch('long-animation-frame', 'loaf');
  watch('longtask', 'longtask');
  watch('layout-shift', 'shift');
  watch('largest-contentful-paint', 'lcp');
})();
