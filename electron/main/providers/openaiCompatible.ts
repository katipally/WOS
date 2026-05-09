/**
 * OpenAICompatibleProvider — single class that talks to any provider speaking
 * either the modern Responses API or the older Chat Completions API. The
 * upstream's actual capability is decided once via `probeApiStyle()` on Add
 * Provider; subsequent stream() calls dispatch to the matching path. Both
 * paths emit the same StreamEvent union as OpenAIProvider so the runner stays
 * style-agnostic.
 */
import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type {
  ApiStyle,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  StreamEvent,
} from './types'
import { OpenAIProvider } from './openai'
import { getDecryptedApiKeyForInstance } from './keystore'
import { enrichModel, modelSupportsReasoning } from './capabilities'

const PROBE_TIMEOUT_MS = 5_000

export interface ProbeResult {
  apiStyle: ApiStyle
  /** Supports reasoning fields (best-effort detection). */
  supportsReasoning?: boolean
  /** Reachable models discovered while probing (best-effort). */
  models: ModelInfo[]
}

export interface OpenAICompatibleOptions {
  providerId: string
  baseURL: string
  apiStyle: ApiStyle
  customHeaders?: Record<string, string>
}

function buildClient(opts: { apiKey: string; baseURL: string; customHeaders?: Record<string, string> }): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    ...(opts.customHeaders ? { defaultHeaders: opts.customHeaders } : {}),
  })
}

/** Convert WOS conversation messages into Chat Completions format. */
function toChatMessages(messages: ModelRequest['messages'], systemPrompt: string): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = m.content
    const textParts: string[] = []
    const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = []
    const toolResults: ChatCompletionMessageParam[] = []
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        textParts.push(b.text)
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id ?? '',
          type: 'function',
          function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
        })
      } else if (b.type === 'tool_result') {
        const raw = b.content
        const content = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
        toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id ?? '', content })
      }
    }
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: textParts.join('') || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
    } else if (m.role === 'user') {
      if (textParts.length) out.push({ role: 'user', content: textParts.join('') })
    }
    out.push(...toolResults)
  }
  return out
}

function toChatTools(tools: ModelRequest['tools']): ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }))
}

/**
 * Reformat opaque upstream errors (especially 401s with no body) into
 * actionable messages so the chat UI tells the user how to fix it instead
 * of showing raw OpenAI SDK strings.
 */
