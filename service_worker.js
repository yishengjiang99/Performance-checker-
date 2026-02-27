/**
 * service_worker.js
 *
 * MV3 Background Service Worker.
 * Handles:
 *  - CDP attach/detach via chrome.debugger
 *  - Network event aggregation
 *  - Optional CDP Tracing capture
 *  - Message passing with popup and content script
 *  - Persisting run history via chrome.storage.local
 */

"use strict";

// ── In-memory session state ────────────────────────────────────────────────────

const sessions = new Map(); // tabId → SessionState

function createSession(tabId) {
  return {
    tabId,
    startTime: Date.now(),
    coldLoad: false,
    traceEnabled: false,
    // Network aggregation
    requestsTotal: 0,
    transferredBytes: 0,
    cacheHits: 0,
    failures: [],
    domainMap: new Map(),   // domain → { requests, bytes }
    requestMap: new Map(),  // requestId → { url, domain, type, startMs }
    // Tracing
    traceChunks: [],
    traceSize: 0,
  };
}

function getSession(tabId) {
  return sessions.get(tabId) ?? null;
}

// ── Chrome debugger event listener ────────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = getSession(source.tabId);
  if (!session) return;

  switch (method) {
    case "Network.requestWillBeSent": {
      const { requestId, request, initiator, timestamp } = params;
      const domain = domainOf(request.url);
      session.requestsTotal++;
      session.requestMap.set(requestId, {
        url: request.url,
        domain,
        type: initiator?.type ?? "other",
        resourceType: params.type ?? null,  // CDP resource type (Script, Stylesheet, Image…)
        startMs: Date.now(),
        startTimestamp: timestamp ?? null,  // CDP MonotonicTime (seconds)
      });
      break;
    }

    case "Network.responseReceived": {
      const { requestId, response } = params;
      const req = session.requestMap.get(requestId);
      if (req) {
        const cached = response.fromDiskCache || response.fromPrefetchCache || response.fromServiceWorker;
        if (cached) session.cacheHits++;
        req.fromCache = !!cached;
        req.mimeType = response.mimeType ?? "";
        req.status = response.status;
        req.timing = response.timing ?? null;
      }
      break;
    }

    case "Network.loadingFinished": {
      const { requestId, encodedDataLength, timestamp } = params;
      const req = session.requestMap.get(requestId);
      if (req) {
        const bytes = encodedDataLength || 0;
        session.transferredBytes += bytes;
        const domain = req.domain ?? "unknown";
        if (!session.domainMap.has(domain)) {
          session.domainMap.set(domain, { domain, requests: 0, bytes: 0 });
        }
        const d = session.domainMap.get(domain);
        d.requests++;
        d.bytes += bytes;
        req.transferBytes = bytes;
        // Prefer CDP MonotonicTime delta for accuracy; fall back to Date.now() delta
        req.durationMs = (timestamp != null && req.startTimestamp != null)
          ? (timestamp - req.startTimestamp) * 1000
          : Date.now() - req.startMs;
      }
      break;
    }

    case "Network.loadingFailed": {
      const { requestId, errorText, type } = params;
      const req = session.requestMap.get(requestId);
      if (req) {
        session.failures.push({
          url: req.url,
          errorText: errorText ?? "unknown",
          type: type ?? req.type ?? "other",
        });
      }
      break;
    }

    case "Tracing.dataCollected": {
      if (params.value && session.traceEnabled) {
        const chunk = JSON.stringify(params.value);
        session.traceChunks.push(chunk);
        session.traceSize += chunk.length;
      }
      break;
    }

    case "Tracing.tracingComplete": {
      // Tracing finished
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  sessions.delete(source.tabId);
});

// ── Tab lifecycle: clean up sessions when tabs close or navigate ───────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessions.has(tabId)) {
    detachDebugger(tabId).catch(() => {});
    sessions.delete(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // If the tab navigates away (not a cold-load reload we triggered), clean up
  if (changeInfo.status === "loading" && sessions.has(tabId)) {
    const session = sessions.get(tabId);
    if (!session.coldLoad) {
      detachDebugger(tabId).catch(() => {});
      sessions.delete(tabId);
    }
  }
});

