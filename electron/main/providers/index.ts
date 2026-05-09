/**
 * Provider registry — multi-instance.
 *
 * The legacy registry hard-coded one OpenAI and one Anthropic provider and
 * routed by model-id prefix. The new registry treats every provider as a row
 * in the `provider_instances` table and dispatches by either:
 *   - explicit providerId (preferred), or
 *   - model-id lookup against each instance's persisted modelsJson, with a
 *     conservative legacy prefix fallback for the bundled built-ins.
 */
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { encryptApiKey } from '../crypto'
import { getDb, schema } from '../db'
import type { ApiStyle, ModelInfo, ModelProvider, ProviderKind } from './types'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatibleProvider, probeApiStyle } from './openaiCompatible'
import { getDecryptedApiKeyForInstance } from './keystore'

export interface ProviderInstanceSummary {
  id: string
  kind: ProviderKind
  label: string
  baseUrl: string | null
  apiStyle: ApiStyle | null
  enabled: boolean
  models: ModelInfo[]
  customHeaders: Record<string, string> | null
  hasApiKey: boolean
}

function rowToSummary(row: typeof schema.providerInstances.$inferSelect): ProviderInstanceSummary {
  // drizzle returns json/timestamp columns already parsed.
  const models = Array.isArray(row.modelsJson) ? row.modelsJson as ModelInfo[] : []
  const customHeaders = (row.customHeadersJson && typeof row.customHeadersJson === 'object'
    ? row.customHeadersJson as Record<string, string>
    : null)
  return {
    id: row.id,
    kind: row.kind as ProviderKind,
    label: row.label,
    baseUrl: row.baseUrl,
    apiStyle: row.apiStyle as ApiStyle | null,
    enabled: !!row.enabled,
    models,
    customHeaders,
    hasApiKey: !!row.encryptedKey,
  }
}

/** Instantiate the streaming adapter for a given provider instance row. */
function adapterFor(row: typeof schema.providerInstances.$inferSelect, modelId?: string): ModelProvider {
  const kind = row.kind as ProviderKind
  const customHeaders = (row.customHeadersJson && typeof row.customHeadersJson === 'object')
    ? row.customHeadersJson as Record<string, string>
    : undefined
  if (kind === 'openai') {
    return new OpenAIProvider({
      providerId: row.id,
      baseURL: row.baseUrl ?? undefined,
      customHeaders,
    })
  }
  if (kind === 'anthropic') {
    return new AnthropicProvider({ providerId: row.id })
  }
  if (kind === 'runpod') {
    // RunPod stores baseUrl PER-MODEL: each serverless endpoint is its own URL
    // like https://api.runpod.ai/v2/{endpointId}/openai/v1. We resolve the URL
    // by looking up the model's entry in modelsJson.
    const models = Array.isArray(row.modelsJson) ? row.modelsJson as ModelInfo[] : []
    let baseURL = ''
    if (modelId) {
      const m = models.find(x => x.id === modelId)
      if (m?.baseUrl) baseURL = m.baseUrl
    }
    if (!baseURL) {
      throw new Error(
        `RunPod model ${modelId ? `"${modelId}" ` : ''}has no base URL configured. ` +
        `Add the model in Settings → Providers and paste its endpoint URL.`,
      )
    }
    return new OpenAICompatibleProvider({
      providerId: row.id,
      baseURL,
      apiStyle: 'chat-completions',
      customHeaders,
    })
  }
  // openai-compatible: single shared base URL.
  return new OpenAICompatibleProvider({
    providerId: row.id,
    baseURL: row.baseUrl ?? '',
    apiStyle: (row.apiStyle as ApiStyle) || 'chat-completions',
    customHeaders,
  })
}

export function listProviderInstances(): ProviderInstanceSummary[] {
  const db = getDb()
  return db.select().from(schema.providerInstances).all().map(rowToSummary)
}

export function getProviderInstance(id: string): ProviderInstanceSummary | null {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, id)).get()
  return row ? rowToSummary(row) : null
}

/** Get the adapter for a specific provider instance id. For runpod, a modelId
 *  is required because every model has its own base URL. */
export function getProviderById(providerId: string, modelId?: string): ModelProvider {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, providerId)).get()
  if (!row) throw new Error(`Unknown provider instance "${providerId}". Configure it in Settings → Providers.`)
  return adapterFor(row, modelId)
}

