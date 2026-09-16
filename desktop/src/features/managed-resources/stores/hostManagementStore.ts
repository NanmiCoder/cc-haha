import { create } from 'zustand'
import type { Host, ResourceTag } from '../types/resourceTypes.js'
import type {
  CreateHostInput,
  UpdateHostInput,
  CreateTagInput,
  HostManagementHostApi,
  HostManagementError,
  HostManagementResult,
  HostManagementCapabilities,
} from '../api/hostManagementApi.js'
import { getDesktopHost } from '../../../lib/desktopHost/index.js'

async function request<T>(invoke: () => Promise<HostManagementResult<T>>): Promise<HostManagementResult<T>> {
  try {
    return await invoke()
  } catch {
    return { ok: false, error: { code: 'INTERNAL_ERROR', messageKey: 'managedResources.errors.internal' } }
  }
}

function replaceHost(hosts: Host[], saved: Host): Host[] {
  return hosts.some(host => host.id === saved.id)
    ? hosts.map(host => host.id === saved.id ? saved : host)
    : [...hosts, saved]
}

export type HostConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type HostManagementState = {
  hosts: Host[]
  tags: ResourceTag[]
  selectedHostId: string | null
  editingHostId: string | null
  isCreatingHost: boolean
  searchQuery: string
  selectedTagId: string | null
  loading: boolean
  error: HostManagementError | null
  connectionStatus: HostConnectionStatus
  capabilities: HostManagementCapabilities | null

  filteredHosts: () => Host[]
  selectedHost: () => Host | null
  setSearchQuery: (query: string) => void
  setSelectedTagId: (tagId: string | null) => void
  setSelectedHostId: (hostId: string | null) => void
  setEditingHostId: (hostId: string | null) => void
  setIsCreatingHost: (isCreating: boolean) => void
  fetchCapabilities: () => Promise<void>
  fetchHosts: () => Promise<void>
  fetchTags: () => Promise<void>
  saveHost: (input: CreateHostInput | UpdateHostInput) => Promise<{ success: true; host: Host } | { success: false; error: HostManagementError }>
  deleteHost: (id: string, expectedRevision: number) => Promise<{ success: boolean; error?: HostManagementError }>
  saveApplication: (input: Parameters<HostManagementHostApi['saveApplication']>[0]) => Promise<{ success: true; host: Host } | { success: false; error: HostManagementError }>
  deleteApplication: (input: Parameters<HostManagementHostApi['deleteApplication']>[0]) => Promise<{ success: true; host: Host } | { success: false; error: HostManagementError }>
  saveTag: (input: CreateTagInput | { id: string; expectedRevision: number; name: string; colorToken: string | null }) => Promise<{ success: true; tag: ResourceTag } | { success: false; error: HostManagementError }>
  deleteTag: (id: string, expectedRevision: number) => Promise<{ success: boolean; error?: HostManagementError }>
}

