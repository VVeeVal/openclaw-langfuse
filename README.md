# openclaw-langfuse

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that sends agent traces to [Langfuse](https://langfuse.com) for LLM observability — works with both self-hosted and Langfuse Cloud.

**No npm packages required** — uses the Langfuse REST API directly via Node.js native `fetch`.
**No image rebuild required** — drop the plugin into your workspace volume and restart.

---

## What it gives you

For every agent turn, the plugin records a **trace** + **generation** in Langfuse:

| Field | Value |
|---|---|
| **Trace name** | `openclaw-turn` |
| **Session ID** | OpenClaw session key (e.g. `agent:main:discord:dm:123456`) |
| **User ID** | Agent ID (e.g. `main`, `jarvis`) |
| **Tags** | `["openclaw", "<agentId>"]` — filter Sage vs Jarvis traces |
| **Input** | The user's message |
| **Output** | The agent's response |
| **Token usage** | Input + output tokens |
| **Duration** | Turn duration in ms |
| **Level** | `DEFAULT` on success, `ERROR` on failure |

In the Langfuse UI this means:

- **Traces** — every conversation turn as a timeline with input/output
- **Sessions** — all turns from a single conversation grouped together so you can follow the full thread
- **Generations** — the LLM call nested inside each trace (model, token counts, latency)
- **Analytics** — token usage over time, cost estimates, latency histograms, error rates by agent

---

## Installation

### 1. Create the extensions directory on your NAS

```bash
ssh user@your-nas 'mkdir -p /volume1/docker/openclaw/workspace/.openclaw/extensions'
```

### 2. Copy the plugin

**Option A — tar pipe (recommended for Synology, avoids SCP subsystem errors):**

```bash
tar -czf - langfuse-tracer/ | ssh user@your-nas \
  'cd /volume1/docker/openclaw/workspace/.openclaw/extensions && tar -xzf -'
```

**Option B — SCP (works on standard Linux hosts):**

```bash
scp -r langfuse-tracer/ user@your-host:/path/to/openclaw/workspace/.openclaw/extensions/
```

The plugin auto-discovers at startup from:
```
{workspaceDir}/.openclaw/extensions/langfuse-tracer/
```

### 3. Get your Langfuse API keys

Log into your Langfuse UI → **Settings → API Keys** and copy the project public key (`pk-lf-...`) and secret key (`sk-lf-...`).

> **Self-hosted Portainer tip:** If you initialized Langfuse with `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `LANGFUSE_INIT_PROJECT_SECRET_KEY` environment variables in your stack, those are the same keys — just copy them into the openclaw stack.

### 4. Add environment variables to openclaw-gateway

In Portainer, add to the openclaw-gateway stack environment:

```yaml
environment:
  LANGFUSE_PUBLIC_KEY: pk-lf-xxxxxxxxxxxxxxxxxxxx
  LANGFUSE_SECRET_KEY: sk-lf-xxxxxxxxxxxxxxxxxxxx
  LANGFUSE_BASE_URL: http://172.21.0.1:3050
```

See [LANGFUSE_BASE_URL reference](#langfuse_base_url-reference) below for the right URL for your setup.

### 5. Redeploy the container

In Portainer: **Redeploy** the openclaw-gateway stack. The plugin loads at startup.

To verify it loaded, check the container logs for:
```
[langfuse-tracer] Langfuse tracing enabled → http://172.21.0.1:3050
```

If keys are missing or wrong:
```
[langfuse-tracer] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — tracing disabled
```

---

## LANGFUSE_BASE_URL reference

| Deployment | URL |
|---|---|
| OpenClaw in Docker on same host as Langfuse (Synology/NAS) | `http://172.21.0.1:3050` |
| OpenClaw and Langfuse in the same Docker Compose stack | `http://langfuse-web:3000` |
| Langfuse on a different machine on your LAN | `http://<langfuse-host-ip>:3050` |
| Langfuse Cloud | `https://cloud.langfuse.com` |

> The `172.21.0.1` address is the Docker bridge gateway — it routes from inside the openclaw container to services running on the Docker host. Use `docker network inspect <network>` to confirm your gateway IP if different.

---

## How it works

OpenClaw's plugin system auto-discovers plugins from `{workspaceDir}/.openclaw/extensions/` at startup. The plugin registers two hooks:

- **`before_agent_start`** — captures the incoming prompt and records the start time
- **`agent_end`** — fires after the turn completes; extracts the response, token usage, and duration, then sends a single `POST /api/public/ingestion` batch call containing a `trace-create` + `generation-create` event

The plugin **fails silently** — if keys are missing, Langfuse is unreachable, or an ingestion call fails, it logs a warning and continues. It will never crash or block the agent.

---

## File structure

```
langfuse-tracer/
├── openclaw.plugin.json   # Plugin manifest (id, name, version, configSchema)
└── index.js               # Plugin implementation (no dependencies)
```

---

## Requirements

- OpenClaw gateway `2026.2.x` or later (plugin API `api.on()` hook support)
- Node.js 22+ (included in the official `ghcr.io/openclaw/openclaw:latest` image)
- Self-hosted Langfuse or Langfuse Cloud

---

## Troubleshooting

**No traces appearing in Langfuse**
1. Confirm the plugin loaded — check container logs for `[langfuse-tracer] Langfuse tracing enabled`
2. Check `LANGFUSE_BASE_URL` is reachable from inside the container: `docker exec openclaw-gateway wget -q -O- http://172.21.0.1:3050/api/public/health`
3. Verify the API keys are correct — Langfuse UI → Settings → API Keys

**Container won't start after adding env vars**
- Unrelated to this plugin — check the openclaw config (`openclaw.json`) for schema errors. The plugin only reads env vars; it cannot cause startup failures.

**Traces missing input/output text**
- The plugin captures up to 2000 chars of input and 4000 chars of output. Longer messages are truncated at those limits.
