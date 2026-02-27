/**
 * content_script.js
 *
 * Injected into every page (via manifest content_scripts).
 * Listens for START_OBSERVERS / STOP_OBSERVERS / GET_METRICS messages
 * from the service worker and responds with collected PerformanceObserver data.
 */

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────────

  let active = false;
  let observers = [];

  // Raw metric accumulators
  let lcpValue = null;
  let lcpElement = null;
  let clsValue = 0;
  let clsSources = [];
  let inpValue = null;
  let fcpValue = null;
  let longTaskCount = 0;
  let longTaskTotal = 0;
  let longTaskMax = 0;

  // INP: track per-interaction worst event duration
  const interactionMap = new Map(); // interactionId → max duration

  // ── Observer setup ─────────────────────────────────────────────────────────

  function startObservers() {
    if (active) return;
    active = true;
    resetAccumulators();

    tryObserve("largest-contentful-paint", (entries) => {
      for (const entry of entries) {
        lcpValue = entry.startTime;
        lcpElement = {
          tag: entry.element ? entry.element.tagName : null,
          url: entry.url || null,
          size: entry.size || null,
          startTime: entry.startTime,
        };
      }
    });

    tryObserve("layout-shift", (entries) => {
      for (const entry of entries) {
        if (!entry.hadRecentInput) {
          clsValue += entry.value;
          clsSources.push({
            value: entry.value,
            startTime: entry.startTime,
            sources: entry.sources
              ? entry.sources.map((s) => ({
                  node: s.node ? s.node.nodeName : null,
                  currentRect: s.currentRect
                    ? {
                        top: s.currentRect.top,
                        left: s.currentRect.left,
                        width: s.currentRect.width,
                        height: s.currentRect.height,
                      }
                    : null,
                }))
              : [],
          });
        }
      }
    });

    // INP via event timing (Chrome 96+)
    tryObserve("event", (entries) => {
      for (const entry of entries) {
        if (entry.interactionId) {
          const prev = interactionMap.get(entry.interactionId) || 0;
          interactionMap.set(
            entry.interactionId,
            Math.max(prev, entry.duration)
          );
        }
      }
    }, { durationThreshold: 16 });

    // First Input fallback: use full duration per INP spec
    tryObserve("first-input", (entries) => {
      for (const entry of entries) {
        if (inpValue == null) {
          inpValue = entry.duration;
        }
      }
    });

    tryObserve("paint", (entries) => {
      for (const entry of entries) {
        if (entry.name === "first-contentful-paint" && fcpValue == null) {
          fcpValue = entry.startTime;
        }
      }
    });

    tryObserve("longtask", (entries) => {
      for (const entry of entries) {
        longTaskCount++;
        longTaskTotal += entry.duration;
        if (entry.duration > longTaskMax) longTaskMax = entry.duration;
      }
    });
  }

  function tryObserve(type, callback, options = {}) {
    try {
      const obs = new PerformanceObserver((list) => callback(list.getEntries()));
      obs.observe({ type, buffered: true, ...options });
      observers.push({ obs, callback });
    } catch (_) {
      // Observer type not supported – ignore
    }
  }

  function stopObservers() {
    active = false;
    for (const { obs, callback } of observers) {
      try {
        // Flush any buffered entries that haven't been delivered yet
        const remaining = obs.takeRecords();
        if (remaining.length > 0) callback(remaining);
        obs.disconnect();
      } catch (_) {}
    }
    observers = [];
  }

  function resetAccumulators() {
    lcpValue = null;
    lcpElement = null;
    clsValue = 0;
    clsSources = [];
    inpValue = null;
    fcpValue = null;
    longTaskCount = 0;
    longTaskTotal = 0;
    longTaskMax = 0;
    interactionMap.clear();
  }

  // ── Metric snapshot ─────────────────────────────────────────────────────────

  function getMetrics() {
    // Derive INP from interactionMap (worst 98th-percentile approximation: use max)
    let derivedInp = inpValue; // first-input fallback
    if (interactionMap.size > 0) {
      derivedInp = Math.max(...interactionMap.values());
    }

    // Top-10 individual interaction durations (sorted descending) for future INP proxy
    const interactionDurations = [...interactionMap.values()]
      .sort((a, b) => b - a)
      .slice(0, 10);

    // Navigation timing
    const navEntries = performance.getEntriesByType("navigation");
    const nav = navEntries.length > 0 ? navEntries[0] : null;
    const ttfb = nav ? nav.responseStart - nav.startTime : null;
    const dcl = nav
      ? nav.domContentLoadedEventEnd - nav.startTime
      : null;
    const load = nav ? nav.loadEventEnd - nav.startTime : null;

    // Resource timing breakdown
    const resources = performance.getEntriesByType("resource");
    const byType = {};
    const slowest = [];
    const largest = [];

    for (const r of resources) {
      const type = r.initiatorType || "other";
      if (!byType[type]) byType[type] = { type, requests: 0, bytes: 0 };
      byType[type].requests++;
      const size = r.transferSize || r.encodedBodySize || 0;
      byType[type].bytes += size;
      slowest.push({
        url: r.name,
        domain: domainOf(r.name),
        type,
        durationMs: r.duration,
        transferBytes: size,
      });
      largest.push({
        url: r.name,
        domain: domainOf(r.name),
        type,
        durationMs: r.duration,
        transferBytes: size,
      });
    }

    slowest.sort((a, b) => b.durationMs - a.durationMs);
    largest.sort((a, b) => b.transferBytes - a.transferBytes);

    const pageHostname = location.hostname;

    // Top-5 CLS shift entries by value (not insertion order)
    const topClsSources = [...clsSources]
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    return {
      lcp: lcpValue,
      lcpElement,
      cls: clsValue,
      clsSources: topClsSources,
      inp: derivedInp,
      interactionDurations,
      fcp: fcpValue,
      ttfb,
      dcl,
      load,
      longTaskCount,
      longTaskTotal,
      longTaskMax,
      resources: {
        byType: Object.values(byType),
        slowest: slowest.slice(0, 10),
        largest: largest.slice(0, 10),
        thirdParty: resources.filter(
          (r) => domainOf(r.name) && domainOf(r.name) !== pageHostname
        ).length,
      },
    };
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname;
    } catch (_) {
      return null;
    }
  }

  // ── Message handling ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "START_OBSERVERS") {
      startObservers();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "STOP_OBSERVERS") {
      stopObservers();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "GET_METRICS") {
      sendResponse({ ok: true, metrics: getMetrics() });
      return false;
    }
  });
})();