export const useHostManagementStore = create<HostManagementState>((set, get) => ({
  hosts: [],
  tags: [],
  selectedHostId: null,
  editingHostId: null,
  isCreatingHost: false,
  searchQuery: '',
  selectedTagId: null,
  loading: false,
  error: null,
  connectionStatus: 'disconnected',
  capabilities: null,

  filteredHosts: () => {
    const { hosts, tags, searchQuery, selectedTagId } = get()
    return hosts.filter((h) => {
      if (selectedTagId && !h.tagIds.includes(selectedTagId)) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchName = h.name.toLowerCase().includes(q)
        const matchAddr = h.address.toLowerCase().includes(q)
        const matchUser = h.username.toLowerCase().includes(q)
        const matchNotes = (h.notes || '').toLowerCase().includes(q)
        const matchApp = h.applications.some(
          (a) => a.name.toLowerCase().includes(q)
            || (a.notes || '').toLowerCase().includes(q)
            || (a.accessDescription || '').toLowerCase().includes(q),
        )
        const hostTags = tags.filter((t) => h.tagIds.includes(t.id))
        const matchTag = hostTags.some((t) => t.name.toLowerCase().includes(q))
        if (!matchName && !matchAddr && !matchUser && !matchNotes && !matchApp && !matchTag) return false
      }
      return true
    })
  },

  selectedHost: () => {
    const { hosts, selectedHostId } = get()
    return hosts.find((h) => h.id === selectedHostId) ?? null
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedTagId: (tagId) => set({ selectedTagId: tagId }),
  setSelectedHostId: (hostId) => set({ selectedHostId: hostId, isCreatingHost: false }),
  setEditingHostId: (hostId) => set({ editingHostId: hostId }),
  setIsCreatingHost: (isCreating) => set({ isCreatingHost: isCreating, ...(isCreating ? { selectedHostId: null } : {}) }),

  fetchCapabilities: async () => {
    const res = await request(() => getDesktopHost().hostManagement.getCapabilities())
    if (res.ok) set({ capabilities: res.data })
    else set({ error: res.error })
  },

  fetchHosts: async () => {
    set({ loading: true, error: null })
    const res = await request(() => getDesktopHost().hostManagement.listHosts())
    if (res.ok) {
      set(state => ({
        hosts: res.data, loading: false,
        selectedHostId: state.selectedHostId && !res.data.some(host => host.id === state.selectedHostId) ? null : state.selectedHostId,
      }))
    } else {
      set({ error: res.error, loading: false })
    }
  },

  fetchTags: async () => {
    const res = await request(() => getDesktopHost().hostManagement.listTags('host'))
    if (res.ok) set({ tags: res.data })
    else set({ error: res.error })
  },

  saveHost: async (input) => {
    set({ loading: true, error: null })
    const res = await request(() => getDesktopHost().hostManagement.saveHost(input))
    if (res.ok) {
      // Never turn a committed write into an apparent failed save because a
      // subsequent read lost transport. Publish the committed public DTO.
      set(state => ({ hosts: replaceHost(state.hosts, res.data), selectedHostId: res.data.id, isCreatingHost: false, editingHostId: null, loading: false }))
      return { success: true, host: res.data }
    }
    set({ error: res.error, loading: false })
    return { success: false, error: res.error }
  },

  deleteHost: async (id, expectedRevision) => {
    set({ loading: true, error: null })
    const res = await request(() => getDesktopHost().hostManagement.deleteHost(id, expectedRevision))
    if (res.ok) {
      set(state => ({ hosts: state.hosts.filter(host => host.id !== id), selectedHostId: state.selectedHostId === id ? null : state.selectedHostId, loading: false }))
      return { success: true }
    }
    set({ error: res.error, loading: false })
    return { success: false, error: res.error }
  },

  saveApplication: async (input) => {
    set({ loading: true, error: null })
    const res = await request(() => getDesktopHost().hostManagement.saveApplication(input))
    if (res.ok) {
      set(state => ({ hosts: replaceHost(state.hosts, res.data), loading: false }))
      return { success: true, host: res.data }
    }
    set({ error: res.error, loading: false })
    return { success: false, error: res.error }
  },

  deleteApplication: async (input) => {
    set({ loading: true, error: null })
    const res = await request(() => getDesktopHost().hostManagement.deleteApplication(input))
    if (res.ok) {
      set(state => ({ hosts: replaceHost(state.hosts, res.data), loading: false }))
      return { success: true, host: res.data }
    }
    set({ error: res.error, loading: false })
    return { success: false, error: res.error }
  },

  saveTag: async (input) => {
    const res = await request(() => getDesktopHost().hostManagement.saveTag(input))
    if (res.ok) {
      set(state => ({ tags: state.tags.some(tag => tag.id === res.data.id) ? state.tags.map(tag => tag.id === res.data.id ? res.data : tag) : [...state.tags, res.data], error: null }))
      return { success: true, tag: res.data }
    }
    set({ error: res.error })
    return { success: false, error: res.error }
  },

  deleteTag: async (id, expectedRevision) => {
    const res = await request(() => getDesktopHost().hostManagement.deleteTag(id, expectedRevision))
    if (res.ok) {
      set(state => ({ tags: state.tags.filter(tag => tag.id !== id), selectedTagId: state.selectedTagId === id ? null : state.selectedTagId }))
      await get().fetchHosts()
      return { success: true }
    }
    set({ error: res.error })
    return { success: false, error: res.error }
  },
}))
