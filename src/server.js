import http from "node:http";
import { readFileQuietly } from "./utils.js";
import {
  appendHistory,
  buildViewState,
  deriveRecordMetrics,
  ensureProviderState,
  ensureRecord,
  persist,
  setAutoProbePaused,
} from "./state.js";
import { probeModel } from "./probe.js";

function send(res, status, contentType, body) {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function analyticsWindowMsFromUrl(url) {
  const raw = Number(url.searchParams.get("windowMinutes") || 24 * 60);
  const minutes = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 366 * 24 * 60) : 24 * 60;
  return minutes * 60_000;
}

// ── Dashboard HTML ─────────────────────────────────────────────────────────

function renderDashboard(state) {
  const providerOptions = Object.values(state.providers || {})
    .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    .map((p) => `<option value="${esc(p.id)}">${esc(p.label || p.id)}</option>`)
    .join("");

  const statusOptions = [
    "ok", "rate_limited", "timeout", "network_error", "upstream_error",
    "bad_response", "needs_more_tokens", "pending_probe", "client_required",
    "access_locked", "out_of_credits", "not_listed", "non_chat_endpoint",
    "auth_error", "unknown_model", "error",
  ].map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

  const title = esc(state.title || "AI API Monitor");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 20px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: end; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 24px; }
    a { color: inherit; }
    .muted { opacity: .72; }
    .controls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 18px; align-items: center; }
    input, select, button { font: inherit; min-height: 34px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: Canvas; color: CanvasText; border-radius: 6px; padding: 5px 9px; }
    button { cursor: pointer; }
    button:disabled { cursor: wait; opacity: .65; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); vertical-align: top; }
    th { position: sticky; top: 0; background: Canvas; z-index: 1; }
    th button { min-height: 0; border: 0; padding: 0; font-weight: 700; background: transparent; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .summary { display: inline-flex; gap: 6px; margin: 4px 8px 4px 0; padding: 4px 8px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 999px; }
    .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-weight: 700; white-space: nowrap; }
    .ok { background: #127a3a; color: white; }
    .warn { background: #9a6700; color: white; }
    .locked { background: #d97706; color: white; }
    .neutral { background: #64748b; color: white; }
    .bad { background: #b42318; color: white; }
    .table-wrap { overflow: auto; }
    .message { max-width: 620px; overflow-wrap: anywhere; }
    .column-menu { display: inline-flex; align-items: center; min-height: 34px; }
    .column-menu summary { cursor: pointer; list-style: none; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 6px; padding: 7px 9px; }
    .column-menu div { position: absolute; z-index: 2; margin-top: 6px; padding: 10px; background: Canvas; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 6px; box-shadow: 0 8px 24px color-mix(in srgb, CanvasText 18%, transparent); display: grid; grid-template-columns: repeat(2, minmax(120px, 1fr)); gap: 6px 12px; }
    .column-menu label { white-space: nowrap; }
    body.redacted .sensitive { filter: blur(7px); user-select: none; }
    body.redacted .sensitive a { pointer-events: none; }
    body.hide-col-provider .col-provider,
    body.hide-col-model .col-model,
    body.hide-col-status .col-status,
    body.hide-col-uptime .col-uptime,
    body.hide-col-ms .col-ms,
    body.hide-col-tps .col-tps,
    body.hide-col-checked .col-checked,
    body.hide-col-next .col-next,
    body.hide-col-http .col-http,
    body.hide-col-message .col-message,
    body.hide-col-probe .col-probe { display: none; }
    .status-cell { min-width: 150px; background-image: var(--history-bg, none); background-size: 100% 4px; background-repeat: no-repeat; background-position: left bottom; }
    .metric { min-width: 110px; }
    .metric-main { display: block; font-weight: 700; }
    .metric-sub { display: block; font-size: 12px; opacity: .72; margin-top: 2px; }
    .sparkline { display: flex; align-items: end; gap: 1px; height: 16px; margin-top: 4px; max-width: 140px; }
    .sparkline span { flex: 1 1 2px; min-width: 2px; background: color-mix(in srgb, currentColor 32%, transparent); border-radius: 1px 1px 0 0; }
    .history-note { font-size: 12px; opacity: .72; margin-top: 2px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${title}</h1>
      <div class="muted">Updated <span id="updated-at">${esc(state.updatedAt || "never")}</span> | <a href="/status.json">status.json</a> | <a href="/history.jsonl">history.jsonl</a></div>
    </div>
    <div id="summary"></div>
  </header>
  <div class="controls">
    <input id="filter" type="search" placeholder="Filter provider, model, status, message" size="42">
    <select id="provider-filter"><option value="">All providers</option>${providerOptions}</select>
    <select id="status-filter"><option value="">All statuses</option>${statusOptions}</select>
    <input id="window-value" type="number" min="1" step="1" value="24" style="width: 80px">
    <select id="window-unit">
      <option value="minutes">minutes</option>
      <option value="hours" selected>hours</option>
      <option value="days">days</option>
    </select>
    <button id="refresh" type="button">Refresh</button>
    <button id="pause-auto" type="button"></button>
    <button id="privacy-toggle" type="button">Blur sensitive</button>
    <details class="column-menu">
      <summary>Columns</summary>
      <div id="column-toggles"></div>
    </details>
    <span id="auto-status" class="muted"></span>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="col-provider"><button type="button" data-sort="providerLabel">Provider</button></th>
          <th class="col-model"><button type="button" data-sort="model">Model</button></th>
          <th class="col-status"><button type="button" data-sort="status">Status</button></th>
          <th class="col-uptime"><button type="button" data-sort="uptimePct">Uptime</button></th>
          <th class="col-ms"><button type="button" data-sort="avgLatencyMs">Response</button></th>
          <th class="col-tps"><button type="button" data-sort="avgTps">TPS</button></th>
          <th class="col-checked"><button type="button" data-sort="checkedAt">Checked</button></th>
          <th class="col-next"><button type="button" data-sort="nextEligibleAt">Next auto</button></th>
          <th class="col-http"><button type="button" data-sort="httpStatus">HTTP</button></th>
          <th class="col-message">Message</th>
          <th class="col-probe">Probe</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <script id="initial-state" type="application/json">${jse(state)}</script>
  <script>
    const statusRank = ${jse(Object.fromEntries(["ok","rate_limited","timeout","network_error","upstream_error","bad_response","needs_more_tokens","pending_probe","client_required","access_locked","out_of_credits","not_listed","non_chat_endpoint","auth_error","unknown_model","error"].map((s,i)=>[s,i])))};
    let state = JSON.parse(document.getElementById("initial-state").textContent);
    let sortKey = "status";
    let sortDir = 1;
    const columns = [
      ["provider","Provider"],["model","Model"],["status","Status"],
      ["uptime","Uptime"],["ms","Response"],["tps","TPS"],
      ["checked","Checked"],["next","Next auto"],["http","HTTP"],
      ["message","Message"],["probe","Probe"]
    ];
    const storagePrefix = "ai-api-monitor:";

    function esc(v) {
      return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
    }
    function getSettings() {
      try { return JSON.parse(localStorage.getItem(storagePrefix + "settings") || "{}"); } catch { return {}; }
    }
    function saveSettings(s) { localStorage.setItem(storagePrefix + "settings", JSON.stringify(s)); }
    function applyPrivacyAndColumns() {
      const s = getSettings();
      document.body.classList.toggle("redacted", Boolean(s.redacted));
      document.getElementById("privacy-toggle").textContent = s.redacted ? "Unblur sensitive" : "Blur sensitive";
      const hidden = new Set(s.hiddenColumns || []);
      for (const [key] of columns) document.body.classList.toggle("hide-col-" + key, hidden.has(key));
      document.querySelectorAll("[data-column-toggle]").forEach((cb) => { cb.checked = !hidden.has(cb.getAttribute("data-column-toggle")); });
    }
    function renderColumnToggles() {
      document.getElementById("column-toggles").innerHTML = columns.map(([key,label]) =>
        '<label><input type="checkbox" data-column-toggle="' + esc(key) + '" checked> ' + esc(label) + '</label>'
      ).join("");
      document.querySelectorAll("[data-column-toggle]").forEach((cb) => {
        cb.addEventListener("change", () => {
          const s = getSettings();
          const hidden = new Set(s.hiddenColumns || []);
          const key = cb.getAttribute("data-column-toggle");
          if (cb.checked) hidden.delete(key); else hidden.add(key);
          s.hiddenColumns = [...hidden];
          saveSettings(s);
          applyPrivacyAndColumns();
        });
      });
      applyPrivacyAndColumns();
    }
    function statusClass(s) {
      if (s === "ok") return "ok";
      if (s === "rate_limited" || s === "needs_more_tokens") return "warn";
      if (s === "access_locked" || s === "client_required") return "locked";
      if (s === "pending_probe" || s === "not_listed" || s === "non_chat_endpoint" || s === "unknown") return "neutral";
      return "bad";
    }
    function effectiveStatus(r) { return r.status || (r.listedForKey ? "pending_probe" : "unknown"); }
    function fmtPct(v) { return Number.isFinite(Number(v)) ? Number(v).toFixed(1).replace(/\\.0$/,"") + "%" : "n/a"; }
    function fmtMs(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return "n/a";
      if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 1 : 2).replace(/\\.0$/,"") + "s";
      return Math.round(n) + "ms";
    }
    function fmtTps(v) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(n >= 10 ? 1 : 2).replace(/\\.0$/,"") + "/s" : "n/a"; }
    function relativeTime(v, future) {
      if (!v) return "";
      const ms = Date.parse(v) - Date.now();
      if (!Number.isFinite(ms)) return String(v);
      const abs = Math.abs(ms);
      const units = [["day",86400000],["hour",3600000],["minute",60000],["second",1000]];
      for (const [label,size] of units) {
        if (abs >= size || label === "second") {
          const count = Math.max(1, Math.round(abs / size));
          const text = count + " " + label + (count === 1 ? "" : "s");
          return ms >= 0 ? "in " + text : text + " ago";
        }
      }
      return future ? "soon" : "just now";
    }
    function windowMinutes() {
      const v = Math.max(1, Number(document.getElementById("window-value").value || 24));
      const u = document.getElementById("window-unit").value;
      if (u === "days") return Math.round(v * 24 * 60);
      if (u === "hours") return Math.round(v * 60);
      return Math.round(v);
    }
    function statusColor(s) {
      if (s === "ok") return "#127a3a";
      if (s === "rate_limited" || s === "needs_more_tokens") return "#9a6700";
      if (s === "pending_probe" || s === "not_listed" || s === "non_chat_endpoint" || s === "unknown") return "#64748b";
      if (s === "access_locked" || s === "client_required") return "#d97706";
      return "#b42318";
    }
    function statusGradient(samples) {
      if (!samples?.length) return "none";
      const parts = samples.map((sample, i) => {
        const start = (i / samples.length) * 100;
        const end = ((i + 1) / samples.length) * 100;
        return statusColor(sample.status) + " " + start.toFixed(2) + "% " + end.toFixed(2) + "%";
      });
      return "linear-gradient(90deg, " + parts.join(", ") + ")";
    }
    function latencySparkline(samples) {
      const values = (samples || []).map((s) => Number(s.latencyMs)).filter((v) => Number.isFinite(v) && v >= 0).slice(-28);
      if (!values.length) return "";
      const max = Math.max(...values, 1);
      return '<span class="sparkline">' + values.map((v) => {
        const h = Math.max(10, Math.round((v / max) * 100));
        return '<span title="' + esc(fmtMs(v)) + '" style="height:' + h + '%"></span>';
      }).join("") + '</span>';
    }
    function tpsSparkline(samples) {
      const values = (samples || []).map((s) => Number(s.tps)).filter((v) => Number.isFinite(v) && v > 0).slice(-28);
      if (!values.length) return "";
      const max = Math.max(...values, 1);
      return '<span class="sparkline">' + values.map((v) => {
        const h = Math.max(10, Math.round((v / max) * 100));
        return '<span title="' + esc(fmtTps(v)) + '" style="height:' + h + '%"></span>';
      }).join("") + '</span>';
    }
    function sortValue(r, key) {
      if (key === "status") return statusRank[effectiveStatus(r)] ?? 50;
      if (key === "uptimePct") return Number(r.analytics?.uptimePct ?? -1);
      if (key === "avgLatencyMs") return Number(r.analytics?.avgLatencyMs ?? r.latencyMs ?? Number.POSITIVE_INFINITY);
      if (key === "avgTps") return Number(r.analytics?.avgTps ?? r.tps ?? -1);
      if (key === "latencyMs" || key === "httpStatus") return Number(r[key] ?? Number.POSITIVE_INFINITY);
      if (key === "checkedAt" || key === "nextEligibleAt") return r[key] ? Date.parse(r[key]) : 0;
      return String(r[key] ?? "").toLowerCase();
    }
    function renderSummary() {
      const summary = state.summary || {};
      document.getElementById("summary").innerHTML = Object.entries(summary)
        .sort((a,b) => (statusRank[a[0]] ?? 50) - (statusRank[b[0]] ?? 50))
        .map(([s,c]) => '<span class="summary"><strong>' + esc(s) + '</strong> ' + esc(c) + '</span>')
        .join("");
      document.getElementById("updated-at").textContent = state.updatedAt || "never";
      const paused = Boolean(state.control?.autoProbePaused);
      document.getElementById("pause-auto").textContent = paused ? "Resume auto" : "Pause auto";
      document.getElementById("auto-status").textContent = paused
        ? "Auto probes paused" + (state.control?.pausedAt ? " since " + state.control.pausedAt : "")
        : (state.runtime?.serveOnly ? "Serve-only mode" : "Auto probes active");
      if (state.history?.windowMinutes) {
        document.getElementById("auto-status").textContent += " | stats window " + state.history.windowMinutes + "m";
      }
    }
    function renderRows() {
      const filter = document.getElementById("filter").value.trim().toLowerCase();
      const providerFilter = document.getElementById("provider-filter").value;
      const statusFilter = document.getElementById("status-filter").value;
      const records = Object.values(state.models || {})
        .filter((r) => !providerFilter || r.provider === providerFilter)
        .filter((r) => !statusFilter || effectiveStatus(r) === statusFilter)
        .filter((r) => {
          if (!filter) return true;
          return [r.providerLabel, r.provider, r.model, effectiveStatus(r), r.message, r.httpStatus]
            .join(" ").toLowerCase().includes(filter);
        })
        .sort((a,b) => {
          const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
          if (av < bv) return -1 * sortDir;
          if (av > bv) return 1 * sortDir;
          return String(a.model).localeCompare(String(b.model));
        });

      document.getElementById("rows").innerHTML = records.map((r) => {
        const s = effectiveStatus(r);
        const analytics = r.analytics || {};
        const samples = analytics.samples || [];
        const providerUrl = state.providers?.[r.provider]?.homeUrl;
        const providerLabel = esc(r.providerLabel || r.provider);
        const providerHtml = providerUrl ? '<a class="sensitive" href="' + esc(providerUrl) + '" target="_blank">' + providerLabel + '</a>' : '<span class="sensitive">' + providerLabel + '</span>';
        const modelHtml = '<code class="sensitive">' + esc(r.model) + '</code>';
        const checkedHtml = r.checkedAt ? '<span title="' + esc(r.checkedAt) + '">' + esc(relativeTime(r.checkedAt)) + '</span>' : '';
        const nextHtml = r.nextEligibleAt ? '<span title="' + esc(r.nextEligibleAt) + '">' + esc(relativeTime(r.nextEligibleAt, true)) + '</span>' : '';
        const sampleNote = analytics.sampleCount ? analytics.sampleCount + ' sample' + (analytics.sampleCount === 1 ? '' : 's') : 'no history';
        const uptimeHtml = '<span class="metric-main">' + esc(fmtPct(analytics.uptimePct)) + '</span><span class="metric-sub">' + esc((analytics.okCount ?? 0) + '/' + (analytics.sampleCount ?? 0) + ' ok') + '</span>';
        const msHtml = '<span class="metric-main">' + esc(fmtMs(r.latencyMs)) + '</span><span class="metric-sub">avg ' + esc(fmtMs(analytics.avgLatencyMs)) + '</span>' + latencySparkline(samples);
        const tpsHtml = '<span class="metric-main">' + esc(fmtTps(r.tps)) + '</span><span class="metric-sub">avg ' + esc(fmtTps(analytics.avgTps)) + '</span>' + tpsSparkline(samples);
        return '<tr>' +
          '<td class="col-provider">' + providerHtml + '</td>' +
          '<td class="col-model">' + modelHtml + '</td>' +
          '<td class="col-status status-cell" style="--history-bg:' + esc(statusGradient(samples)) + '"><span class="pill ' + statusClass(s) + '">' + esc(s) + '</span><div class="history-note">' + esc(sampleNote) + '</div></td>' +
          '<td class="col-uptime metric">' + uptimeHtml + '</td>' +
          '<td class="col-ms metric">' + msHtml + '</td>' +
          '<td class="col-tps metric">' + tpsHtml + '</td>' +
          '<td class="col-checked">' + checkedHtml + '</td>' +
          '<td class="col-next">' + nextHtml + '</td>' +
          '<td class="col-http">' + esc(r.httpStatus || "") + '</td>' +
          '<td class="col-message message sensitive">' + esc(r.message || "") + '</td>' +
          '<td class="col-probe"><button type="button" data-probe-provider="' + esc(r.provider) + '" data-probe-model="' + esc(r.model) + '">Check</button></td>' +
          '</tr>';
      }).join("");
    }
    async function refresh() {
      const response = await fetch("/status.json?windowMinutes=" + encodeURIComponent(windowMinutes()), { cache: "no-store" });
      state = await response.json();
      renderSummary();
      renderRows();
    }
    async function probe(button) {
      const provider = button.getAttribute("data-probe-provider");
      const model = button.getAttribute("data-probe-model");
      button.disabled = true; button.textContent = "Checking";
      try {
        const response = await fetch("/probe?provider=" + encodeURIComponent(provider) + "&model=" + encodeURIComponent(model), { method: "POST" });
        if (!response.ok) { const p = await response.json().catch(() => ({})); alert(p.error || response.statusText); }
        await refresh();
      } finally { button.disabled = false; button.textContent = "Check"; }
    }
    async function toggleAuto() {
      const paused = Boolean(state.control?.autoProbePaused);
      const response = await fetch("/control?action=" + (paused ? "resume" : "pause"), { method: "POST" });
      if (!response.ok) { const p = await response.json().catch(() => ({})); alert(p.error || response.statusText); }
      await refresh();
    }
    document.getElementById("filter").addEventListener("input", renderRows);
    document.getElementById("provider-filter").addEventListener("change", renderRows);
    document.getElementById("status-filter").addEventListener("change", renderRows);
    document.getElementById("window-value").addEventListener("change", refresh);
    document.getElementById("window-unit").addEventListener("change", refresh);
    document.getElementById("refresh").addEventListener("click", refresh);
    document.getElementById("pause-auto").addEventListener("click", toggleAuto);
    document.getElementById("privacy-toggle").addEventListener("click", () => {
      const s = getSettings(); s.redacted = !s.redacted; saveSettings(s); applyPrivacyAndColumns();
    });
    document.querySelectorAll("[data-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("data-sort");
        if (sortKey === next) sortDir *= -1;
        else { sortKey = next; sortDir = ["uptimePct","avgTps"].includes(next) ? -1 : 1; }
        renderRows();
      });
    });
    document.getElementById("rows").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-probe-model]");
      if (btn) probe(btn);
    });
    renderColumnToggles();
    renderSummary();
    renderRows();
    setInterval(refresh, 60000);
    setInterval(renderRows, 30000);
  </script>
