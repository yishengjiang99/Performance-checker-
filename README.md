# Performance Checker — Chrome Extension

A **Manifest V3** Chrome Extension that measures page performance on-demand. Click **Start**, interact with the page, click **Stop** — and get a complete performance report including LCP, INP, CLS, TTFB, FCP, network breakdowns, and actionable insights.

---

## Features

- **Scorecard:** LCP / INP / CLS / TTFB / FCP / Requests / Transferred / Long Tasks
- **Timeline bar:** TTFB → FCP → LCP → Load
- **Insights engine:** Automatic human-readable diagnostics
- **Network breakdown:** Requests by type/domain, slowest resources, 3rd-party impact
- **Cold load toggle:** Reload page with cache bypass for a fresh measurement
- **Trace capture toggle:** Capture a CDP trace (downloadable as JSON for DevTools)
- **Export JSON:** Download the full `RunReport` as JSON
- **Run history:** Last 10 runs per origin, with delta comparison to previous run
- **Local only:** No data ever leaves your browser

---

## File structure

```
Performance-checker-/
├── manifest.json          # MV3 manifest
├── service_worker.js      # Background service worker (CDP, network events, messaging)
├── content_script.js      # Page-context PerformanceObserver metrics
├── report.js              # Aggregation utilities, thresholds, insights (ES module)
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic and rendering
├── popup.css              # Popup styling
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Local development

### Requirements

- Google Chrome (v105+)
- No build step required — vanilla JavaScript, no bundler

### Load the extension

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this repository folder.
5. Pin the extension by clicking the puzzle-piece icon → pin **Performance Checker**.

### Use the extension

1. Navigate to any HTTPS page (e.g. `https://example.com`).
2. Click the **Performance Checker** icon in the toolbar.
3. *(Optional)* Check **Cold load** to reload with cache bypass, or **Capture trace** to record a CDP trace.
4. Click **▶ Start**.
5. Interact with the page (scroll, click, etc.) to capture INP/CLS data.
6. Click **■ Stop**.
7. View the scorecard, timeline, insights, and tables.
8. Click **⬇ Export JSON** to download the full report.

### Notes on Cold load

The Cold load toggle calls `chrome.tabs.reload({ bypassCache: true })` (and attempts `Network.clearBrowserCache` via CDP). **Limitation:** The extension attaches the debugger *before* the reload, so all network requests during the cold load are captured. However, the content script will be re-injected after the page loads, so there may be a brief window where observer setup is delayed.

### Notes on Trace capture

When **Capture trace** is enabled, the extension starts a CDP `Tracing.start` session with categories `devtools.timeline, loading, blink.user_timing, v8.execute`. After stop, the trace is available for download as a `trace.json` file that can be loaded in `chrome://tracing` or the **Performance** tab of DevTools.

---

## Architecture

### Message passing

| From → To                       | Message type       | Purpose                                 |
|----------------------------------|--------------------|-----------------------------------------|
| Popup → Service worker           | `START`            | Begin measurement (attach debugger)     |
| Popup → Service worker           | `STOP`             | End measurement, return raw data        |
| Popup → Service worker           | `GET_STATUS`       | Check if a session is active            |
| Service worker → Content script  | `START_OBSERVERS`  | Start PerformanceObserver in page       |
| Service worker → Content script  | `STOP_OBSERVERS`   | Disconnect observers                    |
| Service worker → Content script  | `GET_METRICS`      | Collect accumulated metrics snapshot    |

### Metrics collected

#### A) Page context (PerformanceObserver + Navigation Timing)

| Metric    | Source                                        |
|-----------|-----------------------------------------------|
| LCP       | `largest-contentful-paint` observer           |
| CLS       | `layout-shift` observer (ignores recent input)|
| INP       | `event` observer (interactionId aggregation)  |
| FCP       | `paint` observer, `first-contentful-paint`    |
| TTFB      | `navigation` entry: `responseStart - startTime` |
| DCL       | `navigation` entry: `domContentLoadedEventEnd - startTime` |
| Load      | `navigation` entry: `loadEventEnd - startTime` |
| Long tasks| `longtask` observer (count, total, max)       |

#### B) Network (CDP)

| Metric            | CDP event                          |
|-------------------|------------------------------------|
| Total requests    | `Network.requestWillBeSent`        |
| Transferred bytes | `Network.loadingFinished.encodedDataLength` |
| Cache hits        | `Network.responseReceived` flags   |
| Failures          | `Network.loadingFailed`            |
| Per-domain totals | Aggregated from above              |

#### C) Resource Timing (page context)

Collected from `performance.getEntriesByType('resource')`:
- Requests by `initiatorType`
- Top 10 slowest by duration
- Top 10 largest by transfer size
- 3rd-party resource count

---

## Permissions justification

| Permission    | Why it's needed                                                       |
|---------------|-----------------------------------------------------------------------|
| `activeTab`   | Access the currently active tab's URL and tab ID                      |
| `scripting`   | Inject content script to collect PerformanceObserver metrics          |
| `storage`     | Persist run history locally (no server involved)                      |
| `tabs`        | Query the active tab, reload with cache bypass                        |
| `debugger`    | Attach CDP to access `Network.*` events (byte counts, timing, failures) and `Tracing.*` for main-thread profiling. This is the only way to get accurate network byte counts; Resource Timing API has cross-origin size restrictions. |
| `<all_urls>`  | Performance measurement must work on any site the user visits. Without broad host permissions the extension cannot attach the debugger to arbitrary pages. |

