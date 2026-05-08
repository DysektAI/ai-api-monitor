import { ensureRecord } from "./state.js";
import { fetchJson, providerUrl } from "./utils.js";

// ── Auth helpers ───────────────────────────────────────────────────────────

function authHeaders(provider) {
  if (!provider.apiKey) return {};
  if (provider.authStyle === "anthropic") {
    return {
      "x-api-key": provider.apiKey,
      "anthropic-version": provider.anthropicVersion,
    };
  }
  return { authorization: `Bearer ${provider.apiKey}` };
}

// ── Error classification ───────────────────────────────────────────────────

export function classifyError(httpStatus, payload, elapsedMs) {
  const error = payload?.error || payload || {};
  const message = String(error.message || error.raw || JSON.stringify(error)).slice(0, 1000);
  const type = String(error.type || error.code || "");
  const lower = `${message} ${type}`.toLowerCase();

  if (
    lower.includes("unsupported client") ||
    lower.includes("supported client") ||
    lower.includes("wrong client") ||
    lower.includes("unauthorized client")
  ) {
    return { status: "client_required", message, errorType: type };
  }
  if (httpStatus === 401) return { status: "auth_error", message, errorType: type };
  if (httpStatus === 403) return { status: "access_locked", message, errorType: type };
  if (httpStatus === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { status: "rate_limited", message, errorType: type };
  }
  if (lower.includes("unknown model") || lower.includes("model not found")) {
    return { status: "unknown_model", message, errorType: type };
  }
  if (
    lower.includes("credit") ||
    lower.includes("quota") ||
    lower.includes("billing") ||
    lower.includes("insufficient") ||
    lower.includes("balance")
  ) {
    return { status: "out_of_credits", message, errorType: type };
  }
  if (lower.includes("invite") || lower.includes("tier") || lower.includes("locked") || lower.includes("permission")) {
    return { status: "access_locked", message, errorType: type };
  }
  if (
    httpStatus >= 500 ||
    lower.includes("capacity") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("no available channel")
  ) {
    return { status: "upstream_error", message, errorType: type };
  }

  return { status: "error", message, errorType: type, latencyMs: elapsedMs };
}

export function classifyTextError(message, httpStatus = 0, elapsedMs = 0) {
  return classifyError(httpStatus, { error: { message: String(message || "Unknown error") } }, elapsedMs);
}

// ── Response extraction ────────────────────────────────────────────────────

function extractChoiceText(payload) {
  const message = payload?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part?.text || part?.content || "").join("");
  }
  return "";
}

function extractAnthropicText(payload) {
  if (typeof payload?.completion === "string") return payload.completion;
  if (!Array.isArray(payload?.content)) return "";
  return payload.content.map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text || "" : part?.text || "")).join("");
}

function classifyEmptySuccess(payload) {
  if (payload?.error) return classifyError(200, payload, 0);

  const choice = payload?.choices?.[0] || {};
  const finishReason = choice.finish_reason || payload?.stop_reason || "";
  const usage = payload?.usage || {};
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const reasoningTokens = Number(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0
  );

  if (
    finishReason === "length" ||
    finishReason === "max_tokens" ||
    (completionTokens > 0 && reasoningTokens >= completionTokens)
  ) {
    return {
      status: "needs_more_tokens",
      message: "HTTP 200 but no visible assistant text; output budget appears to have been spent on hidden reasoning.",
    };
  }

  return {
    status: "bad_response",
    message: `No assistant text in response.${finishReason ? ` finish_reason=${finishReason}` : ""}`,
  };
}

// ── Non-chat model detection ───────────────────────────────────────────────

export function isNonChatModel(provider, model) {
  const normalized = String(model).toLowerCase();
  if (provider.nonChatModelPrefixes.some((prefix) => normalized.startsWith(String(prefix).toLowerCase()))) {
    return true;
  }
  return provider.nonChatModelContains.some((token) => normalized.includes(String(token).toLowerCase()));
}

// ── Catalog refresh ────────────────────────────────────────────────────────

export function catalogIdsFromPayload(payload) {
  const source = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  return new Set(source.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean));
}

