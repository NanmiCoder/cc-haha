import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectorStore } from './connectorStore'
import { connectorsApi } from '@/api/connectors'
import type { ConnectorDto } from '@/types/connector'
vi.mock('@/api/connectors', () => ({ connectorsApi: { list: vi.fn(), action: vi.fn() } }))
const item = { id: 'feishu', status: 'needs-auth' } as ConnectorDto
beforeEach(() => { vi.resetAllMocks(); useConnectorStore.setState({ items: [item], pending: {}, error: null, loading: false }) })
describe('connectorStore', () => {
  it('does not overwrite action results with an older list response', async () => {
    let resolve!: (value: { items: ConnectorDto[] }) => void
    vi.mocked(connectorsApi.list).mockReturnValue(new Promise(r => { resolve = r }))
    const refresh = useConnectorStore.getState().refresh()
    vi.mocked(connectorsApi.action).mockResolvedValue({ connector: { ...item, status: 'ready' } })
    await useConnectorStore.getState().act('feishu', 'check')
    resolve({ items: [item] })
    await refresh
    expect(useConnectorStore.getState().items[0]?.status).toBe('ready')
  })
  it('ignores a response after its page aborts', async () => {
    const controller = new AbortController()
    vi.mocked(connectorsApi.list).mockImplementation(async () => { controller.abort(); return { items: [] } })
    await useConnectorStore.getState().refresh(controller.signal)
    expect(useConnectorStore.getState().items).toEqual([item])
  })
  it('keeps failed actions visible and never synthesizes a ready state', async () => {
    vi.mocked(connectorsApi.action).mockRejectedValue(new Error('offline'))
    await useConnectorStore.getState().act('feishu', 'authenticate')
    expect(useConnectorStore.getState().error).toContain('offline')
    expect(useConnectorStore.getState().items).toEqual([item])
    expect(useConnectorStore.getState().pending.feishu).toBe(false)
  })
})
