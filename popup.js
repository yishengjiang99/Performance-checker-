/**
 * popup.js
 *
 * Handles popup UI logic:
 *  - Start/Stop button wiring
 *  - Message passing with service worker
 *  - Rendering report (scorecard, timeline, insights, tables)
 *  - Export JSON
 *  - History panel
 */

"use strict";

// ── Inline report utilities (mirrors report.js without ES module imports) ──────

const THRESHOLDS = {
  lcp:  { good: 2500,  needs: 4000 },
  fcp:  { good: 1800,  needs: 3000 },
  inp:  { good: 200,   needs: 500  },
  cls:  { good: 0.1,   needs: 0.25 },
  ttfb: { good: 800,   needs: 1800 },
};

function rateMetric(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t || value == null || isNaN(value)) return "neutral";
  if (value <= t.good) return "good";
  if (value <= t.needs) return "needs";
  return "poor";
}

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms) {
  if (ms == null || isNaN(ms)) return "–";
  return `${Math.round(ms)}`;
}

function generateInsights(report) {
  const insights = [];
  const { timings = {}, longTasks = {}, network = {}, lcpElement } = report;

  if (timings.lcp != null) {
    if (timings.lcp > 4000) {
      const elem = lcpElement
        ? ` (${lcpElement.tag}${lcpElement.url ? " – " + lcpElement.url : ""})`
        : "";
      insights.push({ cls: "poor", text: `LCP is very slow: ${Math.round(timings.lcp)}ms${elem}. Target ≤ 2500ms.` });
    } else if (timings.lcp > 2500) {
      const elem = lcpElement
        ? ` (${lcpElement.tag}${lcpElement.url ? " – " + lcpElement.url : ""})`
        : "";
      insights.push({ cls: "needs", text: `LCP needs improvement: ${Math.round(timings.lcp)}ms${elem}. Target ≤ 2500ms.` });
    }
  }
  if (timings.inp != null && timings.inp > 200) {
    insights.push({ cls: "poor", text: `INP is ${Math.round(timings.inp)}ms – interactions feel sluggish. Target ≤ 200ms.` });
  }
  if (longTasks.totalMs != null && longTasks.totalMs > 200) {
    insights.push({ cls: "poor", text: `Main thread blocked ${Math.round(longTasks.totalMs)}ms across ${longTasks.count} long task(s) (max ${Math.round(longTasks.maxMs)}ms).` });
  }
  if (timings.cls != null && timings.cls > 0.1) {
    insights.push({ cls: timings.cls > 0.25 ? "poor" : "needs", text: `Layout instability: CLS = ${timings.cls.toFixed(3)}. Target ≤ 0.1.` });
  }
  if (timings.ttfb != null && timings.ttfb > 800) {
    insights.push({ cls: "needs", text: `Slow server response: TTFB = ${Math.round(timings.ttfb)}ms. Target ≤ 800ms.` });
  }
  if (network.transferredBytes != null && network.transferredBytes > 2 * 1024 * 1024) {
    insights.push({ cls: "poor", text: `Heavy page: ${formatBytes(network.transferredBytes)} transferred. Reduce JS/image size.` });
  }
  if (network.requestsTotal != null && network.requestsTotal > 150) {
    insights.push({ cls: "poor", text: `High request count: ${network.requestsTotal} requests. Fewer requests = faster loads.` });
  }
  if (network.byDomain) {
    const totalBytes = network.byDomain.reduce((s, d) => s + d.bytes, 0);
    const thirdBytes = network.byDomain.filter(d => d.thirdParty).reduce((s, d) => s + d.bytes, 0);
    if (totalBytes > 0 && thirdBytes / totalBytes > 0.3) {
      insights.push({ cls: "needs", text: `Third-party resources: ${Math.round(thirdBytes / totalBytes * 100)}% of bytes (${formatBytes(thirdBytes)}).` });
    }
  }
  if (network.cacheHitRate != null && network.requestsTotal > 5 && network.cacheHitRate < 0.3) {
    insights.push({ cls: "needs", text: `Low cache hit rate: ${Math.round(network.cacheHitRate * 100)}%. Improve caching headers.` });
  }
  if (network.failures && network.failures.length > 0) {
    insights.push({ cls: "poor", text: `${network.failures.length} failed request(s) detected.` });
  }
  if (insights.length === 0) {
    insights.push({ cls: "good", text: "Page performance looks good! All key metrics are within recommended thresholds." });
  }
  return insights;
}