</body>
</html>`;
}

function esc(v) { return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function jse(v) { return JSON.stringify(v).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"); }

// ── HTTP Server ────────────────────────────────────────────────────────────

export function startServer(config, state) {
  const server = http.createServer((req, res) => {
    void handleRequest(config, state, req, res);
  });

  server.listen(config.port, config.host, () => {
    console.log(`${config.title} listening on http://${config.host}:${config.port}`);
  });
  return server;
}

async function handleRequest(config, state, req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/") {
      const viewState = await buildViewState(config, state, 24 * 60 * 60_000);
      send(res, 200, "text/html; charset=utf-8", renderDashboard(viewState));
      return;
    }

    if (req.method === "GET" && url.pathname === "/status.json") {
      const viewState = await buildViewState(config, state, analyticsWindowMsFromUrl(url));
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(viewState, null, 2));
      return;
    }

    if (req.method === "GET" && url.pathname === "/history.jsonl") {
      const history = await readFileQuietly(config.historyPath);
      send(res, 200, "application/x-ndjson; charset=utf-8", history);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/model/")) {
      const key = decodeURIComponent(url.pathname.slice("/model/".length));
      const record = state.models[key] || Object.values(state.models).find((item) => item.model === key);
      send(res, record ? 200 : 404, "application/json; charset=utf-8", JSON.stringify(record || { error: "not found" }, null, 2));
      return;
    }

    if (req.method === "POST" && url.pathname === "/probe") {
      const body = await readRequestJson(req);
      const providerId = url.searchParams.get("provider") || body.provider;
      const model = url.searchParams.get("model") || body.model;

      const provider = config.providers.find((p) => p.id === providerId);
      if (!provider) {
        send(res, 404, "application/json", JSON.stringify({ error: `Unknown provider: ${providerId}` }));
        return;
      }
      if (!model) {
        send(res, 400, "application/json", JSON.stringify({ error: "Missing model." }));
        return;
      }

      ensureProviderState(state, provider);
      const previous = state.models[`${provider.id}::${model}`];
      const probe = await probeModel(config, provider, model);
      const record = ensureRecord(state, provider, model, {
        listedForKey: previous?.listedForKey,
        active: probe.active ?? previous?.active ?? true,
        manual: true,
        ...probe,
      });
      deriveRecordMetrics(record);
      record.nextEligibleAt = new Date(Date.now() + provider.intervalMs).toISOString();
      await persist(config, state);
      await appendHistory(config, {
        type: "probe", mode: "manual",
        provider: provider.id, providerLabel: provider.label, model,
        status: record.status, httpStatus: record.httpStatus,
        latencyMs: record.latencyMs, outputTokens: record.outputTokens,
        tps: record.tps, message: record.message,
        nextEligibleAt: record.nextEligibleAt,
      });
      console.log(`${provider.id}:${String(record.status).padEnd(14)} ${model} ${record.message || ""} manual`);
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(record, null, 2));
      return;
    }

    if (req.method === "POST" && url.pathname === "/control") {
      const body = await readRequestJson(req);
      const action = url.searchParams.get("action") || body.action;
      if (action === "pause") {
        const control = await setAutoProbePaused(config, state, true, "dashboard");
        send(res, 200, "application/json; charset=utf-8", JSON.stringify(control, null, 2));
        return;
      }
      if (action === "resume") {
        const control = await setAutoProbePaused(config, state, false, "dashboard");
        send(res, 200, "application/json; charset=utf-8", JSON.stringify(control, null, 2));
        return;
      }
      send(res, 400, "application/json; charset=utf-8", JSON.stringify({ error: "action must be pause or resume" }));
      return;
    }

    send(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not found" }));
  } catch (error) {
    send(res, error.statusCode || 500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message || error) }));
  }
}
