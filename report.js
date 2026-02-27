/**
 * report.js – Aggregation utilities, thresholds, and insights engine.
 * Used by both the service worker (for network data) and popup (for rendering).
 */

// ─── Thresholds ───────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  lcp:  { good: 2500,  needs: 4000 },
  fcp:  { good: 1800,  needs: 3000 },
  inp:  { good: 200,   needs: 500  },
  cls:  { good: 0.1,   needs: 0.25 },
  ttfb: { good: 800,   needs: 1800 },
};

/**
 * Return "good" | "needs-improvement" | "poor" for a given metric value.
 * @param {string} metric
 * @param {number} value
 * @returns {"good"|"needs-improvement"|"poor"}
 */
export function rateMetric(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t || value == null || isNaN(value)) return "unknown";
  if (value <= t.good) return "good";
  if (value <= t.needs) return "needs-improvement";
  return "poor";
}

// ─── Insight generation ───────────────────────────────────────────────────────

/**
 * Generate human-readable insight strings from a RunReport.
 * @param {object} report  – partial or complete RunReport
 * @returns {string[]}
 */
export function generateInsights(report) {
  const insights = [];
  const { timings = {}, longTasks = {}, network = {}, lcpElement } = report;

  // LCP
  if (timings.lcp != null) {
    if (timings.lcp > 4000) {
      const elem = lcpElement
        ? ` (${lcpElement.tag}${lcpElement.url ? " – " + lcpElement.url : ""})`
        : "";
      insights.push(`LCP is very slow at ${Math.round(timings.lcp)}ms${elem}. Target ≤ 2500ms.`);
    } else if (timings.lcp > 2500) {
      const elem = lcpElement
        ? ` (${lcpElement.tag}${lcpElement.url ? " – " + lcpElement.url : ""})`
        : "";
      insights.push(`LCP needs improvement: ${Math.round(timings.lcp)}ms${elem}. Target ≤ 2500ms.`);
    }
  }

  // INP / Long tasks
  if (timings.inp != null && timings.inp > 200) {
    insights.push(
      `INP is ${Math.round(timings.inp)}ms – user interactions may feel sluggish. Target ≤ 200ms.`
    );
  }
  if (longTasks.totalMs != null && longTasks.totalMs > 200) {
    insights.push(
      `Main thread blocked for ${Math.round(longTasks.totalMs)}ms across ${longTasks.count} long task(s) (max ${Math.round(longTasks.maxMs)}ms). This hurts responsiveness.`
    );
  }

  // CLS
  if (timings.cls != null && timings.cls > 0.1) {
    const severity = timings.cls > 0.25 ? "poor" : "needs improvement";
    insights.push(
      `Layout instability detected: CLS = ${timings.cls.toFixed(3)} (${severity}). Target ≤ 0.1.`
    );
  }

  // TTFB
  if (timings.ttfb != null && timings.ttfb > 800) {
    insights.push(
      `Server response is slow: TTFB = ${Math.round(timings.ttfb)}ms. Consider server-side improvements. Target ≤ 800ms.`
    );
  }

  // Network weight
  if (network.transferredBytes != null && network.transferredBytes > 2 * 1024 * 1024) {
    insights.push(
      `Heavy page: ${formatBytes(network.transferredBytes)} transferred. Consider reducing JS/image size.`
    );
  }
  if (network.requestsTotal != null && network.requestsTotal > 150) {
    insights.push(
      `High request count: ${network.requestsTotal} requests. Reducing requests improves load time.`
    );
  }

  // 3rd-party impact
  if (network.byDomain) {
    const totalBytes = network.byDomain.reduce((s, d) => s + d.bytes, 0);
    const thirdBytes = network.byDomain
      .filter(d => d.thirdParty)
      .reduce((s, d) => s + d.bytes, 0);
    if (totalBytes > 0 && thirdBytes / totalBytes > 0.3) {
      insights.push(
        `Third-party resources account for ${Math.round((thirdBytes / totalBytes) * 100)}% of transferred bytes (${formatBytes(thirdBytes)}). Review third-party scripts.`
      );
    }
  }

  // Cache
  if (
    network.cacheHitRate != null &&
    network.requestsTotal > 5 &&
    network.cacheHitRate < 0.3
  ) {
    insights.push(
      `Cache hit rate is low (${Math.round(network.cacheHitRate * 100)}%). Improve caching headers on static assets.`
    );
  }

  // Failed requests
  if (network.failures && network.failures.length > 0) {
    insights.push(
      `${network.failures.length} failed network request(s) detected. Check the Network tab for details.`
    );
  }

  return insights;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format milliseconds with one decimal place.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (ms == null || isNaN(ms)) return "–";
  return `${Math.round(ms)} ms`;
}

// ─── RunReport schema builder ─────────────────────────────────────────────────

/**
 * Build a complete RunReport from collected data parts.
 * @param {object} meta
 * @param {object} pageMetrics   – from content script
 * @param {object} networkData   – from service worker CDP aggregation
 * @param {object} traceInfo     – optional
 * @returns {object}  RunReport
 */
export function buildRunReport(meta, pageMetrics, networkData, traceInfo) {
  const timings = {
    ttfb: pageMetrics.ttfb ?? null,
    fcp:  pageMetrics.fcp  ?? null,
    lcp:  pageMetrics.lcp  ?? null,
    inp:  pageMetrics.inp  ?? null,
    cls:  pageMetrics.cls  ?? null,
    dcl:  pageMetrics.dcl  ?? null,
    load: pageMetrics.load ?? null,
  };

  const longTasks = {
    count:   pageMetrics.longTaskCount   ?? 0,
    totalMs: pageMetrics.longTaskTotal   ?? 0,
    maxMs:   pageMetrics.longTaskMax     ?? 0,
  };

  const network = {
    requestsTotal:    networkData.requestsTotal    ?? 0,
    transferredBytes: networkData.transferredBytes ?? 0,
    cacheHitRate:     networkData.cacheHitRate     ?? null,
    failures:         networkData.failures         ?? [],
    byDomain:         networkData.byDomain         ?? [],
    byType:           networkData.byType           ?? [],
    slowest:          networkData.slowest          ?? [],
  };

  const report = {
    meta,
    timings,
    longTasks,
    network,
    resources: pageMetrics.resources ?? {},
    lcpElement: pageMetrics.lcpElement ?? null,
    clsSources: pageMetrics.clsSources ?? [],
    insights: [],
    trace: traceInfo ?? { captured: false },
  };

  report.insights = generateInsights(report);
  return report;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const MAX_HISTORY = 10;

/**
 * Save a RunReport to chrome.storage.local, keyed by origin.
 * Keeps the last MAX_HISTORY reports per origin.
 * @param {object} report
 * @returns {Promise<void>}
 */
export async function saveReport(report) {
  const origin = report.meta.origin;
  const key = `history:${origin}`;
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (result) => {
      const history = result[key] ?? [];
      history.unshift(report);
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
      chrome.storage.local.set({ [key]: history }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  });
}

/**
 * Load saved reports for an origin.
 * @param {string} origin
 * @returns {Promise<object[]>}
 */
export async function loadHistory(origin) {
  const key = `history:${origin}`;
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] ?? []);
    });
  });
}
