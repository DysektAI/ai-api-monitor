import { parseArgs, loadConfig } from "./config.js";
import {
  loadState,
  ensureProviderState,
  ensureRecord,
  deriveRecordMetrics,
  persist,
  appendHistory,
  writePidFile,
  removePidFile,
  autoProbePaused,
  setAutoProbePaused,
} from "./state.js";
import { probeModel, refreshProviderCatalog, isNonChatModel } from "./probe.js";
import { startServer } from "./server.js";
import { shuffle, sleep, makeKey } from "./utils.js";

const args = parseArgs(process.argv.slice(2));

// ── Scheduler ──────────────────────────────────────────────────────────────

function modelDue(record, intervalMs) {
  if (!record?.checkedAt) return true;
  return Date.now() - Date.parse(record.checkedAt) >= intervalMs;
}

async function refreshCatalogs(config, state) {
  for (const provider of config.providers) {
    ensureProviderState(state, provider);
    if (provider.enabled) {
      await refreshProviderCatalog(config, state, provider);
    }
  }
}

function getProbeJobs(config, state) {
  const jobs = [];
  for (const provider of config.providers) {
    if (!provider.enabled || !provider.autoProbe) continue;

    let models = provider.models;
    const catalogModels = state.providers?.[provider.id]?.catalog?.models;
    if (provider.probeKeyCatalogModels && !provider.modelsOverridden && Array.isArray(catalogModels)) {
      models = catalogModels;
    }
    if (provider.probeOnlyListedForKey && Array.isArray(catalogModels)) {
      const listed = new Set(catalogModels);
      models = models.filter((m) => listed.has(m));
    }

    for (const model of [...new Set(models)].filter((m) => !isNonChatModel(provider, m))) {
      jobs.push({ provider, model });
    }
  }
  return jobs;
}

async function probeCycle(config, state, { force = false } = {}) {
  await refreshCatalogs(config, state);
  await persist(config, state);

  const jobs = shuffle(getProbeJobs(config, state));
  const spreadDelayMs = Math.max(config.minRequestDelayMs, Math.ceil(config.intervalMs / Math.max(1, jobs.length)));
  const perProbeDelayMs = args.once ? config.minRequestDelayMs : spreadDelayMs;

  for (const job of jobs) {
    if (!force && autoProbePaused(state)) break;

    const previous = state.models[makeKey(job.provider.id, job.model)];
    if (!force && !modelDue(previous, job.provider.intervalMs)) continue;

    const probe = await probeModel(config, job.provider, job.model);
    const record = ensureRecord(state, job.provider, job.model, {
      listedForKey: previous?.listedForKey,
      active: probe.active ?? previous?.active ?? true,
      ...probe,
    });
    deriveRecordMetrics(record);
    record.nextEligibleAt = new Date(Date.now() + job.provider.intervalMs).toISOString();
    await persist(config, state);
    await appendHistory(config, {
      type: "probe",
      mode: "auto",
      provider: job.provider.id,
      providerLabel: job.provider.label,
      model: job.model,
      status: record.status,
      httpStatus: record.httpStatus,
      latencyMs: record.latencyMs,
      outputTokens: record.outputTokens,
      tps: record.tps,
      message: record.message,
      nextEligibleAt: record.nextEligibleAt,
    });
    console.log(`${job.provider.id}:${String(record.status).padEnd(14)} ${job.model} ${record.message || ""}`.trimEnd());

    const jitter = 0.8 + Math.random() * 0.4;
    await sleep(Math.round(perProbeDelayMs * jitter));
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = await loadConfig(args);
  const state = await loadState(config);

  if (!args.once) {
    await writePidFile(config);
    process.once("SIGINT", () => {
      void appendHistory(config, { type: "monitor_stopped", signal: "SIGINT" }).finally(() => {
        void removePidFile(config).finally(() => process.exit(0));
      });
    });
    process.once("SIGTERM", () => {
      void appendHistory(config, { type: "monitor_stopped", signal: "SIGTERM" }).finally(() => {
        void removePidFile(config).finally(() => process.exit(0));
      });
    });
  }

  for (const provider of config.providers) {
    ensureProviderState(state, provider);
    for (const model of provider.models) {
      ensureRecord(state, provider, model);
    }
  }

  state.runtime = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    serveOnly: Boolean(args.serveOnly),
    once: Boolean(args.once),
  };

  await persist(config, state);

  if (args.paused) await setAutoProbePaused(config, state, true, "startup");
  if (args.resume) await setAutoProbePaused(config, state, false, "startup");
  if (!args.once) {
    await appendHistory(config, {
      type: "monitor_started",
      pid: process.pid,
      serveOnly: Boolean(args.serveOnly),
      autoProbePaused: autoProbePaused(state),
    });
  }

  if (!args.noServer && !args.once) startServer(config, state);

  if (args.once) {
    await probeCycle(config, state, { force: true });
    return;
  }

  if (args.serveOnly) {
    console.log("Auto probes disabled for this run; dashboard/manual checks only.");
    return;
  }

  for (;;) {
    if (autoProbePaused(state)) {
      await sleep(10_000);
      continue;
    }
    await probeCycle(config, state);
    await sleep(10_000);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