function clarifyAuthError(err: unknown, baseURL?: string): Error {
  const status = (err as { status?: number })?.status
  const msg = (err as Error)?.message || String(err)
  if (status === 401 || /401/.test(msg)) {
    const where = baseURL ? ` (${baseURL})` : ''
    const e = new Error(
      `Upstream rejected the API key${where}. Open Settings → Providers, ` +
      `confirm the key is correct (no extra whitespace), and that the model ` +
      `belongs to this provider. Then retry.`,
    )
    ;(e as Error & { status?: number }).status = 401
    return e
  }
  return err instanceof Error ? err : new Error(msg)
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly opts: OpenAICompatibleOptions) {}

  async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const overrideKey = request.apiKeyOverride && request.apiKeyOverride.length > 0
      ? request.apiKeyOverride
      : undefined
    const apiKey = overrideKey ?? await getDecryptedApiKeyForInstance(request.providerId ?? this.opts.providerId)
    if (this.opts.apiStyle === 'responses') {
      // Reuse the Responses API path implemented in OpenAIProvider.
      const inner = new OpenAIProvider({
        providerId: this.opts.providerId,
        baseURL: this.opts.baseURL,
        customHeaders: this.opts.customHeaders,
      })
      yield* inner.stream({ ...request, apiKeyOverride: apiKey })
      return
    }
    yield* this.streamChatCompletions({ ...request, apiKeyOverride: apiKey })
  }

  /** Chat-Completions streaming path. Translates SSE deltas into StreamEvents. */
  private async *streamChatCompletions(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const apiKey = request.apiKeyOverride!
    const client = buildClient({ apiKey, baseURL: this.opts.baseURL, customHeaders: this.opts.customHeaders })
    const messages = toChatMessages(request.messages, request.systemPrompt || '')
    const tools = toChatTools(request.tools)

    let inputTokens = 0
    let outputTokens = 0
    const toolCalls: Map<number, { id: string; name: string; argsBuf: string; emittedStart: boolean }> = new Map()

    // Reasoning forwarding: when the model is flagged reasoning-capable (e.g.
    // Qwen3 on vLLM/RunPod), pass the canonical OpenAI `reasoning_effort` field
    // and vLLM's `chat_template_kwargs.enable_thinking` simultaneously. Most
    // vLLM versions accept either; ones that ignore both still accept the
    // request and just won't emit `reasoning_content` deltas.
    const reasoningCapable = modelSupportsReasoning(request.model)
    const effort = (request.reasoningEffort === 'max' ? 'high' : request.reasoningEffort) as
      'low' | 'medium' | 'high' | undefined
    const enableThinking = reasoningCapable && !!effort
    const extraReasoningBody = enableThinking
      ? {
          reasoning_effort: effort,
          chat_template_kwargs: { enable_thinking: true },
        }
      : {}

    try {
      const stream = await client.chat.completions.create(
        {
          model: request.model,
          messages,
          ...(tools.length ? { tools } : {}),
          stream: true,
          stream_options: { include_usage: true },
          // Reasoning models can spend many tokens thinking before answering;
          // give them more headroom than the chat default.
          max_tokens: request.maxTokens ?? (reasoningCapable ? 32768 : 16384),
          ...(extraReasoningBody as Record<string, unknown>),
        },
        { signal: request.signal },
      )

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0]
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens
          outputTokens = chunk.usage.completion_tokens ?? outputTokens
        }
        if (!choice) continue

        const delta = choice.delta as {
          content?: string
          reasoning_content?: string
          reasoning?: string
          tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
        }
        // vLLM (with --reasoning-parser) and some other OpenAI-compat servers
        // stream thinking output in `delta.reasoning_content`. Map it to the
        // same `thinking_delta` event Anthropic uses so the runner's existing
        // reasoning UI lights up.
        const thinking = delta.reasoning_content ?? delta.reasoning
        if (thinking) {
          yield { type: 'thinking_delta', content: thinking }
        }
        if (delta.content) {
          yield { type: 'text_delta', content: delta.content }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            let entry = toolCalls.get(idx)
            if (!entry) {
              entry = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', argsBuf: '', emittedStart: false }
              toolCalls.set(idx, entry)
            }
            if (tc.id && !entry.id.startsWith('call_')) entry.id = tc.id
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            if (entry.name && !entry.emittedStart) {
              entry.emittedStart = true
              yield { type: 'tool_preparing', id: entry.id, name: entry.name }
            }
            const argDelta = tc.function?.arguments ?? ''
            if (argDelta) {
              entry.argsBuf += argDelta
              yield { type: 'tool_arg_delta', id: entry.id, delta: argDelta }
            }
          }
        }
        if (choice.finish_reason) {
          for (const entry of toolCalls.values()) {
            let parsed: unknown = {}
            try { parsed = JSON.parse(entry.argsBuf || '{}') } catch { /* leave {} */ }
            yield { type: 'tool_use_start', id: entry.id, name: entry.name, input: parsed }
          }
          yield {
            type: 'message_stop',
            stopReason: choice.finish_reason === 'tool_calls' || toolCalls.size > 0 ? 'tool_use' : 'end_turn',
            usage: { inputTokens, outputTokens },
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (request.signal?.aborted) return
      // Always log to stderr so the dev tools console shows what went wrong.
      // Without this, "no response" appears as silently empty UI when an
      // upstream returns 400/401/timeout.
      const msg = (err as Error)?.message || String(err)
      console.error(
        `[wos:provider] chat-completions stream failed against ${this.opts.baseURL} (model=${request.model}): ${msg}`,
      )
      // vLLM versions without `--reasoning-parser` reject `reasoning_effort`
      // and `chat_template_kwargs` with a 400. If we sent those and the request
      // failed, retry once without them so reasoning-capable models still
      // respond on older runtimes.
      if (enableThinking && /reasoning|chat_template_kwargs|extra_body|400|unsupported|unknown/i.test(msg)) {
        try {
          const retryStream = await client.chat.completions.create(
            {
              model: request.model,
              messages,
              ...(tools.length ? { tools } : {}),
              stream: true,
              stream_options: { include_usage: true },
              max_tokens: request.maxTokens ?? (reasoningCapable ? 32768 : 16384),
            },
            { signal: request.signal },
          )
          for await (const chunk of retryStream) {
            const choice = chunk.choices?.[0]
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens
              outputTokens = chunk.usage.completion_tokens ?? outputTokens
            }
            if (!choice) continue
            const delta = choice.delta as {
              content?: string
              tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
            }
            if (delta.content) yield { type: 'text_delta', content: delta.content }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                let entry = toolCalls.get(idx)
                if (!entry) {
                  entry = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', argsBuf: '', emittedStart: false }
                  toolCalls.set(idx, entry)
                }
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.name = tc.function.name
                if (entry.name && !entry.emittedStart) {
                  entry.emittedStart = true
                  yield { type: 'tool_preparing', id: entry.id, name: entry.name }
                }
                const argDelta = tc.function?.arguments ?? ''
                if (argDelta) {
                  entry.argsBuf += argDelta
                  yield { type: 'tool_arg_delta', id: entry.id, delta: argDelta }
                }
              }
            }
            if (choice.finish_reason) {
              for (const entry of toolCalls.values()) {
                let parsed: unknown = {}
                try { parsed = JSON.parse(entry.argsBuf || '{}') } catch { /* leave {} */ }
                yield { type: 'tool_use_start', id: entry.id, name: entry.name, input: parsed }
              }
              yield {
                type: 'message_stop',
                stopReason: choice.finish_reason === 'tool_calls' || toolCalls.size > 0 ? 'tool_use' : 'end_turn',
                usage: { inputTokens, outputTokens },
              }
            }
          }
          return
        } catch (retryErr) {
          console.error(
            `[wos:provider] retry without reasoning fields also failed against ${this.opts.baseURL}: ${(retryErr as Error)?.message ?? retryErr}`,
          )
          throw retryErr
        }
      }
      throw clarifyAuthError(err, this.opts.baseURL)
    }
  }

  async fetchModels(apiKey: string): Promise<ModelInfo[]> {
    const client = buildClient({ apiKey, baseURL: this.opts.baseURL, customHeaders: this.opts.customHeaders })
    try {
      const models = await client.models.list()
      return models.data.map(m => ({
        ...enrichModel({ id: m.id, name: m.id }),
        providerId: this.opts.providerId,
        kind: 'openai-compatible' as const,
        // Re-evaluate per id without the heuristic anchored to OpenAI naming —
        // OpenAI-compatible vendors often use arbitrary names, so respect any
        // capability hints already provided via enrichModel.
        supportsReasoning: modelSupportsReasoning(m.id),
      }))
    } catch (err) {
      throw new Error(`fetchModels failed against ${this.opts.baseURL}: ${(err as Error).message}`)
    }
  }
}

