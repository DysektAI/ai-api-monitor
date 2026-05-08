# AI API Monitor

Self-contained, zero-dependency Node.js monitor for AI API endpoints. Track model availability, latency, and uptime across any OpenAI-compatible provider.

## Features

- **Zero dependencies** — uses only Node.js built-ins (≥20)
- **Any provider** — works with any OpenAI-compatible or Anthropic API endpoint
- **Auto-discovery** — fetches available models from `/v1/models` automatically
- **Minimal cost** — health checks use ~2 tokens (1 input + 1 output) per probe
- **Live dashboard** — sortable, filterable web UI with uptime stats and sparklines
- **History** — append-only JSONL history for trend analysis
- **Privacy-first** — API keys never written to state files; `.env` support
- **Screenshot-safe** — "Blur sensitive" mode hides provider/model names

## Quick Start

```bash
# Clone or copy the project
cd ai-api-monitor

# Copy example config and edit
cp config.example.json config.json
cp .env.example .env

# Add your API key(s) to .env
echo "OPENAI_API_KEY=sk-..." >> .env

# Start monitoring
node src/monitor.js

# Browse to the dashboard
# http://127.0.0.1:8791
```

## Configuration

### `config.json`

```json
{
  "host": "127.0.0.1",
  "port": 8791,
  "intervalMinutes": 60,
  "rateLimitPerMinute": 8,
  "requestTimeoutMs": 45000,
  "stateDir": "./state",
  "probePrompt": ".",
  "probeMaxTokens": 1,
  "providers": [
    {
      "id": "openai",
      "label": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "authStyle": "bearer",
      "wireApi": "chat",
      "refreshCatalog": true,
      "probeKeyCatalogModels": true
    }
  ]
}
```

### Provider options

| Field | Description |
|-------|-------------|
| `id` | Short identifier for the provider |
| `label` | Display name in the dashboard |
| `baseUrl` | API base URL (no trailing slash) |
| `apiKeyEnv` | Environment variable name for the API key |
| `apiKeyAliases` | Fallback env var names |
| `authStyle` | `"bearer"` or `"anthropic"` |
| `wireApi` | `"chat"` (OpenAI) or `"anthropic"` (Messages API) |
| `catalogPath` | Path to models list endpoint (default: `/models`) |
| `chatPath` | Path to chat completions (default: `/chat/completions`) |
| `messagesPath` | Path to messages endpoint (default: `/v1/messages`) |
| `refreshCatalog` | Auto-fetch model list from `/models` |
| `probeKeyCatalogModels` | Probe every model in the catalog |
| `probeOnlyListedForKey` | Only probe models returned by `/models` |
| `pruneMissingModels` | Remove models that disappear from catalog |
| `models` | Explicit model list (optional if using catalog) |
| `nonChatModelPrefixes` | Skip models with these prefixes |
| `nonChatModelContains` | Skip models containing these strings |
| `probePrompt` | Prompt text for health check (default: `"."`) |
| `probeMaxTokens` | Max tokens per probe (default: `1`) |
| `systemPrompt` | Optional system message |
| `intervalMinutes` | Probe interval for this provider |

### `.env` file

API keys are loaded from environment variables or a `.env` file:

```bash
# Single provider
OPENAI_API_KEY=sk-...

# Multiple providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
CUSTOM_PROXY_KEY=pk-...
```

## Dashboard

Open `http://127.0.0.1:8791` (or your configured host/port).

> **Security:** The dashboard has no built-in authentication. The `/probe` and `/control` endpoints will spend your API tokens and pause/resume monitoring for anyone who can reach them. Keep `host` bound to `127.0.0.1` (the default) or put it behind a reverse proxy with auth before exposing it on a public interface.

**Columns:**
- **Provider** — provider label with home page link
- **Model** — model ID
- **Status** — current status with history stripe
- **Uptime** — % of successful probes in the selected window
- **Response** — latest and average latency with sparkline
- **TPS** — tokens per second (approximate)
- **Checked** — last probe time
- **Next auto** — next scheduled probe
- **HTTP** — last HTTP status code
- **Message** — last response or error message
- **Probe** — manual check button

**Controls:**
- Text filter across all fields
- Provider and status filters
- Time window selector (affects uptime/averages)
- Pause/resume auto-probes
- Blur sensitive mode for screenshots
- Column visibility toggles

## CLI Options

```bash
node src/monitor.js [options]

  --once              Run one probe cycle and exit
  --no-server         Do not start the dashboard server
  --serve-only        Dashboard only, no auto-probes
  --paused            Start with auto-probes paused
  --resume            Clear persisted pause state
  --config PATH       Custom config.json path
  --models p:m,...    Probe only specific provider:model pairs
  -h, --help          Show help
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/status.json?windowMinutes=1440` | GET | Current state + analytics |
| `/history.jsonl` | GET | Raw probe history |
| `/probe?provider=x&model=y` | POST | Manual probe |
| `/control?action=pause` | POST | Pause/resume auto-probes |

## Probe Cost

The default probe sends a single `.` prompt with `max_tokens: 1`:

```json
{
  "model": "gpt-4o",
  "messages": [{"role": "user", "content": "."}],
  "max_tokens": 1,
  "temperature": 0
}
```

This costs approximately **1 input token + 1 output token** per probe — a ~750x reduction compared to full "PONG" prompts. You can customize `probePrompt` and `probeMaxTokens` per provider if needed.

## State Files

| File | Purpose |
|------|---------|
| `state/status.json` | Latest status snapshot (safe to read, no keys) |
| `state/history.jsonl` | Append-only probe events (safe to read, no keys) |
| `state/monitor.pid` | Running process ID |

These files are gitignored and safe to inspect — they never contain API keys.

## Status Meanings

| Status | Meaning |
|--------|---------|
| `ok` | Model responded with usable text |
| `pending_probe` | In catalog but not yet probed |
| `not_listed` | Not in this key's model catalog |
| `non_chat_endpoint` | Listed but not a chat model |
| `unknown_model` | API rejected the model name |
| `rate_limited` | Hit rate limit (429) |
| `needs_more_tokens` | Response consumed all tokens on reasoning |
| `out_of_credits` | Quota/billing error |
| `access_locked` | Permission/tier/invite required |
| `auth_error` | Invalid or missing API key |
| `client_required` | Provider requires a specific client |
| `timeout` | Request timed out |
| `network_error` | Connection failure |
| `upstream_error` | Provider server error (5xx) |
| `bad_response` | Empty or malformed response |
| `error` | Other failure |

## Multiple Providers Example

```json
{
  "providers": [
    {
      "id": "openai",
      "label": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "refreshCatalog": true,
      "probeKeyCatalogModels": true
    },
    {
      "id": "anthropic",
      "label": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "authStyle": "anthropic",
      "wireApi": "anthropic",
      "refreshCatalog": false,
      "models": ["claude-sonnet-4-20250514", "claude-haiku-4-20250514"]
    },
    {
      "id": "my-proxy",
      "label": "My Proxy",
      "baseUrl": "https://proxy.example.com/v1",
      "apiKeyEnv": "PROXY_API_KEY",
      "refreshCatalog": true,
      "probeOnlyListedForKey": true
    }
  ]
}
```

## License

MIT