export async function refreshProviderCatalog(config, state, provider) {
  const providerState = state.providers[provider.id] || {};
  if (!provider.refreshCatalog || !provider.apiKey) return;

  const started = Date.now();
  try {
    const { response, payload } = await fetchJson(providerUrl(provider, provider.catalogPath), {
      headers: { ...authHeaders(provider), accept: "application/json" },
      signal: AbortSignal.timeout(provider.requestTimeoutMs || config.requestTimeoutMs),
    });

    const latencyMs = Date.now() - started;
    if (!response.ok || payload?.error) {
      state.providers[provider.id] = {
        ...providerState,
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        wireApi: provider.wireApi,
        enabled: provider.enabled,
        autoProbe: provider.autoProbe,
        catalog: {
          checkedAt: new Date().toISOString(),
          httpStatus: response.status,
          latencyMs,
          ...classifyError(response.status, payload, latencyMs),
        },
      };
      console.log(`${provider.id}:catalog_error ${state.providers[provider.id].catalog.message}`);
      return;
    }

    const ids = catalogIdsFromPayload(payload);
    const configured = new Set(provider.models);

    state.providers[provider.id] = {
      ...providerState,
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      homeUrl: provider.homeUrl,
      wireApi: provider.wireApi,
      enabled: provider.enabled,
      autoProbe: provider.autoProbe,
      catalog: {
        checkedAt: new Date().toISOString(),
        status: "ok",
        httpStatus: response.status,
        latencyMs,
        count: ids.size,
        models: [...ids].sort(),
      },
    };
    console.log(`${provider.id}:catalog ${ids.size} models listed for key`);

    // Prune models that disappeared from catalog
    if (provider.pruneMissingModels) {
      for (const [key, record] of Object.entries(state.models || {})) {
        if (record.provider === provider.id && !ids.has(record.model) && !configured.has(record.model)) {
          delete state.models[key];
        }
      }
    }

    // Mark configured models as listed/not listed
    for (const model of provider.models) {
      const listed = ids.has(model);
      ensureRecord(state, provider, model, {
        listedForKey: listed,
        active: listed,
        ...(!listed && provider.showConfiguredUnavailable
          ? {
              status: "not_listed",
              message: "Not listed by this key's /v1/models catalog; not probed.",
              checkedAt: state.providers[provider.id].catalog.checkedAt,
              httpStatus: response.status,
              latencyMs,
            }
          : {}),
      });
    }

    // Auto-discover catalog models if enabled
    if (provider.probeKeyCatalogModels) {
      for (const model of ids) {
        ensureRecord(state, provider, model, { listedForKey: true, active: true });
        if (isNonChatModel(provider, model)) {
          ensureRecord(state, provider, model, {
            status: "non_chat_endpoint",
            message: "Listed by /v1/models, but skipped because it is not a chat-completions/messages model.",
            checkedAt: state.providers[provider.id].catalog.checkedAt,
            httpStatus: response.status,
            latencyMs,
            listedForKey: true,
            active: false,
          });
        }
      }
    }
  } catch (error) {
    state.providers[provider.id] = {
      ...providerState,
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      wireApi: provider.wireApi,
      enabled: provider.enabled,
      autoProbe: provider.autoProbe,
      catalog: {
        checkedAt: new Date().toISOString(),
        status: "network_error",
        message: String(error?.message || error),
        latencyMs: Date.now() - started,
      },
    };
    console.log(`${provider.id}:catalog_error ${state.providers[provider.id].catalog.message}`);
  }
}

// ── Model probing ──────────────────────────────────────────────────────────

async function probeChatModel(config, provider, model, checkedAt, started) {
  const messages = [];
  if (provider.systemPrompt) {
    messages.push({ role: "system", content: provider.systemPrompt });
  }
  messages.push({ role: "user", content: provider.probePrompt });

  const { response, payload } = await fetchJson(providerUrl(provider, provider.chatPath), {
    method: "POST",
    headers: {
      ...authHeaders(provider),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: provider.probeMaxTokens,
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(provider.requestTimeoutMs || config.requestTimeoutMs),
  });
  const latencyMs = Date.now() - started;

  if (!response.ok || payload?.error) {
    return {
      model,
      checkedAt,
      httpStatus: response.status,
      latencyMs,
      ...classifyError(response.status, payload, latencyMs),
    };
  }

  const output = extractChoiceText(payload).trim();
  const emptySuccess = output ? null : classifyEmptySuccess(payload);
  return {
    model,
    status: output ? "ok" : emptySuccess.status,
    checkedAt,
    httpStatus: response.status,
    latencyMs,
    message: output ? `response: ${output.slice(0, 120)}` : emptySuccess.message,
    usage: payload?.usage || null,
  };
}

async function probeAnthropicModel(config, provider, model, checkedAt, started) {
  const { response, payload } = await fetchJson(providerUrl(provider, provider.messagesPath), {
    method: "POST",
    headers: {
      ...authHeaders(provider),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model,
      system: provider.systemPrompt || undefined,
      messages: [{ role: "user", content: provider.probePrompt }],
      max_tokens: provider.probeMaxTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(provider.requestTimeoutMs || config.requestTimeoutMs),
  });
  const latencyMs = Date.now() - started;

  if (!response.ok || payload?.error) {
    return {
      model,
      checkedAt,
      httpStatus: response.status,
      latencyMs,
      ...classifyError(response.status, payload, latencyMs),
    };
  }

  const output = extractAnthropicText(payload).trim();
  const emptySuccess = output ? null : classifyEmptySuccess(payload);
  return {
    model,
    status: output ? "ok" : emptySuccess.status,
    checkedAt,
    httpStatus: response.status,
    latencyMs,
    message: output ? `response: ${output.slice(0, 120)}` : emptySuccess.message,
    usage: payload?.usage || null,
  };
}

export async function probeModel(config, provider, model) {
  const started = Date.now();
  const checkedAt = new Date().toISOString();

  if (isNonChatModel(provider, model)) {
    return {
      model,
      status: "non_chat_endpoint",
      checkedAt,
      message: "Skipped because this model is configured as non-chat.",
      latencyMs: 0,
      active: false,
    };
  }

  if (!provider.apiKey) {
    return {
      model,
      status: "auth_error",
      checkedAt,
      message: `${provider.apiKeyEnv || "API key"} is not set.`,
      latencyMs: 0,
    };
  }

  try {
    if (provider.wireApi === "anthropic") {
      return await probeAnthropicModel(config, provider, model, checkedAt, started);
    }
    return await probeChatModel(config, provider, model, checkedAt, started);
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = String(error?.message || error);
    return {
      model,
      checkedAt,
      status: message.toLowerCase().includes("timeout") || error?.name === "TimeoutError" ? "timeout" : "network_error",
      message,
      latencyMs,
    };
  }
}