function buildRunReport(meta, pageMetrics, networkData, traceInfo) {
  const timings = {
    ttfb: pageMetrics.ttfb  ?? null,
    fcp:  pageMetrics.fcp   ?? null,
    lcp:  pageMetrics.lcp   ?? null,
    inp:  pageMetrics.inp   ?? null,
    cls:  pageMetrics.cls   ?? null,
    dcl:  pageMetrics.dcl   ?? null,
    load: pageMetrics.load  ?? null,
  };
  const longTasks = {
    count:   pageMetrics.longTaskCount ?? 0,
    totalMs: pageMetrics.longTaskTotal ?? 0,
    maxMs:   pageMetrics.longTaskMax   ?? 0,
  };
  const network = {
    requestsTotal:    networkData.requestsTotal    ?? 0,
    transferredBytes: networkData.transferredBytes ?? 0,
    cacheHitRate:     networkData.cacheHitRate     ?? null,
    failures:         networkData.failures         ?? [],
    byDomain:         networkData.byDomain         ?? [],
    byType:           pageMetrics.resources?.byType ?? [],
    slowest:          pageMetrics.resources?.slowest ?? [],
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

// ── DOM refs ───────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const urlBadge       = $("url-badge");
const coldToggle     = $("cold-load-toggle");
const traceToggle    = $("trace-toggle");
const btnStart       = $("btn-start");
const btnStop        = $("btn-stop");
const statusMsg      = $("status-msg");
const resultsSection = $("results");
const scorecardEl    = $("scorecard");
const timelineBar    = $("timeline-bar");
const timelineLabels = $("timeline-labels");
const insightsList   = $("insights-list");
const btnExport      = $("btn-export");
const btnHistory     = $("btn-history");
const historyPanel   = $("history-panel");
const btnHistBack    = $("btn-history-back");
const historyList    = $("history-list");
const deltaSection   = $("delta-section");
const scorecardDelta = $("scorecard-delta");
const traceNotice    = $("trace-notice");

// ── State ──────────────────────────────────────────────────────────────────────

let activeTabId = null;
let currentReport = null;
let currentOrigin = null;

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    activeTabId = tab.id;
    const origin = getOrigin(tab.url);
    currentOrigin = origin;
    urlBadge.textContent = origin || tab.url;
    urlBadge.title = tab.url;
  }

  // Check if a measurement is already running
  const status = await sendMessage({ type: "GET_STATUS" });
  if (status && status.active) {
    setRunning(true);
    setStatus("Measurement in progress…");
  }
}

function getOrigin(url) {
  try { return new URL(url).origin; }
  catch (_) { return url; }
}

// ── Buttons ────────────────────────────────────────────────────────────────────

btnStart.addEventListener("click", async () => {
  setStatus("Starting…");
  btnStart.disabled = true;

  const resp = await sendMessage({
    type: "START",
    coldLoad: coldToggle.checked,
    traceEnabled: traceToggle.checked,
  });

  if (!resp || !resp.ok) {
    setStatus(resp?.error ?? "Failed to start.", true);
    btnStart.disabled = false;
    return;
  }

  activeTabId = resp.tabId;
  setRunning(true);
  setStatus(coldToggle.checked ? "Cold load in progress…" : "Measuring… click Stop when done.");
});

