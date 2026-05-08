export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  id?: string
  name?: string
  input?: unknown
  content?: unknown
  thinking?: string
  tool_use_id?: string
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: object
}

export interface ModelRequest {
  model: string
  messages: ConversationMessage[]
  tools: ToolDefinition[]
  systemPrompt: string
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  maxTokens?: number
  apiKeyOverride?: string
  signal?: AbortSignal
  /** Provider instance id (provider_instances.id). If provided, the runner
   * dispatches to that exact instance. If absent, the runner picks the first
   * enabled instance whose modelsJson includes the requested model id. */
  providerId?: string
}

export type StreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'tool_preparing'; id: string; name: string }
  | { type: 'tool_arg_delta'; id: string; delta: string }
  | { type: 'tool_use_start'; id: string; name: string; input: unknown }
  | { type: 'message_stop'; stopReason: string; usage: TokenUsage }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible'
export type ApiStyle = 'responses' | 'chat-completions'

export interface ModelInfo {
  id: string
  name: string
  /** UUID of the provider_instances row that serves this model. */
  providerId: string
  /** What kind of upstream the providerId corresponds to. */
  kind: ProviderKind
  contextWindow?: number
  supportsReasoning?: boolean
  supportsVision?: boolean
  description?: string
}

export interface ModelProvider {
  stream(request: ModelRequest): AsyncGenerator<StreamEvent>
  fetchModels(apiKey: string): Promise<ModelInfo[]>
}