---

## Chrome Web Store deployment

### 1. Ensure MV3 compliance

- `manifest.json` uses `"manifest_version": 3`
- `service_worker.js` is the background service worker (no persistent background pages)
- No remotely hosted code

### 2. Prepare assets

Replace placeholder icons in `icons/` with proper PNG icons (16×16, 32×32, 48×48, 128×128).

Verify `manifest.json` fields:
- `name`, `version`, `description`, `permissions`, `host_permissions`, `action.icons`

### 3. Package the extension

```bash
# From the repository root — exclude git artifacts and any build artifacts
zip -r performance-checker.zip . \
  --exclude "*.git*" \
  --exclude "*.DS_Store" \
  --exclude "node_modules/*"
```

### 4. Create a Chrome Web Store developer account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with a Google account.
3. Pay the one-time $5 developer registration fee (if not already registered).

### 5. Create a new item

1. Click **New item** → Upload `performance-checker.zip`.
2. Fill in the listing:
   - **Name:** Performance Checker
   - **Summary:** Measure real page performance: LCP, INP, CLS, TTFB, network, and insights.
   - **Category:** Developer Tools
   - **Language:** English
   - **Screenshots:** At least one 1280×800 or 640×400 screenshot of the popup with a report.
   - **Privacy policy URL:** A simple hosted policy stating "no data collection" suffices.

### 6. Declare data practices

In the **Privacy practices** tab:
- Select: "This item does not collect user data."
- Justify the `debugger` permission (Step 7).

### 7. Justify the `debugger` permission

In the **Permission justification** field, state:

> The `debugger` permission is required to access the Chrome DevTools Protocol (CDP) `Network` domain. This is the only way to obtain accurate per-request byte counts (`encodedDataLength`), cache status (`fromDiskCache`, `fromServiceWorker`), and detailed timing for all network requests — including cross-origin resources where the Resource Timing API returns zero for security reasons. The `Tracing` domain is used optionally when the user enables trace capture. The debugger is attached only when the user explicitly clicks Start and is always detached when Stop is clicked or if any error occurs. No CDP data is transmitted outside the user's browser.

### 8. Submit for review

Click **Submit for review**. Typical review time: 1–3 business days.

Common reviewer notes to prepare for:
- **Permission minimization:** Be ready to justify `debugger` and `<all_urls>` as described above.
- **Injection constraints:** Confirm you handle `chrome://` and Web Store pages gracefully (the extension shows a clear error for these).
- **Privacy:** Confirm no remote data transmission.

### 9. After approval

- Click **Publish** (public or unlisted).
- Share the store link.

### 10. Version updates

1. Increment `version` in `manifest.json` (e.g. `"1.0.1"`).
2. Re-zip: `zip -r performance-checker.zip . --exclude "*.git*"`
3. In the Developer Dashboard, click your item → **Package** → **Upload new package**.
4. Submit for review.

---

## RunReport JSON schema

```jsonc
{
  "meta": {
    "url": "https://example.com/page",
    "origin": "https://example.com",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "userAgent": "Mozilla/5.0 ...",
    "coldLoad": false,
    "traceEnabled": false
  },
  "timings": {
    "ttfb": 210,     // responseStart - startTime (ms)
    "fcp": 800,      // first-contentful-paint (ms)
    "lcp": 1500,     // largest-contentful-paint (ms)
    "inp": 120,      // worst interaction duration (ms)
    "cls": 0.05,     // cumulative layout shift score
    "dcl": 950,      // domContentLoadedEventEnd - startTime (ms)
    "load": 1200     // loadEventEnd - startTime (ms)
  },
  "longTasks": {
    "count": 3,
    "totalMs": 180,
    "maxMs": 90
  },
  "network": {
    "requestsTotal": 42,
    "transferredBytes": 512000,
    "cacheHitRate": 0.6,
    "failures": [{ "url": "...", "errorText": "net::ERR_BLOCKED", "type": "Script" }],
    "byDomain": [{ "domain": "cdn.example.com", "requests": 10, "bytes": 200000, "thirdParty": false }],
    "byType": [{ "type": "script", "requests": 8, "bytes": 150000 }],
    "slowest": [{ "url": "...", "domain": "...", "type": "script", "durationMs": 1200, "transferBytes": 80000 }]
  },
  "resources": {},
  "lcpElement": { "tag": "IMG", "url": "https://example.com/hero.jpg", "size": 120000, "startTime": 1500 },
  "clsSources": [{ "value": 0.03, "startTime": 400, "sources": [] }],
  "insights": ["LCP needs improvement: 2800ms (IMG). Target <= 2500ms."],
  "trace": { "captured": false }
}
```

---

## Privacy

All data is stored **locally** in `chrome.storage.local` only. No data is ever sent to any server. The extension has no analytics, no telemetry, no remote code.