btnStop.addEventListener("click", async () => {
  if (!activeTabId) { setStatus("No active tab.", true); return; }

  setStatus("Collecting results…");
  btnStop.disabled = true;

  const resp = await sendMessage({ type: "STOP", tabId: activeTabId });

  setRunning(false);

  if (!resp || !resp.ok) {
    setStatus(resp?.error ?? "Failed to stop.", true);
    return;
  }

  setStatus("");

  // Build report
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const meta = {
    url:          tab?.url ?? "",
    origin:       getOrigin(tab?.url ?? ""),
    timestamp:    new Date().toISOString(),
    userAgent:    navigator.userAgent,
    coldLoad:     coldToggle.checked,
    traceEnabled: traceToggle.checked,
  };

  currentOrigin = meta.origin;
  const report = buildRunReport(meta, resp.pageMetrics ?? {}, resp.networkData ?? {}, resp.traceInfo);
  currentReport = report;

  // Save to history
  await saveReport(report);

  // Load previous run for delta
  const history = await loadHistory(meta.origin);
  const prevReport = history.length > 1 ? history[1] : null;

  renderReport(report, prevReport);
});

// ── Render report ──────────────────────────────────────────────────────────────

function renderReport(report, prevReport) {
  resultsSection.classList.remove("hidden");

  renderScorecard(report, prevReport);
  renderTimeline(report.timings);
  renderInsights(report.insights);
  renderByType(report.network.byType ?? report.resources?.byType ?? []);
  renderDomains(report.network.byDomain);
  renderSlowest(report.network.slowest ?? report.resources?.slowest ?? []);
  renderTraceNotice(report.trace);

  btnExport.onclick = () => exportJSON(report);
}

// ── Scorecard ──────────────────────────────────────────────────────────────────

const SCORECARD_TILES = [
  { key: "lcp",  label: "LCP",    unit: "ms",  fmt: v => formatMs(v) },
  { key: "inp",  label: "INP",    unit: "ms",  fmt: v => formatMs(v) },
  { key: "cls",  label: "CLS",    unit: "",    fmt: v => (v == null ? "–" : v.toFixed(3)) },
  { key: "ttfb", label: "TTFB",   unit: "ms",  fmt: v => formatMs(v) },
  { key: "fcp",  label: "FCP",    unit: "ms",  fmt: v => formatMs(v) },
  { key: "load", label: "Load",   unit: "ms",  fmt: v => formatMs(v), noRate: true },
  {
    key: "requests",
    label: "Requests", unit: "",
    fmt: (_, r) => String(r.network.requestsTotal || "–"),
    noRate: true,
  },
  {
    key: "transferred",
    label: "Transferred", unit: "",
    fmt: (_, r) => formatBytes(r.network.transferredBytes),
    noRate: true,
  },
  {
    key: "longTasks",
    label: "Long Tasks", unit: "ms",
    fmt: (_, r) => r.longTasks.totalMs ? `${Math.round(r.longTasks.totalMs)}` : "0",
    noRate: true,
  },
];

function renderScorecard(report, prevReport) {
  scorecardEl.innerHTML = "";
  for (const tile of SCORECARD_TILES) {
    const value = tile.key in report.timings
      ? report.timings[tile.key]
      : null;
    const display = tile.fmt(value, report);
    const rating = tile.noRate ? "neutral" : rateMetric(tile.key, value);

    let deltaHtml = "";
    if (prevReport && !tile.noRate && value != null) {
      const prevVal = prevReport.timings[tile.key];
      if (prevVal != null) {
        const diff = value - prevVal;
        // For CLS, lower is better; for LCP/INP etc. lower is better too
        const better = diff < 0;
        const diffStr = (diff > 0 ? "+" : "") + (tile.key === "cls" ? diff.toFixed(3) : Math.round(diff) + " ms");
        deltaHtml = `<span class="tile-delta ${better ? "better" : "worse"}">${diffStr}</span>`;
      }
    }

    scorecardEl.insertAdjacentHTML("beforeend", `
      <div class="tile ${rating}">
        <div class="tile-label">${tile.label}</div>
        <div class="tile-value">${display}${tile.unit ? `<span class="tile-unit"> ${tile.unit}</span>` : ""}</div>
        ${deltaHtml}
      </div>
    `);
  }
}

// ── Timeline ───────────────────────────────────────────────────────────────────

