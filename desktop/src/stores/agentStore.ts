import { create } from 'zustand'
import { agentsApi, type AgentDefinition } from '../api/agents'

type AgentStore = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  isLoading: boolean
  error: string | null
  selectedAgent: AgentDefinition | null

  fetchAgents: (cwd?: string) => Promise<void>
  selectAgent: (agent: AgentDefinition | null) => void
}

export const useAgentStore = create<AgentStore>((set) => ({
  activeAgents: [],
  allAgents: [],
  isLoading: false,
  error: null,
  selectedAgent: null,

  fetchAgents: async (cwd) => {
    set({ isLoading: true, error: null })
    try {
      const { activeAgents, allAgents } = await agentsApi.list(cwd)
      set({ activeAgents, allAgents, isLoading: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load agents'
      set({ isLoading: false, error: message })
    }
  },

  selectAgent: (agent) => set({ selectedAgent: agent }),
}))
