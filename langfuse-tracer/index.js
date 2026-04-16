import fs from 'fs';
import path from 'path';

/**
 * langfuse-tracer — OpenClaw plugin
 *
 * Sends an agent trace + LLM generation to Langfuse after every agent turn.
 * Uses the Langfuse REST API directly (no npm packages required).
 */

export function register(api) {
  const fileConfig = loadLocalConfig();
  const publicKey = (
    process.env.LANGFUSE_PUBLIC_KEY ??
    fileConfig.publicKey ??
    ''
  ).trim();
  const secretKey = (
    process.env.LANGFUSE_SECRET_KEY ??
    fileConfig.secretKey ??
    ''
  ).trim();
  const baseUrl = (
    process.env.LANGFUSE_BASE_URL ??
    fileConfig.baseUrl ??
    'https://cloud.langfuse.com'
  ).trim().replace(/\/$/, '');

  if (!publicKey || !secretKey) {
    api.logger.info('[langfuse-tracer] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set - tracing disabled');
    return;
  }

  const authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  api.logger.info(`[langfuse-tracer] Langfuse tracing enabled -> ${baseUrl}`);

  const pendingPrompts = new Map();

  api.on('before_agent_start', (event, ctx) => {
    const key = ctx.sessionKey ?? ctx.agentId ?? 'default';
    pendingPrompts.set(key, {
      prompt: event.prompt ?? '',
      startedAt: Date.now()
    });
  });

  api.on('agent_end', async (event, ctx) => {
    const { agentId, sessionKey } = ctx;
    const { messages, success, durationMs, error } = event;

    const key = sessionKey ?? agentId ?? 'default';
    const pending = pendingPrompts.get(key);
    pendingPrompts.delete(key);

    const now = new Date().toISOString();
    const startedAt = pending?.startedAt ?? (durationMs ? Date.now() - durationMs : Date.now());
    const startTime = new Date(startedAt).toISOString();

    let input = pending?.prompt ?? '';
    if (!input) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg?.role === 'user') {
          input = extractText(msg.content, 4000);
          break;
        }
      }
    }

    const traceId = randomId();
    const rootSpanId = randomId();
    const batch = [];
    const toolCalls = new Map();
    let toolCount = 0;
    let finalAssistant = null;

    batch.push({
      id: randomId(),
      type: 'trace-create',
      timestamp: startTime,
      body: {
        id: traceId,
        name: 'openclaw.turn',
        sessionId: sessionKey ?? undefined,
        userId: agentId ?? 'unknown',
        tags: ['openclaw', agentId ?? 'unknown'],
        input: input || undefined,
        metadata: {
          success,
          error: error ?? undefined,
          messageCount: Array.isArray(messages) ? messages.length : 0
        },
        timestamp: startTime
      }
    });

    batch.push({
      id: randomId(),
      type: 'span-create',
      timestamp: startTime,
      body: {
        id: rootSpanId,
        traceId,
        name: 'openclaw.turn',
        startTime,
        metadata: {
          sessionKey: sessionKey ?? undefined,
          source: 'langfuse-tracer'
        }
      }
    });

    for (const msg of Array.isArray(messages) ? messages : []) {
      if (!msg || typeof msg !== 'object') continue;

      if (msg.role === 'assistant') {
        for (const part of Array.isArray(msg.content) ? msg.content : []) {
          if (part?.type !== 'toolCall') continue;
          const toolCallId = String(part.id ?? randomId());
          toolCalls.set(toolCallId, {
            name: part.name || 'tool',
            args: toolCallArgs(part),
            startedAt: toIsoString(msg.timestamp, startTime)
          });
        }
        const assistantText = extractText(msg.content, 8000);
        if (assistantText) finalAssistant = msg;
      }

      if (msg.role === 'toolResult') {
        const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
        const known = toolCalls.get(toolCallId) || {};
        const toolName = msg.toolName || known.name || 'tool';
        const outputText = extractText(msg.content, 4000) || extractAggregatedText(msg.details, 3000);
        const toolTimestamp = toIsoString(msg.timestamp, now);
        batch.push({
          id: randomId(),
          type: 'span-create',
          timestamp: toolTimestamp,
          body: {
            id: randomId(),
            traceId,
            parentObservationId: rootSpanId,
            name: `tool.${toolName}`,
            startTime: known.startedAt || toolTimestamp,
            endTime: toolTimestamp,
            level: msg.isError ? 'ERROR' : 'DEFAULT',
            statusMessage: msg.isError ? 'tool failed' : 'ok',
            input: known.args,
            output: outputText || undefined,
            metadata: {
              toolName,
              toolCallId: toolCallId || undefined,
              isError: Boolean(msg.isError),
              durationMs: msg.details?.durationMs,
              exitCode: msg.details?.exitCode,
              cwd: msg.details?.cwd
            }
          }
        });
        toolCount += 1;
      }
    }

    let usage;
    let model;
    if (finalAssistant?.usage) {
      const u = finalAssistant.usage;
      usage = {
        input: typeof u.input === 'number' ? u.input : undefined,
        output: typeof u.output === 'number' ? u.output : undefined,
        total: typeof u.totalTokens === 'number' ? u.totalTokens : undefined,
        unit: 'TOKENS'
      };
    }
    if (typeof finalAssistant?.model === 'string') model = finalAssistant.model;

    if (finalAssistant) {
      const generationId = randomId();
      const generationEnd = toIsoString(finalAssistant.timestamp, now);
      const generationOutput = extractText(finalAssistant.content, 8000);

      batch.push({
        id: randomId(),
        type: 'generation-create',
        timestamp: generationEnd,
        body: {
          id: generationId,
          traceId,
          parentObservationId: rootSpanId,
          name: 'assistant.generation',
          model: model ?? undefined,
          startTime,
          endTime: generationEnd,
          input: input || undefined,
          output: generationOutput || undefined,
          level: success ? 'DEFAULT' : 'ERROR',
          statusMessage: error ?? undefined,
          usage,
          metadata: {
            durationMs,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            sessionKey: sessionKey ?? undefined,
            provider: finalAssistant.provider ?? undefined,
            assistantMessageId: finalAssistant.id ?? undefined,
            toolCount
          },
          ...(finalAssistant.usage?.cost?.total != null
            ? { costDetails: { total: Number(finalAssistant.usage.cost.total) } }
            : {})
        }
      });

      batch.push({
        id: randomId(),
        type: 'span-update',
        timestamp: generationEnd,
        body: {
          id: rootSpanId,
          traceId,
          endTime: generationEnd,
          output: generationOutput || undefined
        }
      });

      batch.push({
        id: randomId(),
        type: 'trace-create',
        timestamp: generationEnd,
        body: {
          id: traceId,
          name: 'openclaw.turn',
          sessionId: sessionKey ?? undefined,
          userId: agentId ?? 'unknown',
          tags: ['openclaw', agentId ?? 'unknown'],
          input: input || undefined,
          output: generationOutput || undefined,
          metadata: {
            durationMs,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            toolCount,
            success,
            error: error ?? undefined
          },
          timestamp: startTime
        }
      });
    }

    try {
      const res = await fetch(`${baseUrl}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ batch })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        api.logger.warn(`[langfuse-tracer] Ingestion failed ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      api.logger.warn(`[langfuse-tracer] Fetch error: ${String(err)}`);
    }
  });
}

function extractText(content, maxLen) {
  if (typeof content === 'string') return content.slice(0, maxLen);
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
      .slice(0, maxLen);
  }
  return '';
}

function extractAggregatedText(details, maxLen) {
  if (!details || typeof details !== 'object') return '';
  return typeof details.aggregated === 'string' ? details.aggregated.slice(0, maxLen) : '';
}

function toolCallArgs(part) {
  if (part?.arguments && typeof part.arguments === 'object') {
    try {
      return JSON.stringify(part.arguments).slice(0, 12000);
    } catch {
      return '';
    }
  }
  if (typeof part?.partialJson === 'string') return part.partialJson.slice(0, 12000);
  return '';
}

function toIsoString(value, fallback) {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

function randomId() {
  return crypto.randomUUID();
}

function loadLocalConfig() {
  try {
    const home = process.env.HOME;
    if (!home) return {};
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed?.plugins?.entries?.['langfuse-tracer']?.config ?? {};
  } catch {
    return {};
  }
}