const TIMELINE_MARKERS = [
  { key: "ttfb", label: "TTFB", color: "#6c63ff" },
  { key: "fcp",  label: "FCP",  color: "#00bcd4" },
  { key: "lcp",  label: "LCP",  color: "#ff9800" },
  { key: "load", label: "Load", color: "#4caf50" },
];

function renderTimeline(timings) {
  timelineBar.innerHTML = "";
  timelineLabels.innerHTML = "";

  const maxVal = Math.max(
    ...[timings.load, timings.lcp, 100].filter(v => v != null && v > 0)
  );

  for (const m of TIMELINE_MARKERS) {
    const val = timings[m.key];
    if (val == null || val <= 0) continue;
    const pct = Math.min(100, (val / maxVal) * 100);
    timelineBar.insertAdjacentHTML("beforeend",
      `<div class="timeline-marker" style="left:${pct}%;background:${m.color}" title="${m.label}: ${Math.round(val)}ms"></div>`
    );
    timelineLabels.insertAdjacentHTML("beforeend",
      `<span class="timeline-lbl" style="left:${pct}%;color:${m.color}">${m.label}<br>${Math.round(val)}ms</span>`
    );
  }
}

// ── Insights ───────────────────────────────────────────────────────────────────

function renderInsights(insights) {
  insightsList.innerHTML = "";
  for (const ins of insights) {
    const cls = typeof ins === "object" ? ins.cls : "needs";
    const text = typeof ins === "object" ? ins.text : ins;
    insightsList.insertAdjacentHTML("beforeend", `<li class="${cls}">${escHtml(text)}</li>`);
  }
}

// ── Tables ─────────────────────────────────────────────────────────────────────

function renderByType(byType) {
  const tbody = document.querySelector("#tbl-by-type tbody");
  tbody.innerHTML = "";
  if (!byType || byType.length === 0) {
    tbody.insertAdjacentHTML("beforeend", `<tr><td colspan="3" style="color:var(--text2)">No data</td></tr>`);
    return;
  }
  const sorted = [...byType].sort((a, b) => b.bytes - a.bytes);
  for (const row of sorted) {
    tbody.insertAdjacentHTML("beforeend",
      `<tr><td>${escHtml(row.type)}</td><td>${row.requests}</td><td>${formatBytes(row.bytes)}</td></tr>`
    );
  }
}

function renderDomains(byDomain) {
  const tbody = document.querySelector("#tbl-domains tbody");
  tbody.innerHTML = "";
  if (!byDomain || byDomain.length === 0) {
    tbody.insertAdjacentHTML("beforeend", `<tr><td colspan="4" style="color:var(--text2)">No data</td></tr>`);
    return;
  }
  const sorted = [...byDomain].sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  for (const row of sorted) {
    tbody.insertAdjacentHTML("beforeend",
      `<tr>
        <td title="${escHtml(row.domain)}">${escHtml(row.domain)}</td>
        <td>${row.requests}</td>
        <td>${formatBytes(row.bytes)}</td>
        <td>${row.thirdParty ? '<span class="tag-3p">3P</span>' : ""}</td>
      </tr>`
    );
  }
}

function renderSlowest(slowest) {
  const tbody = document.querySelector("#tbl-slowest tbody");
  tbody.innerHTML = "";
  if (!slowest || slowest.length === 0) {
    tbody.insertAdjacentHTML("beforeend", `<tr><td colspan="4" style="color:var(--text2)">No data</td></tr>`);
    return;
  }
  for (const row of slowest) {
    const shortUrl = row.url ? row.url.split("/").pop().slice(0, 40) || row.url.slice(-40) : "–";
    tbody.insertAdjacentHTML("beforeend",
      `<tr>
        <td title="${escHtml(row.url)}">${escHtml(shortUrl)}</td>
        <td>${escHtml(row.type ?? "–")}</td>
        <td>${formatMs(row.durationMs)} ms</td>
        <td>${formatBytes(row.transferBytes)}</td>
      </tr>`
    );
  }
}

// ── Trace notice ───────────────────────────────────────────────────────────────

