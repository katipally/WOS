interface WosAPI {
  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean }>
  }
  sendMessage: (params: { conversationId: string; message: string; attachments?: Array<{ name: string; content: string }> }) => Promise<{ success: boolean; error?: string }>
  continueConversation: (conversationId: string) => Promise<{ success: boolean; error?: string }>
  cancelAgent: () => Promise<void>
  answerQuestion: (questionId: string, answer: string) => Promise<void>
  grantPermission: (toolId: string, decision: 'allow' | 'allow-session' | 'deny') => Promise<void>
  createConversation: (params?: { workspaceId?: string; model?: string; mode?: string }) => Promise<import('./index').Conversation>
  updateConversation: (conversationId: string, updates: Record<string, unknown>) => Promise<void>
  onAgentEvent: (callback: (event: unknown) => void) => () => void

  onShortcut: (callback: (name: string) => void) => () => void

  openWorkspace: () => Promise<import('./index').Workspace | null>
  getWorkspaces: () => Promise<import('./index').Workspace[]>
  removeWorkspace: (id: string) => Promise<void>
  globWorkspace: (params: { workspaceId: string; query: string }) => Promise<{ files: string[] }>
  saveWorkspaceFile: (params: { workspaceId: string; relPath: string; content: string }) =>
    Promise<{ ok: boolean; absPath?: string; error?: string }>
  readWorkspaceFile: (params: { workspaceId: string; relPath: string }) =>
    Promise<{ ok: boolean; content?: string; absPath?: string; error?: string }>

  dictation: {
    start: (sessionId: string) => Promise<{ ok: boolean; error?: string; unavailable?: boolean }>
    write: (sessionId: string, chunk: ArrayBuffer | Uint8Array) => Promise<{ ok: boolean; error?: string }>
    stop: (sessionId: string) => Promise<{ ok: boolean; text?: string; error?: string }>
    cancel: (sessionId: string) => Promise<{ ok: boolean }>
    onEvent: (
      callback: (event: { sessionId: string; type: 'partial' | 'segment' | 'error'; text?: string; error?: string }) => void
    ) => () => void
  }

  getSettings: () => Promise<Record<string, unknown>>
  setSetting: (key: string, value: unknown) => Promise<void>
  getSetting: (key: string) => Promise<unknown>
  getAgentSettings: () => Promise<{ success: boolean; agents: AgentSettingsRecord[]; resolved: AgentSettingsRecord[] }>
  saveAgentSettings: (input: AgentSettingsSaveInput) => Promise<{ success: boolean; config?: Record<string, unknown> }>

  saveApiKey: (provider: 'openai' | 'anthropic' | 'huggingface-space', key: string) => Promise<{ success: boolean }>
  getApiKeysPresence: () => Promise<Record<string, boolean>>
  testApiKey: (provider: 'openai' | 'anthropic' | 'huggingface-space', key: string) => Promise<{ ok: boolean; modelCount?: number; error?: string }>

  fetchModels: (provider: 'openai' | 'anthropic', apiKey: string) => Promise<{ success: boolean; models: import('./index').ModelInfo[]; error?: string }>
  fetchSavedModels: () => Promise<{ success: boolean; models: import('./index').ModelInfo[]; errors?: Array<{ provider: string; error?: string }> }>
  getFallbackModels: () => Promise<import('./index').ModelInfo[]>
  listHuggingFaceSpaces: () => Promise<{ success: boolean; spaces: HuggingFaceSpaceInfo[] }>
  inspectHuggingFaceSpace: (params: { source: string; baseUrlOverride?: string | null }) => Promise<{ success: boolean; space?: HuggingFaceSpaceInfo; models: import('./index').ModelInfo[]; error?: string }>
  removeHuggingFaceSpace: (spaceId: string) => Promise<{ success: boolean }>

  getConversations: () => Promise<import('./index').Conversation[]>
  getConversation: (id: string) => Promise<import('./index').Conversation | null>
  getMessages: (conversationId: string) => Promise<Array<{ id: string; role: string; blocks: unknown; createdAt: string; branchGroupId?: string | null; branchIndex?: number | null }>>
  editMessage: (messageId: string, newText: string) => Promise<{ success: boolean; error?: string; newMessageId?: string; branchGroupId?: string; branchIndex?: number }>
  getMessageBranches: (conversationId: string, branchGroupId: string) => Promise<Record<number, Array<{ id: string; role: string; blocks: unknown }>>>
  deleteConversation: (id: string) => Promise<void>

  getVersion: () => Promise<string>
  openLogs: () => Promise<void>
  restartAndUpdate: () => Promise<void>

  onUpdateAvailable: (callback: () => void) => () => void
  onUpdateReady: (callback: () => void) => () => void

  apps: {
    list: () => Promise<AppConnection[]>
    listAvailable: () => Promise<AppManifest[]>
    connect: (appId: string, creds: Record<string, string>) => Promise<{ success: boolean; error?: string }>
    disconnect: (appId: string) => Promise<{ success: boolean }>
    test: (appId: string, creds: Record<string, string>) => Promise<{ success: boolean; error?: string; identity?: Record<string, unknown> }>
    setEnabled: (appId: string, enabled: boolean) => Promise<{ success: boolean }>
    initiateOAuth: (appId: string, creds: Record<string, string>) => Promise<{ success: boolean; error?: string; metadata?: Record<string, unknown> }>
  }

  mcp: {
    list: () => Promise<McpServerInfo[]>
    add: (input: { id?: string; name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; enabled?: boolean }) => Promise<{ success: boolean; id?: string; error?: string }>
    update: (id: string, updates: Record<string, unknown>) => Promise<{ success: boolean }>
    remove: (id: string) => Promise<{ success: boolean }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean }>
    testConnection: (id: string) => Promise<{ success: boolean; error?: string; toolCount?: number }>
    listTools: (id: string) => Promise<{ success: boolean; tools: Array<{ name: string; description: string }>; error?: string }>
  }

  skills: {
    list: () => Promise<SkillInfo[]>
    reload: () => Promise<{ success: boolean; count: number }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean }>
    read: (id: string) => Promise<{ success: boolean; body?: string; meta?: Record<string, unknown>; error?: string }>
    create: (input: { name: string; description?: string; body: string; triggers?: string[] }) => Promise<{ success: boolean; id?: string; error?: string }>
    delete: (id: string) => Promise<{ success: boolean }>
  }

  rules: {
    list: () => Promise<RuleInfo[]>
    reload: () => Promise<{ success: boolean; count: number }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean }>
    read: (id: string) => Promise<{ success: boolean; body?: string; meta?: Record<string, unknown>; error?: string }>
    create: (input: { scope: 'user' | 'workspace'; name: string; description?: string; alwaysApply?: boolean; globs?: string[]; body: string }) => Promise<{ success: boolean; id?: string; error?: string }>
    update: (id: string, updates: Record<string, unknown>) => Promise<{ success: boolean }>
    delete: (id: string) => Promise<{ success: boolean }>
  }

  meetings: {
    listCalendarEvents: () => Promise<{ events: unknown[]; error: string | null; connected: boolean }>
    getPathForFile: (file: File) => string
    openFileDialog: () => Promise<{ file: { name: string; path: string; mimeType: string; size: number } | null; error?: string }>
    findDriveFolder: () => Promise<{ folderId: string | null; error: string | null }>
    listDriveRecordings: (params: { folderId: string }) => Promise<{ recordings: unknown[]; error: string | null }>
    getDriveTranscript: (params: { fileId: string; fileName: string }) => Promise<{ transcript: string | null; error: string | null }>
    transcribeDriveVideo: (params: { fileId: string; fileName: string }) => Promise<{ transcript: string | null; error: string | null }>
    processFile: (params: { filePath: string; fileName: string; mimeType: string }) => Promise<{ transcript: string | null; error: string | null; format?: string }>
    createPending: (params: { title: string; source: 'upload' | 'drive'; sourceUri?: string | null }) => Promise<{ id: string | null; error: string | null }>
    updateStatus: (params: { id: string; status: string; message?: string | null; progress?: number | null; lastError?: string | null }) => Promise<{ ok: boolean; error?: string }>
    analyze: (params: { id?: string; transcript: string; title?: string; source?: 'upload' | 'drive'; sourceUri?: string | null }) => Promise<{ id?: string; result: unknown | null; error: string | null }>
    listSaved: (params?: { query?: string }) => Promise<{ meetings: unknown[]; error: string | null }>
    deleteSaved: (params: { ids: string[] }) => Promise<{ ok: boolean; error?: string }>
    renameSaved: (params: { id: string; title: string }) => Promise<{ ok: boolean; error?: string }>
    copyMarkdown: (params: { title: string; result: unknown }) => Promise<{ ok: boolean }>
    exportMarkdown: (params: { title: string; result: unknown }) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
    listActivity: (params?: { meetingId?: string | null; limit?: number }) => Promise<{ entries: unknown[]; error: string | null }>
    addActivity: (params: { meetingId?: string | null; type: string; status: 'success' | 'error' | 'info'; label: string; detail?: unknown }) => Promise<{ id: string | null; error: string | null }>
    emailNotes: (params: { to: string; cc?: string; subject?: string; body?: string; title?: string; result?: unknown; meetingId?: string | null }) => Promise<{ ok: boolean; id?: string; error?: string }>
    createGmailDraft: (params: { to: string; subject: string; body: string; meetingId?: string | null }) => Promise<{ ok: boolean; draft?: unknown; error?: string }>
    listSlackDestinations: () => Promise<{ destinations: unknown[]; error: string | null }>
    postSlack: (params: { channel: string; text?: string; title?: string; result?: unknown; meetingId?: string | null }) => Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }>
    onCaptionUpdate: (callback: (data: { text: string; timestamp: number }) => void) => () => void
    onMeetingClosed: (callback: (data?: { id?: string; analyzed?: boolean; captionCount?: number }) => void) => () => void
    onAnalysisError: (callback: (data: { error: string | null }) => void) => () => void
  }

  projects: {
    catalogue: (onlyConnected?: boolean) => Promise<unknown[]>
    list: (includeArchived?: boolean) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    getBySlug: (slug: string) => Promise<unknown>
    find: (q: string) => Promise<unknown[]>
    create: (input: unknown) => Promise<unknown>
    update: (id: string, patch: unknown) => Promise<unknown>
    delete: (id: string) => Promise<{ ok: boolean }>
    setStatus: (id: string, status: string) => Promise<unknown>
    setPinned: (id: string, pinned: boolean) => Promise<unknown>
    listResources: (projectId: string) => Promise<unknown[]>
    addResource: (projectId: string, input: unknown) => Promise<unknown>
    removeResource: (resourceId: string) => Promise<{ ok: boolean }>
    refreshResource: (resourceId: string) => Promise<{ ok: boolean }>
    appSnapshot: (appId: string, scope: string) => Promise<{ appId: string; scope: string; data: unknown[]; fetchedAt: number; stale: boolean } | null>
    appSnapshotRefresh: (appId: string, scope?: string) => Promise<unknown>
    searchGmailContacts: (query: string) => Promise<Array<{ name: string; email: string; photoUrl: string | null }>>
    nativeSnapshot: (scope: string) => Promise<{ items: Array<Record<string, unknown>>; truncated: boolean }>
    openLinks: (resourceId: string) => Promise<Array<{ label: string; url: string; icon?: string }>>
    activity: (projectId: string, opts?: { since?: number; limit?: number }) => Promise<unknown[]>
    recordActivity: (input: unknown) => Promise<unknown>
    listWidgets: (projectId: string) => Promise<unknown[]>
    addWidget: (projectId: string, input: unknown) => Promise<unknown>
    updateWidget: (widgetId: string, patch: unknown) => Promise<{ ok: boolean }>
    removeWidget: (widgetId: string) => Promise<{ ok: boolean }>
    getSummary: (projectId: string, kind: string) => Promise<unknown>
    generateSummary: (projectId: string, kind: string) => Promise<{ ok: boolean; summary?: string; error?: string }>
    listAlerts: (projectId: string) => Promise<unknown[]>
    addAlert: (projectId: string, input: unknown) => Promise<unknown>
    removeAlert: (alertId: string) => Promise<{ ok: boolean }>
    setAlertEnabled: (alertId: string, enabled: boolean) => Promise<{ ok: boolean }>
    evaluateAlerts: (projectId: string) => Promise<{ fired: Array<{ alert: unknown; reason: string }> }>
    listRisks: (projectId: string) => Promise<unknown[]>
    addRisk: (projectId: string, input: unknown) => Promise<unknown>
    removeRisk: (riskId: string) => Promise<{ ok: boolean }>
    updateRisk: (riskId: string, patch: unknown) => Promise<unknown>
    listDecisions: (projectId: string) => Promise<unknown[]>
    addDecision: (projectId: string, input: unknown) => Promise<unknown>
    removeDecision: (decisionId: string) => Promise<{ ok: boolean }>
    updateDecision: (decisionId: string, patch: unknown) => Promise<unknown>
    listMetric: (projectId: string, metricKey: string, opts?: { since?: number; limit?: number }) => Promise<unknown[]>
    computeHealth: (projectId: string) => Promise<{ healthScore: number; riskLevel: string; signals: Array<{ label: string; weight: number; positive: boolean; detail?: string }> }>
    exportJson: (projectId: string) => Promise<string>
    exportMarkdown: (projectId: string) => Promise<string>
    exportHtml: (projectId: string) => Promise<string>
    listPeople: (projectId: string) => Promise<unknown[]>
    addPerson: (projectId: string, input: unknown) => Promise<unknown>
    updatePerson: (personId: string, patch: unknown) => Promise<unknown>
    removePerson: (personId: string) => Promise<{ ok: boolean }>
  }
}

