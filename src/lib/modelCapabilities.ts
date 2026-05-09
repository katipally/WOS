// Model capability inference. Provider /models endpoints do not expose all
// structured capability metadata, so these rules stay conservative.

export type ModelProviderId = 'openai' | 'anthropic'

export function modelSupportsReasoning(id: string): boolean {
  const s = id.toLowerCase()
  // OpenAI o-series reasoning models (o1, o3, o4, o5-mini, o10, ...)
  if (/^o\d+(-|\.|$)/.test(s)) return true
  // GPT-5 family (5, 5.x) reasoning via Responses API.
  if (/^gpt-5(\.|-|$)/.test(s)) return true
  // Explicit reasoning / thinking variants.
  if (/reasoning|thinking/.test(s)) return true
  // DeepSeek R-series reasoning models.
  if (/^deepseek-r/.test(s)) return true
  // Qwen3 family — Qwen3, Qwen-3, Qwen3.5, Qwen35, including HF-style
  // org/name slugs like "thejesraj/wos-main-qwen35". All Qwen3 variants
  // support thinking via vLLM `enable_thinking` / `reasoning_effort`.
  if (/qwen-?3/.test(s)) return true
  // gpt-oss reasoning family (OpenAI open-weights, served via vLLM/runpod).
  if (/gpt-oss/.test(s)) return true
  // Anthropic extended-thinking capable families (Claude 4+ Opus/Sonnet/Haiku).
  if (/^claude-(opus|sonnet|haiku)-[4-9]/.test(s)) return true
  if (/^claude-[4-9]/.test(s)) return true
  // Allow env override for tests / early rollouts in the main process.
  if (typeof process !== 'undefined' && process.env?.WOS_FORCE_REASONING === '1') return true
  return false
}

export function modelSupportsVision(id: string): boolean {
  const s = id.toLowerCase()
  if (/^gpt-4o/.test(s)) return true
  if (/^gpt-4\.1/.test(s)) return true
  if (/^gpt-5/.test(s)) return true
  if (/^o[34]/.test(s)) return true
  if (/^claude-3\.[5-9]/.test(s)) return true
  if (/^claude-(opus|sonnet|haiku)-4/.test(s)) return true
  return false
}

export function getContextWindow(id: string): number | undefined {
  const s = id.toLowerCase()
  if (/^gpt-4\.1/.test(s)) return 1_000_000
  if (/^gpt-4o/.test(s)) return 128_000
  if (/^gpt-5/.test(s)) return 400_000
  if (/^o1/.test(s)) return 128_000
  if (/^o[34]/.test(s)) return 200_000
  if (/^claude/.test(s)) return 200_000
  return undefined
}

export function getModelDescription(id: string): string | undefined {
  const s = id.toLowerCase()
  if (/^gpt-5\.4/.test(s)) return 'GPT-5.4 flagship'
  if (/^gpt-5/.test(s)) return 'GPT-5 family'
  if (/^gpt-4\.1/.test(s)) return 'GPT-4.1 · 1M ctx'
  if (/^gpt-4o/.test(s)) return 'GPT-4o omni'
  if (/^o1/.test(s)) return 'o1 reasoning'
  if (/^o3/.test(s)) return 'o3 reasoning'
  if (/^o4/.test(s)) return 'o4 reasoning'
  if (/^claude-opus-4/.test(s)) return 'Claude Opus 4'
  if (/^claude-sonnet-4/.test(s)) return 'Claude Sonnet 4'
  if (/^claude-haiku-4/.test(s)) return 'Claude Haiku 4'
  if (/^claude-3\.5/.test(s)) return 'Claude 3.5'
  return undefined
}

export function enrichModel<T extends { id: string; name: string }>(m: T) {
  return {
    ...m,
    contextWindow: getContextWindow(m.id),
    supportsReasoning: modelSupportsReasoning(m.id),
    supportsVision: modelSupportsVision(m.id),
    description: getModelDescription(m.id),
  }
}
