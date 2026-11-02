import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentDesktopBackend } from './agentDesktopBridge.js'
import { AgentDesktopProcessError, type AgentDesktopProcessRequest } from './agentDesktopProcess.js'
import { runWithCwdOverride } from '../cwd.js'

const roots: string[] = []
const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Promise.allSettled([...cleanups].map(cleanup => cleanup()))
  cleanups.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cu-native-lifecycle-'))
  roots.push(root)
  const state = { enabled: true, productSession: 'first', failDisable: '' }
  const calls: Array<{ command: string; args: string[]; request: AgentDesktopProcessRequest }> = []
  const nativeSessions = new Map<string, { cursor: boolean; ended: boolean }>()
  let intercept: ((command: string, args: string[]) => void | Promise<void>) | undefined
  const options = {
    binaryPath: process.execPath,
    configRoot: path.join(root, 'config'),
    isDisabled: () => !state.enabled,
    getSessionId: () => state.productSession,
    registerCleanup: (cleanup: () => Promise<void>) => { cleanups.add(cleanup); return () => { cleanups.delete(cleanup) } },
    runner: async (request: AgentDesktopProcessRequest) => {
      const args = [...request.args]
      let sessionId = ''
      while (args[0]?.startsWith('--')) {
        const flag = args.shift()
        if (flag === '--session') sessionId = args.shift()!
        else if (flag === '--agent-id') args.shift()
      }
      const command = args.shift()!
      calls.push({ command, args, request })
      let data: unknown = {}
      let error: unknown
      if (command === 'session' && args[0] === 'start') {
        sessionId = `native-${nativeSessions.size + 1}`
        nativeSessions.set(sessionId, { cursor: true, ended: false })
        data = { session_id: sessionId }
      } else if (command === 'session' && args[0] === 'end') {
        Object.assign(nativeSessions.get(sessionId)!, { cursor: false, ended: true })
      } else if (command === 'cursor-overlay') {
        nativeSessions.get(sessionId)!.cursor = args[0] === 'enable'
        if (args[0] === 'disable' && state.failDisable === 'timeout') {
          throw new AgentDesktopProcessError('fixture teardown timed out', 'timeout', true)
        }
        if (args[0] === 'disable' && state.failDisable === 'native_error') {
          error = { code: 'INTERNAL', message: 'Session state was saved, but cursor teardown was not confirmed', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } }
        }
      } else if (command === 'snapshot') data = { cursor_enabled: nativeSessions.get(sessionId)!.cursor }
      else if (command === 'clipboard-set') data = { contents: await import('node:fs/promises').then(fs => fs.readFile(path.resolve(request.cwd, args.at(-1)!), 'utf8')) }
      await intercept?.(command, args)
      return { stdout: JSON.stringify({ ok: !error, command, ...(error ? { error } : { data }) }), stderr: '', exitCode: error ? 1 : 0 }
    },
  }
  const backend = createAgentDesktopBackend(options)
  return { root, state, calls, nativeSessions, backend, intercept: (handler: typeof intercept) => { intercept = handler } }
}

function receipt(result: Awaited<ReturnType<ReturnType<typeof createAgentDesktopBackend>['execute']>>) {
  const text = result.content.find(block => block.type === 'text')!
  return JSON.parse(text.type === 'text' ? text.text : '')
}

test.each(['session', 'cursor-overlay'])('revoking consent during %s initialization prevents the pending action', async revokeAt => {
  const f = await fixture()
  f.intercept(command => { if (command === revokeAt) f.state.enabled = false })
  const result = await f.backend.execute({ command: 'click', args: ['@s:e1'] })
  expect(result.isError).toBe(true)
  expect(receipt(result).error).toMatchObject({ code: 'POLICY_DENIED', disposition: { delivery: 'not_delivered', retry: 'safe' } })
  expect(f.calls.some(call => call.command === 'click')).toBe(false)
  if (revokeAt === 'session') expect(f.calls.some(call => call.command === 'cursor-overlay')).toBe(false)
})