// ── Helper: domain extraction ──────────────────────────────────────────────────

function domainOf(url) {
  try { return new URL(url).hostname; }
  catch (_) { return null; }
}

// ── Helper: consistent tab getter (avoids relying on promise-ified callback) ──

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab);
    });
  });
}

// ── Helper: classify a request's MIME type / CDP resource type ────────────────

function classifyResourceType(resourceType, mimeType) {
  if (resourceType) {
    const rt = resourceType.toLowerCase();
    if (rt === "script") return "script";
    if (rt === "stylesheet") return "css";
    if (rt === "image" || rt === "media") return "img";
    if (rt === "font") return "font";
    if (rt === "xhr" || rt === "fetch") return "xhr/fetch";
  }
  // Fall back to MIME type
  const m = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (m.includes("javascript") || m === "application/ecmascript") return "script";
  if (m === "text/css") return "css";
  if (m.startsWith("image/") || m.startsWith("video/") || m.startsWith("audio/")) return "img";
  if (
    m.startsWith("font/") ||
    m === "application/font-woff" ||
    m === "application/font-woff2" ||
    m.includes("opentype")
  ) return "font";
  return "other";
}

// ── CDP helpers ────────────────────────────────────────────────────────────────

function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

async function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.4", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Ignore lastError – may already be detached
      resolve();
    });
  });
}

// ── Content script messaging ────────────────────────────────────────────────────

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

// Ensure content script is injected before sending messages
async function ensureContentScript(tabId) {
  // Try pinging first
  const ping = await sendToTab(tabId, { type: "GET_METRICS" });
  if (ping && ping.ok) return; // already injected
  // Inject
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_script.js"],
    });
  } catch (e) {
    throw new Error(`Cannot inject content script: ${e.message}`);
  }
}

// ── Start measurement ──────────────────────────────────────────────────────────

async function startMeasurement(tabId, { coldLoad = false, traceEnabled = false } = {}) {
  if (sessions.has(tabId)) {
    throw new Error("Measurement already active for this tab.");
  }

  // Attach debugger
  try {
    await attachDebugger(tabId);
  } catch (e) {
    throw new Error(`Failed to attach debugger: ${e.message}`);
  }


  // Create session
  const session = createSession(tabId);
  session.coldLoad = coldLoad;
  session.traceEnabled = traceEnabled;
  sessions.set(tabId, session);

  // Enable Network domain
  try {
    await cdpSend(tabId, "Network.enable", {
      maxPostDataSize: 0,
      maxResourceBufferSize: 0,
      maxTotalBufferSize: 0,
    });
  } catch (e) {
    await detachDebugger(tabId);
    sessions.delete(tabId);
    throw new Error(`Failed to enable Network: ${e.message}`);
  }

  // Start tracing if requested
  if (traceEnabled) {
    try {
      await cdpSend(tabId, "Tracing.start", {
        categories: "devtools.timeline,loading,blink.user_timing,v8.execute",
        options: "sampling-frequency=1000",
        transferMode: "ReportEvents",
      });
    } catch (_) {
      // Tracing failure is non-fatal
      session.traceEnabled = false;
    }
  }

  // Cold load: reload with cache bypass
  if (coldLoad) {
    try {
      await cdpSend(tabId, "Network.clearBrowserCache");
      await cdpSend(tabId, "Page.enable");
      await cdpSend(tabId, "Page.reload", { ignoreCache: true });
    } catch (_) {
      // Best-effort; reload manually if CDP fails
      try {
        await chrome.tabs.reload(tabId, { bypassCache: true });
      } catch (_2) {}
    }
  }

  // Ensure content script + start observers
  try {
    await ensureContentScript(tabId);
    await sendToTab(tabId, { type: "START_OBSERVERS" });
  } catch (e) {
    // Non-fatal – metrics from page context may be unavailable
    console.warn("Content script setup failed:", e.message);
  }
}