interface AgentSettingsRecord {
  agentKey: string
  inheritFrom: string | null
  model: string | null
  mode: string | null
  systemPrompt: string | null
  config: Record<string, unknown>
}

interface AgentSettingsSaveInput {
  agentKey: string
  inheritFrom?: string | null
  model?: string | null
  mode?: string | null
  systemPrompt?: string | null
  config?: Record<string, unknown>
  apiKeys?: Partial<Record<'openai' | 'anthropic' | 'huggingface-space', string>>
}

interface HuggingFaceSpaceInfo {
  spaceId: string
  source: string
  baseUrl: string
  baseUrlOverride?: string | null
  title?: string | null
  author?: string | null
  sdk?: string | null
  updatedAt?: string | null
  runtimeStage?: string | null
  likes?: number | null
  private?: boolean
  modelIds?: string[]
  lastSyncedAt?: string | null
}

interface AppManifest {
  id: string
  name: string
  description: string
  icon?: string
  scopes?: string[]
  docsUrl?: string
  authFields: Array<{ key: string; label: string; placeholder?: string; required: boolean; secret?: boolean; helper?: string }>
  authType?: 'token' | 'oauth'
  tools: Array<{ name: string; description: string }>
}

interface AppConnection {
  appId: string
  name: string
  description: string
  enabled: boolean
  connected: boolean
  metadata?: Record<string, unknown>
  tools: Array<{ name: string; description: string }>
  skills?: Array<{ id: string; description: string }>
  hooks?: string[]
}

interface McpServerInfo {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  toolPrefix?: string
  tools?: Array<{ name: string; description: string }>
  status: 'idle' | 'connecting' | 'connected' | 'error'
  lastError?: string
}

interface SkillInfo {
  id: string
  source: 'user' | 'workspace'
  name: string
  description: string
  path: string
  enabled: boolean
  triggers: string[]
}

interface RuleInfo {
  id: string
  scope: 'user' | 'workspace'
  name: string
  description: string
  path: string
  alwaysApply: boolean
  globs: string[]
  enabled: boolean
}

interface Window {
  wos: WosAPI
}
