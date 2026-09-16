import { api } from '@/api/client'
import type { ConnectorAction, ConnectorActionOptions, ConnectorDto, ConnectorId } from '@/types/connector'

export const connectorsApi = {
  list: (signal?: AbortSignal) => api.get<{ items: ConnectorDto[] }>('/api/connectors', { signal }),
  detail: (id: ConnectorId, signal?: AbortSignal) => api.get<{ connector: ConnectorDto }>(`/api/connectors/${encodeURIComponent(id)}`, { signal }),
  action: (id: ConnectorId, action: ConnectorAction, options: ConnectorActionOptions = {}) =>
    api.post<{ connector: ConnectorDto }>(`/api/connectors/${encodeURIComponent(id)}/${action}`, options),
}