/**
 * Find the right adapter for a model id. Search order:
 *   1. Each enabled provider_instances row whose modelsJson contains the id.
 *   2. Built-in 'anthropic' instance for `claude*` ids.
 *   3. Built-in 'openai' instance for OpenAI-shaped ids (gpt-*, o1-*, …).
 * Throws if nothing matches.
 */
export function getProviderForModel(model: string): ModelProvider {
  const db = getDb()
  const rows = db.select().from(schema.providerInstances).all()
  // Find a row matching this model id within any enabled instance.
  for (const row of rows) {
    if (!row.enabled) continue
    const ids = Array.isArray(row.modelsJson) ? row.modelsJson as Array<{ id: string }> : []
    if (ids.some(m => m.id === model)) return adapterFor(row, model)
  }
  // Legacy prefix fallback against built-ins.
  if (model.startsWith('claude')) {
    const ant = rows.find(r => r.id === 'anthropic')
    if (ant) return adapterFor(ant, model)
  }
  if (model.startsWith('gpt-') || /^o\d/.test(model) || model.startsWith('chatgpt')) {
    const oa = rows.find(r => r.id === 'openai')
    if (oa) return adapterFor(oa, model)
  }
  throw new Error(
    `No provider instance lists model "${model}". ` +
    `Add it under Settings → Providers, or refresh the model list for the relevant provider.`,
  )
}

/** Compatibility shim — old name, same behavior. */
export const getProvider = getProviderForModel

// ── CRUD: provider instances ────────────────────────────────────────────────

export interface AddProviderOptions {
  kind: ProviderKind
  label: string
  apiKey: string
  baseUrl?: string
  customHeaders?: Record<string, string>
  /** When omitted on openai-compatible kinds, probeApiStyle() is invoked. */
  apiStyle?: ApiStyle
  /** Optional explicit id (e.g. 'openai' / 'anthropic' for built-ins). */
  id?: string
}

export async function addProviderInstance(opts: AddProviderOptions): Promise<ProviderInstanceSummary> {
  const db = getDb()
  if (!opts.label || !opts.label.trim()) throw new Error('Label is required.')
  if (!opts.apiKey || !opts.apiKey.trim()) throw new Error('API key is required.')

  const id = opts.id ?? randomUUID()
  let apiStyle: ApiStyle | null = opts.apiStyle ?? (opts.kind === 'anthropic' ? null : 'responses')
  let models: ModelInfo[] = []

  if (opts.kind === 'openai-compatible') {
    if (!opts.baseUrl || !opts.baseUrl.trim()) {
      throw new Error('Base URL is required for openai-compatible providers.')
    }
    const probe = await probeApiStyle({ baseURL: opts.baseUrl, apiKey: opts.apiKey, customHeaders: opts.customHeaders })
    apiStyle = opts.apiStyle ?? probe.apiStyle
    models = probe.models.map(m => ({ ...m, providerId: id }))
  } else if (opts.kind === 'runpod') {
    // RunPod has NO provider-level base URL — each model is its own serverless
    // endpoint with its own URL. We just store the API key here; models are
    // added later one-by-one with their own base URLs via addManualModel().
    apiStyle = 'chat-completions'
    models = []
  }

  const enc = encryptApiKey(opts.apiKey)
  const nowDate = new Date()
  // RunPod has no provider-level base URL; force null regardless of input.
  const rowBaseUrl = opts.kind === 'runpod' ? null : (opts.baseUrl ?? null)
  db.insert(schema.providerInstances).values({
    id,
    kind: opts.kind,
    label: opts.label,
    baseUrl: rowBaseUrl,
    apiStyle,
    encryptedKey: enc.encrypted,
    iv: enc.iv,
    modelsJson: models,
    capabilitiesJson: null,
    customHeadersJson: opts.customHeaders ?? null,
    enabled: true,
    createdAt: nowDate,
    updatedAt: nowDate,
  }).onConflictDoUpdate({
    target: schema.providerInstances.id,
    set: {
      kind: opts.kind,
      label: opts.label,
      baseUrl: rowBaseUrl,
      apiStyle,
      encryptedKey: enc.encrypted,
      iv: enc.iv,
      customHeadersJson: opts.customHeaders ?? null,
      enabled: true,
      updatedAt: nowDate,
    },
  }).run()

  // Best-effort initial models fetch for built-in kinds (openai-compatible &
  // runpod already populated above).
  if (opts.kind !== 'openai-compatible' && opts.kind !== 'runpod') {
    try {
      const adapter = adapterFor({
        id, kind: opts.kind, label: opts.label, baseUrl: rowBaseUrl,
        apiStyle, encryptedKey: enc.encrypted, iv: enc.iv, modelsJson: [],
        capabilitiesJson: null, customHeadersJson: opts.customHeaders ?? null,
        enabled: true, createdAt: nowDate, updatedAt: nowDate,
      })
      const fetched = await adapter.fetchModels(opts.apiKey)
      db.update(schema.providerInstances)
        .set({ modelsJson: fetched, updatedAt: new Date() })
        .where(eq(schema.providerInstances.id, id))
        .run()
    } catch {
      // If the upstream blocks `models.list`, leave modelsJson empty — the
      // user can pick a model manually and Refresh later.
    }
  }

  return getProviderInstance(id)!
}

