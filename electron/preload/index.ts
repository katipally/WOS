import { contextBridge, ipcRenderer, webUtils } from 'electron'

const unavailableIpcChannels = new Set<string>()

async function safeInvoke<T>(channel: string, fallback: T, ...args: unknown[]): Promise<T> {
  if (unavailableIpcChannels.has(channel)) return fallback
  try {
    return await ipcRenderer.invoke(channel, ...args) as T
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/No handler registered/i.test(message)) {
      unavailableIpcChannels.add(channel)
      return fallback
    }
    throw err
  }
}

contextBridge.exposeInMainWorld('wos', {
  // Shell
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // Agent
  sendMessage: (params: {
    conversationId: string
    message: string
    attachments?: Array<{ name: string; content: string }>
  }) => ipcRenderer.invoke('agent:send', params),

  cancelAgent: () => ipcRenderer.invoke('agent:cancel'),

  continueConversation: (conversationId: string) =>
    ipcRenderer.invoke('agent:continue', { conversationId }),

  answerQuestion: (questionId: string, answer: string) =>
    ipcRenderer.invoke('agent:answer', { questionId, answer }),

  grantPermission: (toolId: string, decision: 'allow' | 'allow-session' | 'deny') =>
    ipcRenderer.invoke('agent:permission', { toolId, decision }),

  createConversation: (params?: { workspaceId?: string; model?: string; mode?: string }) =>
    ipcRenderer.invoke('agent:create-conversation', params ?? {}),

  updateConversation: (conversationId: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('agent:update-conversation', { conversationId, updates }),

  onAgentEvent: (callback: (event: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: unknown) => callback(event)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },

  // Keyboard shortcuts
  onShortcut: (callback: (name: string) => void) => {
    const newConv = () => callback('new-conversation')
    const openAuto = () => callback('open-automations')
    ipcRenderer.on('shortcut:new-conversation', newConv)
    ipcRenderer.on('shortcut:open-automations', openAuto)
    return () => {
      ipcRenderer.removeListener('shortcut:new-conversation', newConv)
      ipcRenderer.removeListener('shortcut:open-automations', openAuto)
    }
  },

  // Workspace
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  getWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  removeWorkspace: (id: string) => ipcRenderer.invoke('workspace:remove', id),
  saveWorkspaceFile: (params: { workspaceId: string; relPath: string; content: string }):
    Promise<{ ok: boolean; absPath?: string; error?: string }> =>
    safeInvoke('workspace:save-file', { ok: false, error: 'workspace:save-file not ready' }, params),

  readWorkspaceFile: (params: { workspaceId: string; relPath: string }):
    Promise<{ ok: boolean; content?: string; absPath?: string; error?: string }> =>
    safeInvoke('workspace:read-file', { ok: false, error: 'workspace:read-file not ready' }, params),

  globWorkspace: (params: { workspaceId: string; query: string }):
    Promise<{ files: string[]; error?: string }> =>
    safeInvoke('workspace:glob', { files: [] }, params),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', { key, value }),
  getSetting: (key: string) =>
    ipcRenderer.invoke('settings:get').then((s: Record<string, unknown>) => s[key]),
  getAgentSettings: () => ipcRenderer.invoke('settings:agents:get'),
  saveAgentSettings: (input: unknown) => ipcRenderer.invoke('settings:agents:save', input),

  // Provider instances (multi-provider IPC surface)
  providers: {
    list: async () => {
      const r = await ipcRenderer.invoke('providers:list')
      return Array.isArray(r) ? r : (r?.providers ?? [])
    },
    add: (input: unknown) => ipcRenderer.invoke('providers:add', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('providers:update', { id, patch }),
    remove: (id: string) => ipcRenderer.invoke('providers:remove', { id }),
    refreshModels: (id: string) => ipcRenderer.invoke('providers:refresh-models', { id }),
    test: (input: unknown) => ipcRenderer.invoke('providers:test', input),
  },
  models: {
    list: async () => {
      const r = await ipcRenderer.invoke('models:list')
      return Array.isArray(r) ? r : (r?.models ?? [])
    },
  },

  // Database
  getConversations: () => ipcRenderer.invoke('db:conversations:list'),
  getConversation: (id: string) => ipcRenderer.invoke('db:conversations:get', id),
  getMessages: (conversationId: string) => ipcRenderer.invoke('db:messages:list', conversationId),
  editMessage: (messageId: string, newText: string) => ipcRenderer.invoke('db:messages:edit', { messageId, newText }),
  getMessageBranches: (conversationId: string, branchGroupId: string) => ipcRenderer.invoke('db:messages:branches', { conversationId, branchGroupId }),
  deleteConversation: (id: string) => ipcRenderer.invoke('db:conversations:delete', id),
  exportConversation: (conversationId: string) =>
    ipcRenderer.invoke('agent:export-conversation', { conversationId }),

  // App
  getVersion: () => ipcRenderer.invoke('app:version'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  restartAndUpdate: () => ipcRenderer.invoke('app:restart-and-update'),

  // Update events
  onUpdateAvailable: (callback: () => void) => {
    ipcRenderer.on('update:available', callback)
    return () => ipcRenderer.removeListener('update:available', callback)
  },
  onUpdateReady: (callback: () => void) => {
    ipcRenderer.on('update:ready', callback)
    return () => ipcRenderer.removeListener('update:ready', callback)
  },

  // ----- Apps (built-in connectors like Slack) -----
  apps: {
    list: () => ipcRenderer.invoke('apps:list'),
    listAvailable: () => ipcRenderer.invoke('apps:list-available'),
    connect: (appId: string, creds: Record<string, string>) =>
      ipcRenderer.invoke('apps:connect', { appId, creds }),
    disconnect: (appId: string) => ipcRenderer.invoke('apps:disconnect', appId),
    test: (appId: string, creds: Record<string, string>) =>
      ipcRenderer.invoke('apps:test', { appId, creds }),
    setEnabled: (appId: string, enabled: boolean) =>
      ipcRenderer.invoke('apps:set-enabled', { appId, enabled }),
    initiateOAuth: (appId: string, creds: Record<string, string>) =>
      ipcRenderer.invoke('apps:initiate-oauth', { appId, creds }),
  },

  // ----- MCP servers -----
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (input: {
      id?: string
      name: string
      transport: 'stdio' | 'http' | 'sse'
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    }) => ipcRenderer.invoke('mcp:add', input),
    update: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke('mcp:update', { id, updates }),
    remove: (id: string) => ipcRenderer.invoke('mcp:remove', id),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:set-enabled', { id, enabled }),
    testConnection: (id: string) => ipcRenderer.invoke('mcp:test-connection', id),
    listTools: (id: string) => ipcRenderer.invoke('mcp:list-tools', id),
  },

  // ----- Plugins -----
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    reload: () => ipcRenderer.invoke('plugins:reload'),
  },

  // ----- Skills -----
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    reload: () => ipcRenderer.invoke('skills:reload'),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('skills:set-enabled', { id, enabled }),
    read: (id: string) => ipcRenderer.invoke('skills:read', id),
    create: (input: {
      name: string
      description?: string
      body: string
      triggers?: string[]
    }) => ipcRenderer.invoke('skills:create', input),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
  },

  // ----- Rules -----
  rules: {
    list: () => ipcRenderer.invoke('rules:list'),
    reload: () => ipcRenderer.invoke('rules:reload'),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('rules:set-enabled', { id, enabled }),
    read: (id: string) => ipcRenderer.invoke('rules:read', id),
    create: (input: {
      scope: 'user' | 'workspace'
      name: string
      description?: string
      alwaysApply?: boolean
      globs?: string[]
      body: string
    }) => ipcRenderer.invoke('rules:create', input),
    update: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke('rules:update', { id, updates }),
    delete: (id: string) => ipcRenderer.invoke('rules:delete', id),
  },

  // ----- Meetings -----
  meetings: {
    listCalendarEvents: (): Promise<{ events: unknown[]; error: string | null; connected: boolean }> =>
      ipcRenderer.invoke('meetings:calendar:list'),

    getPathForFile: (file: File): string =>
      webUtils.getPathForFile(file),

    openFileDialog: (): Promise<{ file: { name: string; path: string; mimeType: string; size: number } | null; error?: string }> =>
      ipcRenderer.invoke('meetings:dialog:open-file'),

    findDriveFolder: (): Promise<{ folderId: string | null; error: string | null }> =>
      ipcRenderer.invoke('meetings:drive:find-folder'),

    listDriveRecordings: (params: { folderId: string }): Promise<{ recordings: unknown[]; error: string | null }> =>
      ipcRenderer.invoke('meetings:drive:list-recordings', params),

    getDriveTranscript: (params: { fileId: string; fileName: string }): Promise<{ transcript: string | null; error: string | null }> =>
      ipcRenderer.invoke('meetings:drive:get-transcript', params),

    transcribeDriveVideo: (params: { fileId: string; fileName: string }): Promise<{ transcript: string | null; error: string | null }> =>
      ipcRenderer.invoke('meetings:drive:transcribe-video', params),

    processFile: (params: { filePath: string; fileName: string; mimeType: string }): Promise<{ transcript: string | null; error: string | null; format?: string }> =>
      ipcRenderer.invoke('meetings:process-file', params),

    createPending: (params: { title: string; source: 'upload' | 'drive'; sourceUri?: string | null }): Promise<{ id: string | null; error: string | null }> =>
      safeInvoke('meetings:create-pending', { id: null, error: 'Meeting background processing is not ready. Restart WOS and try again.' }, params),

    updateStatus: (params: { id: string; status: string; message?: string | null; progress?: number | null; lastError?: string | null }): Promise<{ ok: boolean; error?: string }> =>
      safeInvoke('meetings:update-status', { ok: false, error: 'Meeting background processing is not ready. Restart WOS and try again.' }, params),

    analyze: (params: { id?: string; transcript: string; title?: string; source?: 'upload' | 'drive' | 'live'; sourceUri?: string | null }): Promise<{ id?: string; result: unknown | null; error: string | null }> =>
      ipcRenderer.invoke('meetings:analyze', params),

    listSaved: (params?: { query?: string }): Promise<{ meetings: unknown[]; error: string | null }> =>
      ipcRenderer.invoke('meetings:list', params ?? {}),

    deleteSaved: (params: { ids: string[] }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('meetings:delete', params),

    renameSaved: (params: { id: string; title: string }): Promise<{ ok: boolean; error?: string }> =>
      safeInvoke('meetings:rename', { ok: false, error: 'Rename is not ready. Restart WOS and try again.' }, params),

    copyMarkdown: (params: { title: string; result: unknown }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('meetings:copy-markdown', params),

    exportMarkdown: (params: { title: string; result: unknown }): Promise<{ ok: boolean; canceled?: boolean; path?: string }> =>
      ipcRenderer.invoke('meetings:export-markdown', params),

    listActivity: (params?: { meetingId?: string | null; limit?: number }): Promise<{ entries: unknown[]; error: string | null }> =>
      safeInvoke('meetings:activity:list', { entries: [], error: null }, params ?? {}),

    addActivity: (params: { meetingId?: string | null; type: string; status: 'success' | 'error' | 'info'; label: string; detail?: unknown }): Promise<{ id: string | null; error: string | null }> =>
      safeInvoke('meetings:activity:add', { id: null, error: null }, params),

    emailNotes: (params: { to: string; cc?: string; subject?: string; body?: string; title?: string; result?: unknown; meetingId?: string | null }): Promise<{ ok: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke('meetings:email-notes', params),

    createGmailDraft: (params: { to: string; subject: string; body: string; meetingId?: string | null }): Promise<{ ok: boolean; draft?: unknown; error?: string }> =>
      safeInvoke('meetings:gmail-draft', { ok: false, error: 'Gmail draft support is not ready. Restart WOS and try again.' }, params),

    listSlackDestinations: (): Promise<{ destinations: unknown[]; error: string | null }> =>
      safeInvoke('meetings:slack:destinations', { destinations: [], error: 'Slack destination picker is not ready. Restart WOS and try again.' }),

    postSlack: (params: { channel: string; text?: string; title?: string; result?: unknown; meetingId?: string | null }): Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }> =>
      ipcRenderer.invoke('meetings:slack-post', params),

    onCaptionUpdate: (callback: (data: { text: string; timestamp: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { text: string; timestamp: number }) => callback(data)
      ipcRenderer.on('meet:caption-update', handler)
      return () => ipcRenderer.removeListener('meet:caption-update', handler)
    },

    onMeetingClosed: (callback: (data?: { id?: string; analyzed?: boolean; captionCount?: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data?: { id?: string; analyzed?: boolean; captionCount?: number }) => callback(data)
      ipcRenderer.on('meet:window-closed', handler)
      return () => ipcRenderer.removeListener('meet:window-closed', handler)
    },

    onAnalysisError: (callback: (data: { error: string | null }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { error: string | null }) => callback(data)
      ipcRenderer.on('meet:analysis-error', handler)
      return () => ipcRenderer.removeListener('meet:analysis-error', handler)
    },
  },

  // ----- Automations -----
  automations: {
    list: (filter?: { kind?: string; enabled?: boolean }) =>
      safeInvoke('automations:list', [] as unknown[], filter),
    get: (id: string) => safeInvoke('automations:get', null as unknown, { id }),
    upsert: (input: unknown) => ipcRenderer.invoke('automations:upsert', input),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('automations:toggle', { id, enabled }),
    delete: (id: string) => ipcRenderer.invoke('automations:delete', { id }),
    runNow: (id: string, dryRun?: boolean) =>
      ipcRenderer.invoke('automations:runNow', { id, dryRun }),
    runs: (id?: string, limit?: number) =>
      safeInvoke('automations:runs', [] as unknown[], { id, limit }),
    webhookInfo: (id: string) => safeInvoke('automations:webhookInfo', null as unknown, { id }),
    reloadAll: () => ipcRenderer.invoke('automations:reloadAll'),
    parseDescription: (description: string) =>
      ipcRenderer.invoke('automations:parseDescription', { description }),
    onError: (callback: (e: { id: string; runId: string; error: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { id: string; runId: string; error: string }) => callback(data)
      ipcRenderer.on('automation:error', handler)
      return () => ipcRenderer.removeListener('automation:error', handler)
    },
    onResult: (callback: (e: { id: string; runId: string | null; name: string; output: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { id: string; runId: string | null; name: string; output: string }) => callback(data)
      ipcRenderer.on('automation:result', handler)
      return () => ipcRenderer.removeListener('automation:result', handler)
    },
    onOpen: (callback: (e: { automationId: string; runId?: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { automationId: string; runId?: string }) => callback(data)
      ipcRenderer.on('shortcut:open-automations', handler)
      return () => ipcRenderer.removeListener('shortcut:open-automations', handler)
    },
  },

  // ----- Projects -----
  projects: {
    catalogue: (onlyConnected = true) =>
      safeInvoke('projects:catalogue', [] as unknown[], { onlyConnected }),
    list: (includeArchived = false) =>
      safeInvoke('projects:list', [] as unknown[], { includeArchived }),
    get: (id: string) => safeInvoke('projects:get', null as unknown, { id }),
    getBySlug: (slug: string) => safeInvoke('projects:getBySlug', null as unknown, { slug }),
    find: (q: string) => safeInvoke('projects:find', [] as unknown[], { q }),
    create: (input: unknown) => ipcRenderer.invoke('projects:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('projects:update', { id, patch }),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', { id }),
    setStatus: (id: string, status: string) => ipcRenderer.invoke('projects:setStatus', { id, status }),
    setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('projects:setPinned', { id, pinned }),

    listResources: (projectId: string) =>
      safeInvoke('projects:listResources', [] as unknown[], { projectId }),
    addResource: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('projects:addResource', { projectId, input }),
    removeResource: (resourceId: string) =>
      ipcRenderer.invoke('projects:removeResource', { resourceId }),
    refreshResource: (resourceId: string) =>
      ipcRenderer.invoke('projects:refreshResource', { resourceId }),

    appSnapshot: (appId: string, scope: string) =>
      safeInvoke('projects:appSnapshot', null as unknown, { appId, scope }),
    appSnapshotRefresh: (appId: string, scope?: string) =>
      ipcRenderer.invoke('projects:appSnapshotRefresh', { appId, scope }),
    searchGmailContacts: (query: string) =>
      ipcRenderer.invoke('projects:searchGmailContacts', { query }),
    nativeSnapshot: (scope: string) =>
      safeInvoke('projects:nativeSnapshot', { items: [], truncated: false }, { scope }),
    openLinks: (resourceId: string) =>
      safeInvoke('projects:openLinks', [] as unknown[], { resourceId }),

    activity: (projectId: string, opts?: { since?: number; limit?: number }) =>
      safeInvoke('projects:activity', [] as unknown[], { projectId, ...(opts ?? {}) }),
    recordActivity: (input: unknown) => ipcRenderer.invoke('projects:recordActivity', input),

    listWidgets: (projectId: string) =>
      safeInvoke('projects:listWidgets', [] as unknown[], { projectId }),
    addWidget: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('projects:addWidget', { projectId, input }),
    updateWidget: (widgetId: string, patch: unknown) =>
      ipcRenderer.invoke('projects:updateWidget', { widgetId, patch }),
    removeWidget: (widgetId: string) =>
      ipcRenderer.invoke('projects:removeWidget', { widgetId }),

    getSummary: (projectId: string, kind: string) =>
      safeInvoke('projects:getSummary', null as unknown, { projectId, kind }),
    generateSummary: (projectId: string, kind: string) =>
      ipcRenderer.invoke('projects:generateSummary', { projectId, kind }),

    listAlerts: (projectId: string) =>
      safeInvoke('projects:listAlerts', [] as unknown[], { projectId }),
    addAlert: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('projects:addAlert', { projectId, input }),
    removeAlert: (alertId: string) => ipcRenderer.invoke('projects:removeAlert', { alertId }),
    setAlertEnabled: (alertId: string, enabled: boolean) =>
      ipcRenderer.invoke('projects:setAlertEnabled', { alertId, enabled }),
    evaluateAlerts: (projectId: string) =>
      safeInvoke('projects:evaluateAlerts', { fired: [] }, { projectId }),

    listRisks: (projectId: string) =>
      safeInvoke('projects:listRisks', [] as unknown[], { projectId }),
    addRisk: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('projects:addRisk', { projectId, input }),
    removeRisk: (riskId: string) => ipcRenderer.invoke('projects:removeRisk', { riskId }),
    listDecisions: (projectId: string) =>
      safeInvoke('projects:listDecisions', [] as unknown[], { projectId }),
    addDecision: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('projects:addDecision', { projectId, input }),
    removeDecision: (decisionId: string) =>
      ipcRenderer.invoke('projects:removeDecision', { decisionId }),

    listMetric: (projectId: string, metricKey: string, opts?: { since?: number; limit?: number }) =>
      safeInvoke('projects:listMetric', [] as unknown[], { projectId, metricKey, ...(opts ?? {}) }),
    computeHealth: (projectId: string) =>
      safeInvoke('projects:computeHealth', { healthScore: 0, riskLevel: 'medium', signals: [] }, { projectId }),

    exportJson: (projectId: string): Promise<string> =>
      ipcRenderer.invoke('projects:exportJson', { projectId }),
    exportMarkdown: (projectId: string): Promise<string> =>
      ipcRenderer.invoke('projects:exportMarkdown', { projectId }),
    exportHtml: (projectId: string): Promise<string> =>
      ipcRenderer.invoke('projects:exportHtml', { projectId }),

    listPeople: (projectId: string) =>
      safeInvoke('projects:listPeople', [] as unknown[], { projectId }),
    addPerson: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('projects:addPerson', { projectId, input }),
    updatePerson: (personId: string, patch: unknown) =>
      ipcRenderer.invoke('projects:updatePerson', { personId, patch }),
    removePerson: (personId: string) =>
      ipcRenderer.invoke('projects:removePerson', { personId }),
  },

  // ----- Dictation (Apple Speech) -----
  dictation: {
    start: (sessionId: string): Promise<{ ok: boolean; error?: string; unavailable?: boolean }> =>
      safeInvoke('dictation:start', { ok: false, error: 'Dictation IPC not registered' }, { sessionId }),
    write: (sessionId: string, chunk: ArrayBuffer | Uint8Array): Promise<{ ok: boolean; error?: string }> =>
      safeInvoke('dictation:write', { ok: false, error: 'Dictation IPC not registered' }, { sessionId, chunk }),
    stop: (sessionId: string): Promise<{ ok: boolean; text?: string; error?: string }> =>
      safeInvoke('dictation:stop', { ok: false, error: 'Dictation IPC not registered' }, { sessionId }),
    cancel: (sessionId: string): Promise<{ ok: boolean }> =>
      safeInvoke('dictation:cancel', { ok: false }, { sessionId }),
    onEvent: (callback: (event: { sessionId: string; type: 'partial' | 'segment' | 'error'; text?: string; error?: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { sessionId: string; type: 'partial' | 'segment' | 'error'; text?: string; error?: string }) => callback(payload)
      ipcRenderer.on('dictation:event', handler)
      return () => ipcRenderer.removeListener('dictation:event', handler)
    },
  },
})
