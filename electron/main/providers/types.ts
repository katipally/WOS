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

export type ModelProviderId = 'openai' | 'anthropic' | 'huggingface-space'

export interface ModelInfo {
  id: string
  name: string
  provider: ModelProviderId
  contextWindow?: number
  supportsReasoning?: boolean
  supportsVision?: boolean
  description?: string
}

export interface ModelProvider {
  stream(request: ModelRequest): AsyncGenerator<StreamEvent>
  fetchModels(apiKey: string): Promise<ModelInfo[]>
}