export interface UpdateProviderOptions {
  label?: string
  baseUrl?: string | null
  customHeaders?: Record<string, string> | null
  apiKey?: string
  enabled?: boolean
}

export async function updateProviderInstance(id: string, patch: UpdateProviderOptions): Promise<ProviderInstanceSummary> {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, id)).get()
  if (!row) throw new Error(`Unknown provider instance "${id}".`)
  const set: Partial<typeof schema.providerInstances.$inferInsert> = { updatedAt: new Date() }
  if (patch.label !== undefined) set.label = patch.label
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl
  if (patch.customHeaders !== undefined) {
    set.customHeadersJson = patch.customHeaders ?? null
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  if (patch.apiKey) {
    const enc = encryptApiKey(patch.apiKey)
    set.encryptedKey = enc.encrypted
    set.iv = enc.iv
  }
  db.update(schema.providerInstances).set(set).where(eq(schema.providerInstances.id, id)).run()
  return getProviderInstance(id)!
}

export function removeProviderInstance(id: string): void {
  const db = getDb()
  db.delete(schema.providerInstances).where(eq(schema.providerInstances.id, id)).run()
}

export interface ManualModelInput {
  id?: string
  /** Required for runpod: the per-model serverless endpoint base URL,
   *  e.g. `https://api.runpod.ai/v2/{endpointId}/openai/v1`. */
  baseUrl?: string
  name?: string
  contextWindow?: number | null
  supportsReasoning?: boolean
}

/** Normalize a runpod base URL: trim, strip trailing slash, append `/openai/v1`
 *  if the user pasted only the bare endpoint root. */
function normalizeRunpodBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  // Strip trailing /chat/completions or /completions if user pasted the full path.
  url = url.replace(/\/(chat\/)?completions$/, '')
  // If user pasted just `https://api.runpod.ai/v2/{id}` (no /openai/v1), add it.
  if (/api\.runpod\.ai\/v2\/[^/]+$/.test(url)) {
    url = `${url}/openai/v1`
  }
  return url
}

/**
 * Append a manually-entered model to a provider's modelsJson, de-duped by id.
 *
 * For `openai-compatible`: uses the provided `id` directly.
 *
 * For `runpod`: requires `baseUrl`. Probes `${baseUrl}/models` with the
 * provider's stored apiKey and uses the first returned id. Falls back to a
 * caller-supplied `id` if the probe fails.
 */
