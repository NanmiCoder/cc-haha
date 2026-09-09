import { describe, expect, it } from 'bun:test'
import { syncImPermissionState } from '../permission-sync.js'

function harness() {
  const runtime = { state: 'permission_pending' as 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending', pendingPermissionCount: 2 }
  const pending = new Map([['chat', new Set(['first', 'second'])], ['other', new Set(['unrelated'])]])
  return { runtime, pending }
}

describe('IM approval reconciliation for restored sessions (#1286)', () => {
  it('removes approvals answered in Desktop, without decrementing twice', () => {
    const { runtime, pending } = harness()
    const resolved = { type: 'permission_resolved', permissionType: 'tool', requestId: 'first' }
    expect(syncImPermissionState('chat', resolved, runtime, pending)).toBe(true)
    expect([...pending.get('chat')!]).toEqual(['second'])
    expect(runtime).toEqual({ state: 'permission_pending', pendingPermissionCount: 1 })
    syncImPermissionState('chat', resolved, runtime, pending)
    expect(runtime.pendingPermissionCount).toBe(1)

    syncImPermissionState('chat', { ...resolved, requestId: 'second' }, runtime, pending)
    expect(runtime).toEqual({ state: 'thinking', pendingPermissionCount: 0 })
    expect(pending.has('chat')).toBe(false)
    expect([...pending.get('other')!]).toEqual(['unrelated'])
  })

  it('keeps tool approvals intact when computer-use approval IDs overlap', () => {
    const { runtime, pending } = harness()
    syncImPermissionState('chat', { type: 'permission_resolved', permissionType: 'computer_use', requestId: 'first' }, runtime, pending)
    expect([...pending.get('chat')!]).toEqual(['first', 'second'])
    expect(runtime.pendingPermissionCount).toBe(2)
  })

  it('uses the reconnect snapshot to remove stale approvals and deduplicate replay', () => {
    const { runtime, pending } = harness()
    runtime.pendingPermissionCount = 9
    syncImPermissionState('chat', { type: 'permission_requests_snapshot', toolRequestIds: ['second', 'second', 'new'], turnActive: true }, runtime, pending)
    expect([...pending.get('chat')!]).toEqual(['second', 'new'])
    expect(runtime).toEqual({ state: 'permission_pending', pendingPermissionCount: 2 })
  })

  it('unblocks switching after a disconnected approval was resolved and the turn finished', () => {
    const { runtime, pending } = harness()
    syncImPermissionState('chat', { type: 'permission_requests_snapshot', toolRequestIds: [], turnActive: false }, runtime, pending)
    expect(runtime).toEqual({ state: 'idle', pendingPermissionCount: 0 })
    expect(pending.has('chat')).toBe(false)
  })

  it('keeps a continuing turn busy after its last approval disappears', () => {
    const { runtime, pending } = harness()
    syncImPermissionState('chat', { type: 'permission_requests_snapshot', toolRequestIds: [], turnActive: true }, runtime, pending)
    expect(runtime).toEqual({ state: 'thinking', pendingPermissionCount: 0 })
    runtime.state = 'streaming'
    syncImPermissionState('chat', { type: 'permission_requests_snapshot', toolRequestIds: [], turnActive: true }, runtime, pending)
    expect(runtime.state).toBe('streaming')
  })

  it('preserves approvals when an older snapshot only reports turn activity', () => {
    const { runtime, pending } = harness()
    syncImPermissionState('chat', { type: 'permission_requests_snapshot', turnActive: true }, runtime, pending)
    expect(runtime).toEqual({ state: 'permission_pending', pendingPermissionCount: 2 })
  })

  it('leaves unrelated event routing and late duplicate resolutions unchanged', () => {
    const runtime = { state: 'idle' as const, pendingPermissionCount: 0 }
    const pending = new Map<string, Set<string>>()
    expect(syncImPermissionState('chat', { type: 'content_delta', text: 'hello' }, runtime, pending)).toBe(false)
    syncImPermissionState('chat', { type: 'permission_resolved', permissionType: 'tool', requestId: 'already-done' }, runtime, pending)
    expect(runtime).toEqual({ state: 'idle', pendingPermissionCount: 0 })
  })
})
