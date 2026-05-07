import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { HuggingFaceSpaceProvider } from './huggingfaceSpaceProvider'
import { isHuggingFaceSpaceModelId } from './huggingfaceSpaces'
import type { ModelProvider, ModelInfo, ModelProviderId } from './types'
import { enrichModel } from './capabilities'

const providers: Record<ModelProviderId, ModelProvider> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  'huggingface-space': new HuggingFaceSpaceProvider(),
}

export function getProvider(model: string): ModelProvider {
  return providers[getProviderNameForModel(model)]
}

export function getProviderNameForModel(model: string): ModelProviderId {
  if (isHuggingFaceSpaceModelId(model)) return 'huggingface-space'
  if (model.startsWith('claude')) return 'anthropic'
  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o2') ||
    model.startsWith('o3') ||
    model.startsWith('o4') ||
    model.startsWith('chatgpt')
  ) return 'openai'
  // Default to OpenAI for unknown
  return 'openai'
}

export function getProviderByName(name: ModelProviderId): ModelProvider {
  return providers[name]
}

export const FALLBACK_MODELS: ModelInfo[] = ([
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'openai' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
  { id: 'o3', name: 'o3', provider: 'openai' },
  { id: 'o4-mini', name: 'o4-mini', provider: 'openai' },
] as ModelInfo[]).map(enrichModel)

export { providers }
export type { ModelProvider, ModelInfo }
