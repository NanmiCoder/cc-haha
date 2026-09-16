import { describe, expect, it, mock } from 'bun:test'
import {
  registerTelegramSessionCommands,
  tryHandleTelegramSessionInput,
} from '../commands.js'

function createSessionRoutes() {
  return {
    startNewSession: mock(async () => {}),
    showProjectPicker: mock(async () => {}),
    showResumeProjectPicker: mock(async () => {}),
    handleSessionInput: mock(async () => false),
  }
}

describe('Telegram session input routing', () => {
  it('routes registered session commands through the normal message pipeline', async () => {
    const handlers = new Map<string, (ctx: any) => unknown>()
    const routeInput = mock(async () => {})
    registerTelegramSessionCommands({
      command: (name, handler) => handlers.set(name, handler),
    }, routeInput)

    const ctx = { match: '2' } as any
    await handlers.get('resume')!(ctx)
    expect(routeInput).toHaveBeenCalledWith(ctx, '/resume 2')
    await handlers.get('sessions')!({ match: '/work/my project' } as any)
    expect(routeInput).toHaveBeenLastCalledWith(expect.anything(), '/sessions /work/my project')
    expect([...handlers.keys()]).toEqual(['new', 'projects', 'sessions', 'resume'])
  })

  it('keeps the existing resume menu and sends numbered selection to shared history', async () => {
    const routes = createSessionRoutes()
    expect(await tryHandleTelegramSessionInput('42', '/resume', false, routes)).toBe(true)
    expect(routes.showResumeProjectPicker).toHaveBeenCalledWith('42')
    expect(routes.handleSessionInput).not.toHaveBeenCalled()

    routes.handleSessionInput.mockResolvedValueOnce(true)
    expect(await tryHandleTelegramSessionInput('42', '/resume 2', false, routes)).toBe(true)
    expect(routes.handleSessionInput).toHaveBeenCalledWith('42', '/resume 2')

    routes.handleSessionInput.mockResolvedValueOnce(true)
    expect(await tryHandleTelegramSessionInput('42', '2', false, routes)).toBe(true)
    expect(routes.handleSessionInput).toHaveBeenLastCalledWith('42', '2')
  })

  it('leaves attachment captions out of all session commands and pickers', async () => {
    const routes = createSessionRoutes()
    for (const text of ['/new /tmp/repo', '/projects', '/sessions', '/resume', '/resume 1', '1']) {
      expect(await tryHandleTelegramSessionInput('42', text, true, routes)).toBe(false)
    }
    for (const route of Object.values(routes)) expect(route).not.toHaveBeenCalled()
  })

  it('handles new and projects inside the same serialized message path', async () => {
    const routes = createSessionRoutes()
    expect(await tryHandleTelegramSessionInput('42', '/new /work/my project', false, routes)).toBe(true)
    expect(routes.startNewSession).toHaveBeenCalledWith('42', '/work/my project')
    expect(await tryHandleTelegramSessionInput('42', '/projects', false, routes)).toBe(true)
    expect(routes.showProjectPicker).toHaveBeenCalledWith('42')
    expect(await tryHandleTelegramSessionInput('42', 'ordinary text', false, routes)).toBe(false)
  })
})
