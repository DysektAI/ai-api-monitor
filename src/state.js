import { readJson, writeJsonAtomic, readFileQuietly, appendJsonLine, removeFileQuietly } from "./utils.js";

export function emptyState(config) {
  return {
    version: 2,
    updatedAt: null,
    intervalMinutes: config.intervalMs / 60_000,
    rateLimitPerMinute: Math.round(60_000 / config.minRequestDelayMs),
    providers: {},
    models: {},
    summary: {},
    control: {
      autoProbePaused: false,
      pausedAt: null,
      pausedReason: null,
    },
    runtime: {},
  };
}

export async function loadState(config) {
  const state = await readJson(config.statusPath, emptyState(config));
  state.version = 2;
  state.intervalMinutes = config.intervalMs / 60_000;
  state.rateLimitPerMinute = Math.round(60_000 / config.minRequestDelayMs);
  state.providers ||= {};
  state.models ||= {};
  state.summary ||= {};
  state.control ||= {};
  state.control.autoProbePaused = Boolean(state.control.autoProbePaused);
  state.runtime ||= {};

  // Migrate legacy records that don't have provider::model keys
  const fallbackProvider = config.providers[0]?.id || "default";
  const migrated = {};
  for (const [key, record] of Object.entries(state.models || {})) {
    const providerId = record.provider || (key.includes("::") ? key.split("::", 1)[0] : fallbackProvider);
    const model = record.model || (key.includes("::") ? key.slice(key.indexOf("::") + 2) : key);
    const nextKey = `${providerId}::${model}`;
    migrated[nextKey] = {
      ...record,
      key: nextKey,
      provider: providerId,
      providerLabel: config.providers.find((p) => p.id === providerId)?.label || providerId,
      model,
    };
  }
  state.models = migrated;

  return state;
}

export function ensureProviderState(state, provider) {
  state.providers[provider.id] ||= {
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    wireApi: provider.wireApi,
  };
  state.providers[provider.id].label = provider.label;
  state.providers[provider.id].baseUrl = provider.baseUrl;
  state.providers[provider.id].homeUrl = provider.homeUrl;
  state.providers[provider.id].wireApi = provider.wireApi;
  state.providers[provider.id].enabled = provider.enabled;
  state.providers[provider.id].autoProbe = provider.autoProbe;
  return state.providers[provider.id];
}

export function ensureRecord(state, provider, model, patch = {}) {
  const key = `${provider.id}::${model}`;
  state.models[key] ||= {
    key,
    provider: provider.id,
    providerLabel: provider.label,
    model,
    status: "pending_probe",
    message: "Waiting for the next staggered probe.",
  };
  Object.assign(state.models[key], { key, provider: provider.id, providerLabel: provider.label, model, ...patch });
  return state.models[key];
}

export function effectiveStatus(record) {
  return record?.status || (record?.listedForKey ? "pending_probe" : "unknown");
}

export function isUsableStatus(status) {
  return status === "ok";
}

function outputTokensFromUsage(usage) {
  const value = Number(
    usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens ?? usage?.outputTokens ?? 0
  );
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function deriveRecordMetrics(record) {
  const outputTokens = outputTokensFromUsage(record.usage);
  if (outputTokens !== null) record.outputTokens = outputTokens;
  else delete record.outputTokens;

  const latencyMs = Number(record.latencyMs);
  if (outputTokens !== null && Number.isFinite(latencyMs) && latencyMs > 0) {
    record.tps = Number((outputTokens / (latencyMs / 1000)).toFixed(2));
  } else {
    delete record.tps;
  }
  return record;
}

export function summarize(state) {
  const byStatus = {};
  const byProvider = {};
  for (const record of Object.values(state.models)) {
    const status = effectiveStatus(record);
    byStatus[status] = (byStatus[status] || 0) + 1;
    byProvider[record.provider] ||= {};
    byProvider[record.provider][status] = (byProvider[record.provider][status] || 0) + 1;
  }
  state.summary = byStatus;
  state.providerSummary = byProvider;
  state.updatedAt = new Date().toISOString();
}

export async function persist(config, state) {
  summarize(state);
  await writeJsonAtomic(config.statusPath, state);
}

export async function appendHistory(config, event) {
  await appendJsonLine(config.historyPath, { at: new Date().toISOString(), ...event });
}

export async function writePidFile(config) {
  await removeFileQuietly(config.pidPath);
  await writeJsonAtomic(config.pidPath, process.pid);
}

export async function removePidFile(config) {
  try {
    const current = (await readFileQuietly(config.pidPath)).trim();
    if (current === String(process.pid)) {
      await removeFileQuietly(config.pidPath);
    }
  } catch {
    // Best effort.
  }
}

export async function setAutoProbePaused(config, state, paused, reason = "manual") {
  state.control ||= {};
  state.control.autoProbePaused = Boolean(paused);
  state.control.pausedAt = paused ? new Date().toISOString() : null;
  state.control.pausedReason = paused ? reason : null;
  state.control.resumedAt = paused ? state.control.resumedAt || null : new Date().toISOString();
  await persist(config, state);
  await appendHistory(config, { type: paused ? "auto_probe_paused" : "auto_probe_resumed", reason });
  return state.control;
}

export function autoProbePaused(state) {
  return Boolean(state.control?.autoProbePaused);
}

// ── History analytics ──────────────────────────────────────────────────────

export async function readProbeHistory(config, windowMs) {
  const text = await readFileQuietly(config.historyPath);
  if (!text.trim()) return [];

  const since = Date.now() - windowMs;
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "probe") continue;
      const atMs = Date.parse(event.at);
      if (!Number.isFinite(atMs) || atMs < since) continue;
      events.push(event);
    } catch {
      // Ignore malformed lines.
    }
  }
  return events;
}