function renderTraceNotice(trace) {
  if (!trace || !trace.captured) {
    traceNotice.classList.add("hidden");
    return;
  }
  traceNotice.classList.remove("hidden");
  traceNotice.innerHTML = `📊 Trace captured (${formatBytes(trace.sizeBytes)}). <button id="btn-dl-trace" class="btn btn-secondary btn-sm">⬇ Download Trace</button>`;
  document.getElementById("btn-dl-trace").onclick = () => {
    if (trace.chunks) {
      const blob = new Blob(
        [`{"traceEvents":[${trace.chunks.join(",")}]}`],
        { type: "application/json" }
      );
      downloadBlob(blob, "trace.json");
    }
  };
}

// ── History ────────────────────────────────────────────────────────────────────

btnHistory.addEventListener("click", async () => {
  resultsSection.classList.add("hidden");
  historyPanel.classList.remove("hidden");
  renderHistory();
});

btnHistBack.addEventListener("click", () => {
  historyPanel.classList.add("hidden");
  if (currentReport) resultsSection.classList.remove("hidden");
});

async function renderHistory() {
  historyList.innerHTML = "";
  if (!currentOrigin) {
    historyList.textContent = "No origin detected.";
    return;
  }
  const history = await loadHistory(currentOrigin);
  if (history.length === 0) {
    historyList.textContent = "No saved runs for this origin.";
    return;
  }
  for (let i = 0; i < history.length; i++) {
    const r = history[i];
    const lcp = r.timings?.lcp != null ? `LCP ${Math.round(r.timings.lcp)}ms` : "";
    const cls = r.timings?.cls != null ? `CLS ${r.timings.cls.toFixed(3)}` : "";
    const bytes = r.network?.transferredBytes != null ? formatBytes(r.network.transferredBytes) : "";
    historyList.insertAdjacentHTML("beforeend", `
      <div class="history-item" data-idx="${i}">
        <div class="hist-time">${new Date(r.meta.timestamp).toLocaleString()}</div>
        <div>${[lcp, cls, bytes].filter(Boolean).join(" · ")}</div>
      </div>
    `);
  }
  historyList.querySelectorAll(".history-item").forEach(el => {
    el.addEventListener("click", async () => {
      const idx = parseInt(el.dataset.idx, 10);
      const history = await loadHistory(currentOrigin);
      const r = history[idx];
      const prev = history[idx + 1] ?? null;
      currentReport = r;
      historyPanel.classList.add("hidden");
      renderReport(r, prev);
    });
  });
}

// ── Storage helpers ─────────────────────────────────────────────────────────────

const MAX_HISTORY = 10;

function saveReport(report) {
  const origin = report.meta.origin;
  const key = `history:${origin}`;
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      const history = result[key] ?? [];
      // Strip trace chunks to save space
      const toSave = { ...report, trace: { captured: report.trace?.captured, sizeBytes: report.trace?.sizeBytes } };
      history.unshift(toSave);
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
      chrome.storage.local.set({ [key]: history }, resolve);
    });
  });
}

function loadHistory(origin) {
  const key = `history:${origin}`;
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key] ?? []));
  });
}

// ── Export ─────────────────────────────────────────────────────────────────────

function exportJSON(report) {
  const exportable = { ...report };
  // Omit large trace chunks from export if they're separate
  if (exportable.trace && exportable.trace.chunks) {
    exportable.trace = { ...exportable.trace };
    delete exportable.trace.chunks;
    exportable.trace.note = "Trace chunks omitted from JSON export; use Download Trace button.";
  }
  const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: "application/json" });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadBlob(blob, `perf-report-${ts}.json`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

function setRunning(running) {
  btnStart.disabled = running;
  btnStop.disabled  = !running;
  coldToggle.disabled = running;
  traceToggle.disabled = running;
}

function setStatus(msg, isError = false) {
  statusMsg.textContent = msg;
  statusMsg.className = "status-msg" + (isError ? " error" : "");
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

init().catch(e => setStatus(`Init error: ${e.message}`, true));
