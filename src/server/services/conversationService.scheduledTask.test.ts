import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationService } from './conversationService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

describe('scheduled turn network refresh', () => {
  let directory: string
  let previousConfig: string | undefined
  let previousShellEnv: string | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'scheduled-network-'))
    previousConfig = process.env.CLAUDE_CONFIG_DIR
    previousShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    resetTerminalShellEnvironmentCacheForTests()
    await settings()
  })

  afterEach(async () => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousShellEnv === undefined) delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    else process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = previousShellEnv
    resetTerminalShellEnvironmentCacheForTests()
    await rm(directory, { recursive: true, force: true })
  })

  async function settings(timeout = 600_000) {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ network: {
      aiRequestTimeoutMs: timeout, proxy: { mode: 'manual', url: 'http://global.invalid:17890' },
    } }))
  }

  function fixture() {
    const service = new ConversationService() as any
    let proxy: { mode: string; url?: string } = { mode: 'manual', url: 'http://old-provider.invalid:17891' }
    const getProvider = mock(async () => ({ proxy }))
    service.providerService = { getProvider }
    const frames: any[] = []
    const events: string[] = []
    const session = {
      providerId: 'fixture-provider', outputCallbacks: [] as Array<(frame: any) => void>,
      networkRoutingFingerprint: '', networkDerivedFirstTokenTimeout: true,
      networkDerivedStreamMaxDuration: true, networkDerivedToolInputDuration: true,
      pendingControlRequests: new Map(), pendingOutbound: [],
      sdkSocket: { send(line: string) {
        const frame = JSON.parse(line)
        frames.push(frame)
        events.push(frame.type)
        if (frame.type === 'control_request') queueMicrotask(() => {
          for (const callback of [...session.outputCallbacks]) callback({ type: 'control_response', response: {
            request_id: frame.request_id, subtype: 'success', response: { status: 'queued' },
          } })
        })
      } },
    }
    service.sessions.set('scheduled-session', session)
    return { service, session, frames, events, getProvider, setProxy(value: typeof proxy) { proxy = value } }
  }

  const scheduled = { subtype: 'enqueue_scheduled_task', text: 'Check the project', message_id: 'occurrence' }

  test.each(['manual', 'direct'])('refreshes provider %s routing and budgets before recording delivery and enqueueing', async mode => {
    const f = fixture()
    await f.service.refreshNetworkEnvironmentBeforeTurn('scheduled-session', f.session)
    f.setProxy(mode === 'manual' ? { mode, url: 'http://new-provider.invalid:17892' } : { mode })
    await settings(180_000)
    const beforeSend = mock(async () => { f.events.push('receipt'); return true })
    expect(await f.service.requestControl('scheduled-session', scheduled, 1000, undefined, () => true, beforeSend)).toEqual({ status: 'queued' })
    expect(f.events).toEqual(['update_environment_variables', 'receipt', 'control_request'])
    expect(f.frames[0].variables).toMatchObject({
      HTTP_PROXY: mode === 'manual' ? 'http://new-provider.invalid:17892' : '',
      HTTPS_PROXY: mode === 'manual' ? 'http://new-provider.invalid:17892' : '',
      API_TIMEOUT_MS: '180000', CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS: '180000',
      CLAUDE_STREAM_MAX_DURATION_MS: '600000',
    })
    expect(f.frames[1].request).toEqual(scheduled)
    expect(f.session.pendingControlRequests.size).toBe(0)
    await f.service.requestControl('scheduled-session', scheduled, 1000)
    expect(f.frames.filter(frame => frame.type === 'update_environment_variables')).toHaveLength(1)
  })

  test.each(['abort', 'revoked', 'replaced'])('does not record or enqueue a task %s while network settings are loading', async reason => {
    const f = fixture()
    await f.service.refreshNetworkEnvironmentBeforeTurn('scheduled-session', f.session)
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    f.getProvider.mockImplementation(async () => {
      enter()
      await held
      return { proxy: { mode: 'direct' } }
    })
    const controller = new AbortController()
    let allowed = true
    const beforeSend = mock(async () => true)
    const pending = f.service.requestControl('scheduled-session', scheduled, 1000, controller.signal, () => allowed, beforeSend)
    // The initial implementation skips the getter entirely; use the control
    // result as the other race arm so its regression fails without hanging.
    await Promise.race([entered, pending])
    if (reason === 'abort') controller.abort(new Error('cancelled scheduled task'))
    if (reason === 'revoked') allowed = false
    if (reason === 'replaced') f.service.sessions.set('scheduled-session', { ...f.session })
    release()
    await expect(pending).rejects.toThrow()
    expect(beforeSend).not.toHaveBeenCalled()
    expect(f.frames.some(frame => frame.type === 'control_request')).toBe(false)
    expect(f.session.pendingControlRequests.size).toBe(0)
  })

  test('interrupt control does not refresh network settings or provider state', async () => {
    const f = fixture()
    expect(await f.service.requestControl('scheduled-session', { subtype: 'interrupt' }, 1000)).toEqual({ status: 'queued' })
    expect(f.getProvider).not.toHaveBeenCalled()
    expect(f.frames.map(frame => frame.type)).toEqual(['control_request'])
  })
})