function sampleFromProbeEvent(event) {
  const latencyMs = Number(event.latencyMs);
  const outputTokens = Number(event.outputTokens);
  const tps = Number(event.tps);
  return {
    at: event.at,
    status: event.status || "unknown",
    ok: isUsableStatus(event.status),
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : null,
    tps: Number.isFinite(tps) && tps > 0 ? tps : null,
  };
}

function maybeAddCurrentRecordSample(samples, record, windowMs) {
  if (!record?.checkedAt || !record.status) return;
  const checkedMs = Date.parse(record.checkedAt);
  if (!Number.isFinite(checkedMs) || Date.now() - checkedMs > windowMs) return;
  if (samples.some((s) => Math.abs(Date.parse(s.at) - checkedMs) < 1000)) return;

  const latencyMs = Number(record.latencyMs);
  const outputTokens = record.outputTokens ?? outputTokensFromUsage(record.usage);
  const tps = Number(record.tps);
  samples.push({
    at: record.checkedAt,
    status: record.status,
    ok: isUsableStatus(record.status),
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    outputTokens,
    tps: Number.isFinite(tps) && tps > 0 ? tps : null,
  });
}

function buildAnalyticsForSamples(samples, windowMinutes) {
  const sorted = [...samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const total = sorted.length;
  const okCount = sorted.filter((s) => s.ok).length;
  const latencyValues = sorted.map((s) => Number(s.latencyMs)).filter((v) => Number.isFinite(v) && v >= 0);
  const tpsValues = sorted.map((s) => Number(s.tps)).filter((v) => Number.isFinite(v) && v > 0);

  const average = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

  return {
    windowMinutes,
    sampleCount: total,
    okCount,
    failCount: Math.max(0, total - okCount),
    uptimePct: total ? Number(((okCount / total) * 100).toFixed(1)) : null,
    avgLatencyMs: latencyValues.length ? Math.round(average(latencyValues)) : null,
    minLatencyMs: latencyValues.length ? Math.min(...latencyValues) : null,
    maxLatencyMs: latencyValues.length ? Math.max(...latencyValues) : null,
    avgTps: tpsValues.length ? Number(average(tpsValues).toFixed(2)) : null,
    minTps: tpsValues.length ? Number(Math.min(...tpsValues).toFixed(2)) : null,
    maxTps: tpsValues.length ? Number(Math.max(...tpsValues).toFixed(2)) : null,
    samples: sorted.slice(-80),
  };
}

export async function buildViewState(config, state, windowMs) {
  const view = JSON.parse(JSON.stringify(state));
  const windowMinutes = Math.round(windowMs / 60_000);
  const events = await readProbeHistory(config, windowMs);
  const grouped = new Map();

  for (const event of events) {
    if (!event.provider || !event.model) continue;
    const key = `${event.provider}::${event.model}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(sampleFromProbeEvent(event));
  }

  for (const [key, record] of Object.entries(view.models || {})) {
    const samples = grouped.get(key) || [];
    maybeAddCurrentRecordSample(samples, record, windowMs);
    record.analytics = buildAnalyticsForSamples(samples, windowMinutes);
  }

  view.analyticsWindowMinutes = windowMinutes;
  view.history = { windowMinutes, eventCount: events.length };
  view.title = config.title;
  return view;
}

export function statusRank(status) {
  return {
    ok: 0,
    rate_limited: 1,
    timeout: 2,
    network_error: 3,
    upstream_error: 4,
    bad_response: 5,
    needs_more_tokens: 6,
    pending_probe: 7,
    client_required: 8,
    access_locked: 9,
    out_of_credits: 10,
    not_listed: 11,
    non_chat_endpoint: 12,
    auth_error: 13,
    unknown_model: 14,
    error: 15,
  }[status] ?? 50;
}
