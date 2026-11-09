import { describe, expect, it } from 'bun:test'
import { deliverImPermissionPrompt, syncImPermissionState } from '../permission-sync.js'

function harness() {
  const runtime = { state: 'permission_pending' as 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending', pendingPermissionCount: 2 }
  const pending = new Map([['chat', new Set(['first', 'second'])], ['other', new Set(['unrelated'])]])
  return { runtime, pending }
}

describe('IM approval reconciliation for restored sessions (#1286)', () => {
  it('redelivers an approval restored after its local response was lost', async () => {
    const { runtime, pending } = harness()
    let prompts = 0
    const deliver = async () => { prompts++ }
    await deliverImPermissionPrompt('chat', 'first', runtime, pending, deliver)
    // The adapter optimistically removes the request after a socket write.
    // A reconnect can prove that the server never received that response.
    pending.get('chat')!.delete('first')
    const snapshot = { type: 'permission_requests_snapshot', toolRequestIds: ['first', 'second'], turnActive: true }
    syncImPermissionState('chat', snapshot, runtime, pending)
    await deliverImPermissionPrompt('chat', 'first', runtime, pending, deliver)
    expect(prompts).toBe(2)
    syncImPermissionState('chat', snapshot, runtime, pending)
    await deliverImPermissionPrompt('chat', 'first', runtime, pending, deliver)
    expect(prompts).toBe(2)
    expect(runtime.pendingPermissionCount).toBe(2)
  })

  it('retries failed delivery after a snapshot and deduplicates successful delivery across snapshots', async () => {
    const { runtime, pending } = harness()
    let attempts = 0
    const deliver = async () => {
      attempts++
      if (attempts === 1) throw new Error('offline')
    }
    await expect(deliverImPermissionPrompt('chat', 'first', runtime, pending, deliver)).rejects.toThrow('offline')
    const snapshot = { type: 'permission_requests_snapshot', toolRequestIds: ['first'], turnActive: true }
    syncImPermissionState('chat', snapshot, runtime, pending)
    await deliverImPermissionPrompt('chat', 'first', runtime, pending, deliver)
    syncImPermissionState('chat', snapshot, runtime, pending)
    await deliverImPermissionPrompt('chat', 'first', runtime, pending, deliver)
    expect(attempts).toBe(2)
    expect(runtime.pendingPermissionCount).toBe(1)
  })

  it.each(['resolution', 'snapshot', 'reset'])('does not resurrect a request removed by %s while delivery waits', async removal => {
    const { runtime, pending } = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let sends = 0
    const delivery = deliverImPermissionPrompt('chat', 'first', runtime, pending, async isCurrent => {
      await gate
      if (isCurrent()) sends++
      throw new Error('interrupted')
    })
    await deliverImPermissionPrompt('chat', 'first', runtime, pending, async () => { sends++ })
    if (removal === 'reset') pending.delete('chat')
    else syncImPermissionState('chat', removal === 'resolution'
      ? { type: 'permission_resolved', permissionType: 'tool', requestId: 'first' }
      : { type: 'permission_requests_snapshot', toolRequestIds: [], turnActive: false }, runtime, pending)
    release()
    await expect(delivery).rejects.toThrow('interrupted')
    expect(sends).toBe(0)
    expect(pending.get('chat')?.has('first') ?? false).toBe(false)
  })

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