/**
 * Probe an upstream once to decide which API style to use. Tries Responses
 * first (modern); falls back to Chat Completions on a 4xx style mismatch.
 * Lists available models as a side-effect.
 */
export async function probeApiStyle(opts: {
  baseURL: string
  apiKey: string
  customHeaders?: Record<string, string>
}): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const client = buildClient(opts)
    let models: ModelInfo[] = []
    try {
      const list = await client.models.list({ signal: ctrl.signal })
      models = list.data.map(m => ({
        ...enrichModel({ id: m.id, name: m.id }),
        providerId: 'probe', // overwritten by caller after persistence
        kind: 'openai-compatible' as const,
      }))
    } catch { /* models endpoint not required for the probe */ }

    // Try a tiny Responses ping. If the endpoint or shape is unsupported we
    // fall back to Chat Completions.
    const sample = models[0]?.id || 'gpt-4o-mini'
    try {
      await client.responses.create(
        { model: sample, input: 'ping', max_output_tokens: 16, stream: false },
        { signal: ctrl.signal },
      )
      return { apiStyle: 'responses', models }
    } catch (err) {
      const msg = (err as Error).message.toLowerCase()
      // 404 / Not Found / unrecognized → fall through to chat.completions probe
      if (!/responses|404|not\s*found|unsupported|invalid_url/i.test(msg)) {
        // Genuine error (auth, network) — surface so the user sees it.
        if (/401|403|invalid api key|unauthor/i.test(msg)) throw err
      }
    }

    try {
      await client.chat.completions.create(
        { model: sample, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 },
        { signal: ctrl.signal },
      )
      return { apiStyle: 'chat-completions', models }
    } catch (err) {
      throw new Error(`Provider probe failed: ${(err as Error).message}`)
    }
  } finally {
    clearTimeout(timer)
  }
}
