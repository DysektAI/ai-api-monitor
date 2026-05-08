import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, resolveFromConfig, unique, normalizePathSegment, readFileQuietly } from "./utils.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const defaultConfigPath = path.join(projectRoot, "config.json");

export function parseArgs(argv) {
  const parsed = {
    once: false,
    noServer: false,
    serveOnly: false,
    paused: false,
    resume: false,
    config: defaultConfigPath,
    models: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") parsed.once = true;
    else if (arg === "--no-server") parsed.noServer = true;
    else if (arg === "--serve-only") parsed.serveOnly = true;
    else if (arg === "--paused") parsed.paused = true;
    else if (arg === "--resume") parsed.resume = true;
    else if (arg === "--config") parsed.config = argv[++i];
    else if (arg === "--models") parsed.models = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean) || [];
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node src/monitor.js [options]

Options:
  --once              Run one probe cycle and exit
  --no-server         Do not start the dashboard server
  --serve-only        Start dashboard without auto-probes
  --paused            Start with auto-probes paused
  --resume            Clear persisted pause state on startup
  --config PATH       Path to config.json (default: ./config.json)
  --models p:m,...    Probe only specific provider:model pairs
  -h, --help          Show this help
`);
      process.exit(0);
    }
  }

  return parsed;
}

export async function loadEnv(envPath = path.join(projectRoot, ".env")) {
  const text = await readFileQuietly(envPath);
  if (!text) return;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue; // CLI/env takes precedence
    const value = rawValue.replace(/^["']|["']$/g, "").trim();
    process.env[key] = value;
  }
}

async function readProviderModels(configPath, providerConfig) {
  const models = Array.isArray(providerConfig.models) ? [...providerConfig.models] : [];
  const modelsFile = resolveFromConfig(configPath, providerConfig.modelsFile);
  if (modelsFile) {
    const payload = await readJson(modelsFile, { models: [] });
    const fileModels = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.models)
        ? payload.models
        : Array.isArray(payload.data)
          ? payload.data.map((item) => item?.id).filter(Boolean)
          : [];
    models.push(...fileModels);
  }
  return unique(models.map(String));
}

function parseModelOverrides(modelSpecs, providers) {
  if (!Array.isArray(modelSpecs)) return null;

  const overrides = new Map(providers.map((p) => [p.id, []]));
  const defaultProvider = providers[0];

  for (const spec of modelSpecs) {
    const match = providers
      .map((p) => [`${p.id}::`, `${p.id}:`].map((prefix) => ({ provider: p, prefix })))
      .flat()
      .find(({ prefix }) => spec.startsWith(prefix));

    if (match) {
      overrides.get(match.provider.id).push(spec.slice(match.prefix.length));
    } else if (defaultProvider) {
      overrides.get(defaultProvider.id).push(spec);
    }
  }

  return overrides;
}

async function readApiKeyForProvider(provider) {
  const envNames = unique([provider.apiKeyEnv, ...provider.apiKeyAliases]);
  for (const envName of envNames) {
    const value = process.env[envName];
    if (value?.trim()) return value.trim();
  }

  if (provider.apiKeyFile) {
    const keyPath = path.resolve(provider.apiKeyFile);
    return (await readFileQuietly(keyPath)).trim();
  }

  return "";
}

export async function loadConfig(args) {
  await loadEnv();

  const configPath = path.resolve(args.config);
  const rawConfig = await readJson(configPath);
  const stateDir = resolveFromConfig(configPath, rawConfig.stateDir || "./state");

  const rawProviders = Array.isArray(rawConfig.providers) && rawConfig.providers.length > 0
    ? rawConfig.providers
    : [{
        id: "default",
        label: "Default Provider",
        baseUrl: rawConfig.baseUrl || "https://api.openai.com/v1",
        apiKeyEnv: rawConfig.apiKeyEnv || "PROVIDER_API_KEY",
        authStyle: rawConfig.authStyle || "bearer",
        wireApi: rawConfig.wireApi || "chat",
        modelsFile: rawConfig.modelsFile,
        models: rawConfig.models,
        refreshCatalog: rawConfig.refreshCatalog,
        probeKeyCatalogModels: rawConfig.probeKeyCatalogModels,
        probeOnlyListedForKey: rawConfig.probeOnlyListedForKey,
        pruneMissingModels: rawConfig.pruneMissingModels,
        nonChatModelPrefixes: rawConfig.nonChatModelPrefixes,
        nonChatModelContains: rawConfig.nonChatModelContains,
      }];

  const providers = [];
  for (let i = 0; i < rawProviders.length; i += 1) {
    const raw = rawProviders[i];
    const id = normalizePathSegment(raw.id || raw.label || `provider-${i + 1}`, `provider-${i + 1}`);
    const models = await readProviderModels(configPath, raw);

    providers.push({
      id,
      label: String(raw.label || raw.name || id),
      enabled: raw.enabled !== false,
      autoProbe: raw.autoProbe !== false,
      baseUrl: String(raw.baseUrl || rawConfig.baseUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
      homeUrl: raw.homeUrl || null,
      apiKeyEnv: raw.apiKeyEnv || raw.envKey || null,
      apiKeyAliases: Array.isArray(raw.apiKeyAliases) ? raw.apiKeyAliases : [],
      apiKeyFile: raw.apiKeyFile || null,
      authStyle: raw.authStyle || "bearer",
      wireApi: raw.wireApi || "chat",
      catalogPath: raw.catalogPath || "/models",
      chatPath: raw.chatPath || "/chat/completions",
      messagesPath: raw.messagesPath || "/v1/messages",
      anthropicVersion: raw.anthropicVersion || "2023-06-01",
      refreshCatalog: Boolean(raw.refreshCatalog),
      probeKeyCatalogModels: Boolean(raw.probeKeyCatalogModels),
      probeOnlyListedForKey: raw.probeOnlyListedForKey === true,
      showConfiguredUnavailable: raw.showConfiguredUnavailable !== false,
      pruneMissingModels: raw.pruneMissingModels !== false,
      nonChatModelPrefixes: raw.nonChatModelPrefixes || [],
      nonChatModelContains: raw.nonChatModelContains || [],
      probePrompt: raw.probePrompt || rawConfig.probePrompt || ".",
      systemPrompt: raw.systemPrompt || rawConfig.systemPrompt || "",
      probeMaxTokens: Math.max(1, Number(raw.probeMaxTokens || rawConfig.probeMaxTokens || 1)),
      requestTimeoutMs: Math.max(5_000, Number(raw.requestTimeoutMs || rawConfig.requestTimeoutMs || 45_000)),
      intervalMs: Math.max(1, Number(raw.intervalMinutes || rawConfig.intervalMinutes || 60)) * 60_000,
      models,
      modelsOverridden: false,
      apiKey: "",
    });
  }

  const overrides = parseModelOverrides(args.models, providers);
  if (overrides) {
    for (const provider of providers) {
      provider.models = unique(overrides.get(provider.id) || []);
      provider.modelsOverridden = true;
      provider.probeKeyCatalogModels = false;
    }
  }

  for (const provider of providers) {
    provider.apiKey = await readApiKeyForProvider(provider);
  }

  return {
    configPath,
    stateDir,
    statusPath: path.join(stateDir, "status.json"),
    historyPath: path.join(stateDir, "history.jsonl"),
    pidPath: path.join(stateDir, "monitor.pid"),
    providers,
    intervalMs: Math.max(1, Number(rawConfig.intervalMinutes || 60)) * 60_000,
    minRequestDelayMs: Math.ceil(60_000 / Math.max(1, Number(rawConfig.rateLimitPerMinute || 30))),
    requestTimeoutMs: Math.max(5_000, Number(rawConfig.requestTimeoutMs || 45_000)),
    host: String(rawConfig.host || "127.0.0.1"),
    port: Number(rawConfig.port || 8791),
    blockStatuses: rawConfig.blockStatuses || [],
    title: rawConfig.title || "AI API Monitor",
  };
}
