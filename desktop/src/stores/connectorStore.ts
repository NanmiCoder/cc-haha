import { create } from 'zustand'
import { connectorsApi } from '@/api/connectors'
import type { ConnectorAction, ConnectorActionOptions, ConnectorDto, ConnectorId } from '@/types/connector'

let revision = 0
let request = 0
export const useConnectorStore = create<{
  items: ConnectorDto[]
  loading: boolean
  error: string | null
  pending: Partial<Record<ConnectorId, boolean>>
  refresh: (signal?: AbortSignal) => Promise<void>
  act: (id: ConnectorId, action: ConnectorAction, options?: ConnectorActionOptions) => Promise<void>
}>((set, get) => ({
  items: [], loading: false, error: null, pending: {},
  refresh: async (signal) => {
    const currentRevision = revision
    const currentRequest = ++request
    set({ loading: get().items.length === 0 })
    try {
      const { items } = await connectorsApi.list(signal)
      if (!signal?.aborted && revision === currentRevision && request === currentRequest) set({ items, error: null })
    } catch (error) {
      if (!signal?.aborted && revision === currentRevision && request === currentRequest) set({ error: String(error) })
    } finally {
      if (request === currentRequest) set({ loading: false })
    }
  },
  act: async (id, action, options) => {
    if (get().pending[id]) return
    revision++
    set((state) => ({ pending: { ...state.pending, [id]: true }, error: null }))
    try {
      const { connector } = await connectorsApi.action(id, action, options)
      revision++
      set((state) => ({ items: state.items.map(item => item.id === id ? connector : item) }))
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set((state) => ({ pending: { ...state.pending, [id]: false } }))
    }
  },
}))
