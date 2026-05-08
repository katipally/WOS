import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Settings } from '../types'
import { useAgentStore } from './agentStore'

interface SettingsStore extends Settings {
  loaded: boolean
  loadSettings: () => Promise<void>
  saveSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      loaded: false,
      defaultModel: '',
      reasoningEffort: 'medium',
      defaultMode: 'default',
      theme: 'dark',
      activeWorkspaceId: null,
      intentEnabled: true,
      maxSubagentDepth: 3,
      maxSubagentBreadth: 5,
      memoryEnabled: true,

      loadSettings: async () => {
        try {
          const settings = (await window.wos.getSettings()) as Partial<Settings>
          const defaultModel = (settings.defaultModel as string) ?? ''
          const defaultMode = (settings.defaultMode as Settings['defaultMode']) ?? 'default'
          set({
            loaded: true,
            defaultModel,
            reasoningEffort: (settings.reasoningEffort as Settings['reasoningEffort']) ?? 'medium',
            defaultMode,
            theme: (settings.theme as Settings['theme']) ?? 'dark',
            activeWorkspaceId: (settings.activeWorkspaceId as string | null) ?? null,
            intentEnabled: (settings.intentEnabled as boolean) ?? true,
            maxSubagentDepth: (settings.maxSubagentDepth as number) ?? 3,
            maxSubagentBreadth: (settings.maxSubagentBreadth as number) ?? 5,
            memoryEnabled: (settings.memoryEnabled as boolean) ?? true,
          })
          // Mirror defaults into the agent store only if the user hasn't already
          // overridden them on an active conversation.
          const agent = useAgentStore.getState()
          if (!agent.activeConversationId) {
            useAgentStore.setState({
              currentModel: defaultModel,
              currentMode: defaultMode,
            })
          }
        } catch (err) {
          console.error('[wos:settings] loadSettings failed', err)
        }
      },

      saveSetting: async (key, value) => {
        set({ [key]: value } as Partial<Settings>)
        await window.wos.setSetting(key, value)
        // Keep the active conversation in sync because the runner reads its model/mode
        // from the DB row, not directly from Settings.
        const agent = useAgentStore.getState()
        if (key === 'defaultModel') {
          if (agent.activeConversationId) {
            await agent.setModel(value as string)
          } else {
            useAgentStore.setState({ currentModel: value as string })
          }
        }
        if (key === 'defaultMode') {
          if (agent.activeConversationId) {
            await agent.setMode(value as string)
          } else {
            useAgentStore.setState({ currentMode: value as string })
          }
        }
      },
    }),
    {
      name: 'wos.settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Persist user prefs locally so the next launch can paint with the correct
      // theme/model before the main-process DB finishes hydrating. The main DB
      // remains the source of truth — loadSettings overwrites these on success.
      partialize: (s) => ({
        defaultModel: s.defaultModel,
        reasoningEffort: s.reasoningEffort,
        defaultMode: s.defaultMode,
        theme: s.theme,
        activeWorkspaceId: s.activeWorkspaceId,
        intentEnabled: s.intentEnabled,
        maxSubagentDepth: s.maxSubagentDepth,
        maxSubagentBreadth: s.maxSubagentBreadth,
        memoryEnabled: s.memoryEnabled,
      }),
      merge: (persisted, current) => ({ ...current, ...((persisted ?? {}) as Partial<Settings>) }),
    },
  ),
)