export async function addManualModel(providerId: string, input: ManualModelInput): Promise<ModelInfo[]> {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, providerId)).get()
  if (!row) throw new Error(`Unknown provider instance "${providerId}".`)

  const kind: ModelInfo['kind'] = (
    row.kind === 'runpod' ? 'runpod'
    : row.kind === 'openai-compatible' ? 'openai-compatible'
    : (row.kind as ModelInfo['kind'])
  )

  let resolvedId = input.id?.trim() ?? ''
  let resolvedBaseUrl: string | undefined

  if (kind === 'runpod') {
    if (!input.baseUrl || !input.baseUrl.trim()) {
      throw new Error('Base URL is required for RunPod models (e.g. https://api.runpod.ai/v2/{endpointId}/openai/v1).')
    }
    resolvedBaseUrl = normalizeRunpodBaseUrl(input.baseUrl)
    // Probe /v1/models to discover the served model id. Each RunPod endpoint
    // serves exactly one model; the response shape is {data:[{id:"…"}]}.
    try {
      const apiKey = await getDecryptedApiKeyForInstance(providerId)
      const probe = new OpenAICompatibleProvider({
        providerId,
        baseURL: resolvedBaseUrl,
        apiStyle: 'chat-completions',
        customHeaders: (row.customHeadersJson && typeof row.customHeadersJson === 'object')
          ? row.customHeadersJson as Record<string, string>
          : undefined,
      })
      const fetched = await probe.fetchModels(apiKey)
      if (fetched.length > 0 && fetched[0]?.id) {
        resolvedId = fetched[0].id
      }
    } catch (err) {
      // Probe failed — require user-supplied id as a fallback.
      if (!resolvedId) {
        throw new Error(
          `Couldn't fetch model id from ${resolvedBaseUrl}/models: ${(err as Error).message}. ` +
          `Check the base URL and API key, or provide a model id manually.`,
        )
      }
    }
    if (!resolvedId) {
      throw new Error(`No model id returned from ${resolvedBaseUrl}/models. Provide one manually.`)
    }
  } else {
    if (!resolvedId) throw new Error('Model id is required.')
  }

  const existing: ModelInfo[] = Array.isArray(row.modelsJson) ? row.modelsJson as ModelInfo[] : []
  const filtered = existing.filter(m => m.id !== resolvedId)
  const next: ModelInfo = {
    id: resolvedId,
    name: input.name && input.name.trim() ? input.name : resolvedId,
    providerId,
    kind,
    ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
    ...(typeof input.contextWindow === 'number' && input.contextWindow > 0 ? { contextWindow: input.contextWindow } : {}),
    supportsReasoning: input.supportsReasoning === true,
  }
  const updated = [...filtered, next]
  db.update(schema.providerInstances)
    .set({ modelsJson: updated, updatedAt: new Date() })
    .where(eq(schema.providerInstances.id, providerId))
    .run()
  return updated
}

/** Remove a single model entry from a provider's modelsJson by id. No-op if
 *  not found. Returns the updated list. Used by the per-endpoint delete UI. */
export function removeManualModel(providerId: string, modelId: string): ModelInfo[] {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, providerId)).get()
  if (!row) throw new Error(`Unknown provider instance "${providerId}".`)
  const existing: ModelInfo[] = Array.isArray(row.modelsJson) ? row.modelsJson as ModelInfo[] : []
  const updated = existing.filter(m => m.id !== modelId)
  db.update(schema.providerInstances)
    .set({ modelsJson: updated, updatedAt: new Date() })
    .where(eq(schema.providerInstances.id, providerId))
    .run()
  return updated
}

/** Refresh modelsJson by hitting the upstream's models endpoint.
 *  For `runpod`, re-probes each model's per-model baseUrl in parallel. */
export async function refreshProviderModels(id: string): Promise<ModelInfo[]> {
  const db = getDb()
  const row = db.select().from(schema.providerInstances).where(eq(schema.providerInstances.id, id)).get()
  if (!row) throw new Error(`Unknown provider instance "${id}".`)
  const apiKey = await getDecryptedApiKeyForInstance(id)
  const customHeaders = (row.customHeadersJson && typeof row.customHeadersJson === 'object')
    ? row.customHeadersJson as Record<string, string>
    : undefined

  if (row.kind === 'runpod') {
    const existing: ModelInfo[] = Array.isArray(row.modelsJson) ? row.modelsJson as ModelInfo[] : []
    const refreshed: ModelInfo[] = []
    for (const m of existing) {
      if (!m.baseUrl) { refreshed.push(m); continue }
      try {
        const probe = new OpenAICompatibleProvider({
          providerId: id, baseURL: m.baseUrl, apiStyle: 'chat-completions', customHeaders,
        })
        const fetched = await probe.fetchModels(apiKey)
        const newId = fetched[0]?.id ?? m.id
        refreshed.push({ ...m, id: newId, providerId: id, kind: 'runpod', baseUrl: m.baseUrl })
      } catch {
        // Keep existing model entry if probe fails.
        refreshed.push(m)
      }
    }
    db.update(schema.providerInstances)
      .set({ modelsJson: refreshed, updatedAt: new Date() })
      .where(eq(schema.providerInstances.id, id))
      .run()
    return refreshed
  }

  const adapter = getProviderById(id)
  const models = await adapter.fetchModels(apiKey)
  db.update(schema.providerInstances)
    .set({ modelsJson: models, updatedAt: new Date() })
    .where(eq(schema.providerInstances.id, id))
    .run()
  return models
}

/** Aggregated model list across all enabled provider instances. */
export function listAllModels(): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const inst of listProviderInstances()) {
    if (!inst.enabled) continue
    out.push(...inst.models)
  }
  return out
}

export type { ModelProvider, ModelInfo }
