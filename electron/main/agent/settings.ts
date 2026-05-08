import { eq } from 'drizzle-orm'
import { decryptApiKey } from '../crypto'
import { getDb, schema } from '../db'
import { getDecryptedApiKeyForInstanceOrNull } from '../providers/keystore'
import { listProviderInstances } from '../providers'
import { getAgentDef } from './agentDefs'
import { DEFAULT_MEETING_SYSTEM_PROMPT } from './agentDefs/meeting'

export { DEFAULT_MEETING_SYSTEM_PROMPT }

export type AgentKey = 'wos' | 'meeting' | string

export interface AgentRuntimeSettings {
  agentKey: string
  /** Resolved model id. Empty string means "no model selected; UI should
   * force the user to pick one before any stream call." */
  model: string
  mode: 'default' | 'plan' | 'yolo'
  systemPrompt: string
  config: AgentConfig
  apiKeyOverride?: string
}

export interface AgentConfig {
  liveSource?: 'captions'
  autoSummarize?: boolean
  // Free-form per-agent settings keyed by agentDef.settingsSchema. The
  // *EncryptedKeystore-style fields below are kept only to decrypt legacy
  // installs (pre-multi-instance); new code should never write them.
  openaiApiKeyEncrypted?: string
  openaiApiKeyIv?: string
  anthropicApiKeyEncrypted?: string
  anthropicApiKeyIv?: string
  [key: string]: unknown
}

function parseConfig(value: unknown): AgentConfig {
  if (!value) return {}
  if (typeof value === 'object') return value as AgentConfig
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as AgentConfig : {}
  } catch {
    return {}
  }
}

/** Decrypt a legacy in-config key, if any. New installs won't hit this. */
function decryptLegacyAgentKey(config: AgentConfig, kind: 'openai' | 'anthropic'): string | undefined {
  const encrypted = kind === 'openai' ? config.openaiApiKeyEncrypted : config.anthropicApiKeyEncrypted
  const iv = kind === 'openai' ? config.openaiApiKeyIv : config.anthropicApiKeyIv
  if (!encrypted || !iv) return undefined
  try { return decryptApiKey(String(encrypted), String(iv)) } catch { return undefined }
}

/** Find the provider instance that lists `model` and return its decrypted
 * API key, if any. Used so sub-agents/intent calls inherit the right key. */
async function resolveApiKeyForModel(model: string): Promise<string | undefined> {
  if (!model) return undefined
  for (const inst of listProviderInstances()) {
    if (!inst.enabled) continue
    if (inst.models.some(m => m.id === model)) {
      const key = await getDecryptedApiKeyForInstanceOrNull(inst.id)
      if (key) return key
    }
  }
  // Fallback: try built-in instance ids by prefix.
  if (model.startsWith('claude')) {
    const key = await getDecryptedApiKeyForInstanceOrNull('anthropic')
    if (key) return key
  }
  if (model.startsWith('gpt-') || /^o\d/.test(model) || model.startsWith('chatgpt')) {
    const key = await getDecryptedApiKeyForInstanceOrNull('openai')
    if (key) return key
  }
  return undefined
}

/**
 * Resolve runtime settings for an agent by merging (in order):
 *   1. agentDef.defaults  — declared by the registered AgentDef
 *   2. row.configJson      — what the user saved in Settings → Agents
 *   3. row.systemPrompt    — only used if the user explicitly overrode it
 *
 * No inheritance walking. agentDef.acceptedTags decides tool exposure later.
 */
export async function resolveAgent(agentKey: AgentKey): Promise<AgentRuntimeSettings> {
  const db = getDb()
  const def = getAgentDef(agentKey)
  const row = db.select().from(schema.agentSettings).where(eq(schema.agentSettings.agentKey, agentKey)).get()

  const defaults: AgentConfig = (def?.defaults as AgentConfig | undefined) ?? {}
  const stored = parseConfig(row?.configJson)
  const config: AgentConfig = { ...defaults, ...stored }

  const model = (typeof config.model === 'string' && config.model) || row?.model || ''
  const modeRaw = (typeof config.mode === 'string' && config.mode) || row?.mode || 'default'
  const mode = (modeRaw === 'plan' || modeRaw === 'yolo' ? modeRaw : 'default') as 'default' | 'plan' | 'yolo'
  const systemPrompt = (typeof config.systemPrompt === 'string' && config.systemPrompt)
    || row?.systemPrompt
    || def?.systemPrompt
    || ''

  // Prefer a key resolved against the chosen model's provider instance; fall
  // back to legacy in-config keys for upgrade scenarios.
  const apiKeyOverride =
    (await resolveApiKeyForModel(model))
    ?? decryptLegacyAgentKey(config, model.startsWith('claude') ? 'anthropic' : 'openai')

  return { agentKey, model, mode, systemPrompt, config, apiKeyOverride }
}

export function redactAgentConfig(config: AgentConfig): AgentConfig & { openaiApiKeySet?: boolean; anthropicApiKeySet?: boolean } {
  const { openaiApiKeyEncrypted, openaiApiKeyIv, anthropicApiKeyEncrypted, anthropicApiKeyIv, ...rest } = config
  return {
    ...rest,
    openaiApiKeySet: Boolean(openaiApiKeyEncrypted && openaiApiKeyIv),
    anthropicApiKeySet: Boolean(anthropicApiKeyEncrypted && anthropicApiKeyIv),
  }
}
