import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { __markActiveTurnForTests, __resetWebSocketHandlerStateForTests, handleWebSocket, translateCliMessage } from '../ws/handler.js'

afterEach(() => { __resetWebSocketHandlerStateForTests(); mock.restore() })

test('init forwards the authoritative cwd and persists it for only its session', async () => {
  const update = spyOn(conversationService, 'updateSessionWorkDir').mockImplementation(() => {})
  const append = spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
  spyOn(sessionService, 'deletePlaceholderSessionFiles').mockResolvedValue(undefined)
  const output = translateCliMessage({ type: 'system', subtype: 'init', cwd: '/repo/.claude/worktrees/feature', model: 'fixture' }, 'entered')
  expect(output).toContainEqual({ type: 'system_notification', subtype: 'init', message: 'Model: fixture', data: { model: 'fixture', cwd: '/repo/.claude/worktrees/feature' } })
  expect(update.mock.calls).toEqual([['entered', '/repo/.claude/worktrees/feature']])
  expect(append.mock.calls).toEqual([['entered', { workDir: '/repo/.claude/worktrees/feature' }]])
  expect(output.some(message => message.type === 'status')).toBe(false)
})

test('reconnecting clients get the live cwd even after missing the worktree turn', () => {
  spyOn(conversationService, 'onOutput').mockImplementation(() => {})
  spyOn(conversationService, 'getSessionWorkDir').mockImplementation(id => id === 'entered' ? '/repo/.claude/worktrees/feature' : '/other')
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(conversationService, 'getPendingComputerUsePermissionRequests').mockReturnValue([])
  spyOn(sessionService, 'getCustomTitle').mockResolvedValue(null)
  const sent: any[] = []
  const ws = { data: { sessionId: 'entered', connectedAt: Date.now(), channel: 'client' as const, sdkToken: null, serverHost: '127.0.0.1', serverPort: 1234 }, send(value: string) { sent.push(JSON.parse(value)); return 1 }, close() {} }
  handleWebSocket.open(ws)
  expect(sent).toContainEqual({ type: 'system_notification', subtype: 'init', data: { cwd: '/repo/.claude/worktrees/feature' } })
})

test('Stop still synchronizes a worktree transition that completed while cancelling without forwarding stopped output', () => {
  const callbacks: Array<(message: any) => void> = []
  spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => { callbacks.push(callback) })
  spyOn(conversationService, 'hasSession').mockReturnValue(true)
  spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/repo')
  const update = spyOn(conversationService, 'updateSessionWorkDir').mockImplementation(() => {})
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(conversationService, 'getPendingComputerUsePermissionRequests').mockReturnValue([])
  spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
  spyOn(sessionService, 'getCustomTitle').mockResolvedValue(null)
  const append = spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
  spyOn(sessionService, 'deletePlaceholderSessionFiles').mockResolvedValue(undefined)
  const sent: any[] = []
  const ws = { data: { sessionId: 'stopped-worktree', connectedAt: Date.now(), channel: 'client' as const, sdkToken: null, serverHost: '127.0.0.1', serverPort: 1234 }, send(value: string) { sent.push(JSON.parse(value)); return 1 }, close() {} }
  handleWebSocket.open(ws)
  __markActiveTurnForTests('stopped-worktree')
  handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
  const start = sent.length
  for (const callback of callbacks) {
    callback({ type: 'system', subtype: 'init', cwd: '/repo/.claude/worktrees/entered', model: 'fixture' })
    callback({ type: 'assistant', message: { content: [{ type: 'text', text: 'stopped output' }] } })
  }
  expect(update).toHaveBeenCalledWith('stopped-worktree', '/repo/.claude/worktrees/entered')
  expect(append).toHaveBeenCalledWith('stopped-worktree', { workDir: '/repo/.claude/worktrees/entered' })
  expect(sent.slice(start)).toEqual([{ type: 'system_notification', subtype: 'init', data: { cwd: '/repo/.claude/worktrees/entered' } }])
})