test.each(['native_error', 'timeout'])('a %s during cursor teardown is followed by a working cursor on the next turn', async failure => {
  const f = await fixture()
  await f.backend.execute({ command: 'snapshot' })
  f.state.failDisable = failure
  await expect(f.backend.cleanup()).rejects.toThrow()
  const result = await f.backend.execute({ command: 'snapshot' })
  expect(receipt(result).data.cursor_enabled).toBe(true)
})

test('an explicit cursor disable failure also recovers before the next action', async () => {
  const f = await fixture()
  await f.backend.execute({ command: 'snapshot' })
  f.state.failDisable = 'native_error'
  expect((await f.backend.execute({ command: 'cursor-overlay', args: ['disable'] })).isError).toBe(true)
  expect(receipt(await f.backend.execute({ command: 'snapshot' })).data.cursor_enabled).toBe(true)
})

test('turn cleanup remains allowed after consent is revoked', async () => {
  const f = await fixture()
  await f.backend.execute({ command: 'snapshot' })
  f.state.enabled = false
  await f.backend.cleanup()
  expect([...f.nativeSessions.values()].every(session => !session.cursor)).toBe(true)
})

test('shutdown ends every owned session after a product session switch and blocks later actions', async () => {
  const f = await fixture()
  await f.backend.execute({ command: 'snapshot' })
  f.state.productSession = 'second'
  await f.backend.execute({ command: 'snapshot' })
  expect(cleanups.size).toBe(1)
  f.state.enabled = false
  await Promise.all([...cleanups].map(cleanup => cleanup()))
  expect([...f.nativeSessions.values()]).toEqual([{ cursor: false, ended: true }, { cursor: false, ended: true }])
  f.state.enabled = true
  const count = f.calls.length
  expect((await f.backend.execute({ command: 'click', args: ['@s:e1'] })).isError).toBe(true)
  expect(f.calls).toHaveLength(count)
  expect(cleanups.size).toBe(0)
})

test('relative input paths resolve in the calling Agent working directory while state stays isolated', async () => {
  const f = await fixture()
  await writeFile(path.join(f.root, 'asset.png'), 'fixture asset')
  const result = await runWithCwdOverride(f.root, () => f.backend.execute({ command: 'clipboard-set', args: ['--image', 'asset.png'] }))
  expect(result.isError).toBeUndefined()
  expect(receipt(result).data.contents).toBe('fixture asset')
  const action = f.calls.find(call => call.command === 'clipboard-set')!
  expect(action.request.env.AGENT_DESKTOP_HOME).toBe(path.join(f.root, 'config/.runtime/agent-desktop'))
})

test('shutdown during initialization cleans a session whose response arrives after cancellation', async () => {
  const f = await fixture()
  let started!: () => void
  let unblock!: () => void
  const atStart = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  f.intercept(async command => {
    if (command === 'session') { started(); await blocked }
  })
  const action = f.backend.execute({ command: 'click', args: ['@s:e1'] })
  await atStart
  expect(cleanups.size).toBe(1)
  const shutdown = Promise.all([...cleanups].map(cleanup => cleanup()))
  unblock()
  await shutdown
  expect((await action).isError).toBe(true)
  expect(f.calls.some(call => call.command === 'click')).toBe(false)
  expect([...f.nativeSessions.values()]).toEqual([{ cursor: false, ended: true }])
})

test('shutdown waits for the cancelled action before its final cursor teardown', async () => {
  const f = await fixture()
  let started!: () => void
  const atAction = new Promise<void>(resolve => { started = resolve })
  const events: string[] = []
  f.intercept(async command => {
    if (command === 'snapshot') {
      const signal = f.calls.at(-1)!.request.signal!
      started()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(() => {
        f.nativeSessions.get('native-1')!.cursor = true
        events.push('last-present')
        resolve()
      }, 30), { once: true }))
      throw new AgentDesktopProcessError('fixture released input after cancellation', 'aborted', true)
    }
    if (command === 'session' && f.calls.at(-1)!.args[0] === 'end') events.push('session-end')
  })
  const action = f.backend.execute({ command: 'snapshot' })
  await atAction
  await Promise.all([...cleanups].map(cleanup => cleanup()))
  expect((await action).isError).toBe(true)
  expect(events).toEqual(['last-present', 'session-end'])
  expect([...f.nativeSessions.values()]).toEqual([{ cursor: false, ended: true }])
})