// ── Stop measurement ───────────────────────────────────────────────────────────

async function stopMeasurement(tabId) {
  const session = getSession(tabId);
  if (!session) throw new Error("No active measurement for this tab.");

  let pageMetrics = {};
  let traceInfo = { captured: false };

  try {
    // Stop observers in page context
    try {
      const resp = await sendToTab(tabId, { type: "GET_METRICS" });
      if (resp && resp.ok) pageMetrics = resp.metrics;
      await sendToTab(tabId, { type: "STOP_OBSERVERS" });
    } catch (_) {}

    // Stop tracing if active
    if (session.traceEnabled && session.traceChunks.length === 0) {
      try {
        await cdpSend(tabId, "Tracing.end");
        // Wait briefly for Tracing.tracingComplete event
        await new Promise((r) => setTimeout(r, 500));
      } catch (_) {}
    }
    if (session.traceChunks.length > 0) {
      traceInfo = {
        captured: true,
        sizeBytes: session.traceSize,
        downloadAvailable: true,
        chunks: session.traceChunks,
      };
    }
  } finally {
    // Always detach debugger and remove session, even if something above throws
    await detachDebugger(tabId);
    sessions.delete(tabId);
  }

  // Build network data from CDP-captured request info
  const tab = await getTab(tabId);
  const pageHost = domainOf(tab?.url ?? "");

  const domainList = Array.from(session.domainMap.values()).map((d) => ({
    ...d,
    thirdParty: pageHost ? d.domain !== pageHost : false,
  }));
  domainList.sort((a, b) => b.bytes - a.bytes);

  const cacheHitRate =
    session.requestsTotal > 0 ? session.cacheHits / session.requestsTotal : null;

  // Derive byType and slowest from the per-request CDP data
  const byTypeMap = {};
  const cdpRequests = [];
  for (const req of session.requestMap.values()) {
    if (req.durationMs == null) continue; // request never finished
    const type = classifyResourceType(req.resourceType, req.mimeType);
    if (!byTypeMap[type]) byTypeMap[type] = { type, requests: 0, bytes: 0 };
    byTypeMap[type].requests++;
    byTypeMap[type].bytes += req.transferBytes || 0;
    cdpRequests.push({
      url: req.url,
      domain: req.domain,
      type,
      durationMs: req.durationMs,
      transferBytes: req.transferBytes || 0,
      status: req.status ?? null,
      fromCache: req.fromCache ?? false,
    });
  }
  cdpRequests.sort((a, b) => b.durationMs - a.durationMs);

  const networkData = {
    requestsTotal: session.requestsTotal,
    transferredBytes: session.transferredBytes,
    cacheHitRate,
    failures: session.failures,
    byDomain: domainList,
    byType: Object.values(byTypeMap),
    slowest: cdpRequests.slice(0, 10),
  };

  return { pageMetrics, networkData, traceInfo };
}

// ── Message handler ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender, sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(msg, _sender, sendResponse) {
  const { type } = msg;

  if (type === "GET_STATUS") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tab ? sessions.has(tab.id) : false;
    sendResponse({ active, tabId: tab?.id });
    return;
  }

  if (type === "START") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { sendResponse({ ok: false, error: "No active tab." }); return; }

    // Check for protected pages
    if (
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("https://chrome.google.com/webstore")
    ) {
      sendResponse({ ok: false, error: "Cannot measure Chrome internal or Web Store pages." });
      return;
    }

    try {
      await startMeasurement(tab.id, { coldLoad: msg.coldLoad, traceEnabled: msg.traceEnabled });
      sendResponse({ ok: true, tabId: tab.id });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return;
  }

  if (type === "STOP") {
    const tabId = msg.tabId;
    if (!tabId) { sendResponse({ ok: false, error: "No tabId provided." }); return; }

    try {
      const { pageMetrics, networkData, traceInfo } = await stopMeasurement(tabId);
      sendResponse({ ok: true, pageMetrics, networkData, traceInfo });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return;
  }

  sendResponse({ ok: false, error: "Unknown message type." });
}
