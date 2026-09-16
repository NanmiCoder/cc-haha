import { describe, expect, it, mock } from 'bun:test'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  buildModelSelectionItems,
  buildProviderSelectionItems,
  createTelegramCommandController,
  createTelegramRuntimeCommandController,
  registerAuthorizedTelegramCommand,
  registerTelegramExtendedCommands,
  renderSelectionView,
  resolveTelegramPermissionCallback,
  sessionToSelectionItem,
  shouldProcessTelegramMessage,
  skillToSelectionItem,
  telegramMessageDedupKey,
  tryHandleTelegramSelectionCallback,
} from '../commands.js'

function createCommandContext(options?: {
  chatId?: number
  userId?: number
  match?: string
  text?: string
}) {
  const replies: string[] = []
  const edits: string[] = []
  const answers: Array<string | undefined> = []
  const ctx = {
    chat: { id: options?.chatId ?? 42, type: 'private' },
    from: { id: options?.userId ?? 7 },
    match: options?.match,
    callbackQuery: {
      message: {
        chat: { id: options?.chatId ?? 42 },
        text: options?.text ?? 'choose',
      },
    },
    reply: mock(async (text: string) => {
      replies.push(text)
    }),
    editMessageText: mock(async (text: string) => {
      edits.push(text)
    }),
    answerCallbackQuery: mock(async (text?: string) => {
      answers.push(text)
    }),
  }
  return { ctx, replies, edits, answers }
}

function createController(overrides?: Record<string, unknown>) {
  const sent: Array<{ chatId: number; text: string; options?: unknown }> = []
  const sentUserMessages: Array<{ chatId: string; content: string }> = []
  const runtimeModels: string[] = []
  const bridgeEvents: string[] = []
  const deps = {
    api: {
      sendMessage: mock(async (chatId: number, text: string, options?: unknown) => {
        sent.push({ chatId, text, options })
      }),
    },
    httpClient: {
      listProviders: mock(async () => ({
        activeId: 'anthropic',
        providers: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: { main: 'claude-sonnet-4-5' },
          },
        ],
      })),
      activateOfficialProvider: mock(async () => {}),
      activateProvider: mock(async () => {}),
      listModels: mock(async () => ({
        provider: { id: 'anthropic', name: 'Anthropic' },
        models: [
          { id: 'claude-sonnet-4-5', name: 'Sonnet', context: '200K' },
          { id: 'claude-opus-4-5', name: 'Opus' },
        ],
      })),
      getCurrentModel: mock(async () => ({ model: { id: 'claude-sonnet-4-5' } })),
      setCurrentModel: mock(async () => {}),
      listSkills: mock(async () => ({
        skills: [
          {
            name: 'skill-a',
            displayName: 'Skill A',
            description: 'does a',
            source: 'plugin',
            userInvocable: true,
            contentLength: 123,
            hasDirectory: true,
          },
          {
            name: 'hidden',
            displayName: 'Hidden',
            description: 'no',
            source: 'plugin',
            userInvocable: false,
            contentLength: 10,
            hasDirectory: false,
          },
        ],
      })),
      listRecentProjects: mock(async () => [
        {
          projectName: 'repo',
          realPath: '/work/repo',
          branch: 'main',
          sessionCount: 2,
        },
      ]),
      listSessions: mock(async () => ({
        sessions: [
          {
            id: 'session-123456789',
            title: 'Fix IM',
            createdAt: '2026-06-09T07:00:00.000Z',
            workDir: '/work/repo',
            projectRoot: '/work/repo',
            projectPath: '/work/repo',
            workDirExists: true,
            modifiedAt: '2026-06-09T08:00:00.000Z',
            messageCount: 5,
          },
        ],
        total: 1,
      })),
      sessionExists: mock(async () => true),
    },
    defaultWorkDir: '/work/repo',
    isAllowedUser: mock(() => true),
    ensureExistingSession: mock(async () => ({ sessionId: 'active', workDir: '/work/repo' })),
    clearTransientChatState: mock((chatId: string) => bridgeEvents.push(`clear:${chatId}`)),
    clearOtherSelections: mock(() => {}),
    isBusy: mock(() => false),
    getStoredSession: mock(() => ({ sessionId: 'active', workDir: '/work/repo', updatedAt: 1 })),
    setStoredSession: mock((chatId: string, sessionId: string, workDir: string) => {
      bridgeEvents.push(`store:${chatId}:${sessionId}:${workDir}`)
    }),
    deleteStoredSession: mock((chatId: string) => bridgeEvents.push(`delete:${chatId}`)),
    resetBridgeSession: mock((chatId: string) => bridgeEvents.push(`reset:${chatId}`)),
    connectBridgeSession: mock((chatId: string, sessionId: string) => {
      bridgeEvents.push(`connect:${chatId}:${sessionId}`)
    }),
    onBridgeServerMessage: mock((chatId: string) => bridgeEvents.push(`listen:${chatId}`)),
    handleServerMessage: mock(async () => {}),
    waitForBridgeOpen: mock(async () => true),
    sendUserMessage: mock((chatId: string, content: string) => {
      sentUserMessages.push({ chatId, content })
      return true
    }),
    setRuntimeModel: mock((_chatId: string, modelId: string) => {
      runtimeModels.push(modelId)
    }),
    ...overrides,
  } as any

  return {
    controller: createTelegramCommandController(deps),
    deps,
    sent,
    sentUserMessages,
    runtimeModels,
    bridgeEvents,
  }
}

describe('Telegram command controller helpers', () => {
  it('builds provider, model, skill, session, and selection view data', () => {
    expect(buildProviderSelectionItems([
      {
        id: 'p1',
        name: 'Provider One',
        models: { main: 'model-main' },
      },
    ], 'p1').map((item) => item.value)).toEqual(['official', 'openai-official', 'p1'])

    expect(buildModelSelectionItems([
      { id: 'm1', name: 'Model One', context: '8K', description: 'fast' },
    ], 'm1')[0]).toEqual({
      label: '✓ Model One',
      value: 'm1',
      description: 'm1 · 8K · fast',
    })

    expect(skillToSelectionItem({
      name: 'x',
      displayName: 'Skill X',
      description: 'desc',
      source: 'plugin',
      pluginName: 'pkg',
      userInvocable: true,
      contentLength: 20,
      hasDirectory: true,
    })).toEqual({
      label: 'Skill X',
      value: 'x',
      description: 'plugin:pkg · desc',
    })

    expect(sessionToSelectionItem({
      id: 'abcdef123456789',
      title: '',
      createdAt: '2026-06-09T07:00:00.000Z',
      workDir: '/repo',
      projectPath: '/repo',
      workDirExists: true,
      modifiedAt: 'not-a-date',
      messageCount: 3,
    })).toEqual({
      label: '会话 abcdef12',
      value: 'abcdef123456789',
      description: 'not-a-date · 3 条消息 · /repo',
      meta: { workDir: '/repo' },
    })

    const view = renderSelectionView({
      kind: 'model',
      title: 'Pick',
      items: [{ label: 'Model', value: 'm' }],
      page: 0,
      expiresAt: Date.now() + 1000,
    })
    expect(view.text).toContain('1. Model')
    expect(view.replyMarkup.inline_keyboard[0][0]).toEqual({
      text: 'Model',
      callback_data: 'tgsel:model:pick:0',
    })
  })

  it('registers extended commands and routes selection callbacks', async () => {
    const commands: string[] = []
    const bot = {
      command: mock((command: string) => commands.push(command)),
    }
    const controller = {
      sendHelp: mock(async () => {}),
      handleResumeCommand: mock(async () => {}),
      handleProviderCommand: mock(async () => {}),
      handleModelCommand: mock(async () => {}),
      handleSkillsCommand: mock(async () => {}),
      handleSelectionCallback: mock(async () => {}),
    } as any

    registerTelegramExtendedCommands(bot, controller)
    expect(commands).toEqual(['start', 'help', 'provider', 'model', 'skills'])

    const handled = await tryHandleTelegramSelectionCallback(
      'tgsel:model:pick:2',
      createCommandContext().ctx,
      controller,
    )
    expect(handled).toBe(true)
    expect(controller.handleSelectionCallback).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'model', action: 'pick', index: 2 },
    )
    expect(await tryHandleTelegramSelectionCallback('permit:req:yes', createCommandContext().ctx, controller))
      .toBe(false)
  })

  it('guards directly registered commands before running side effects', async () => {
    const handlers = new Map<string, (ctx: ReturnType<typeof createCommandContext>['ctx']) => unknown>()
    const bot = {
      command: mock((command: string, handler: (ctx: ReturnType<typeof createCommandContext>['ctx']) => unknown) => {
        handlers.set(command, handler)
      }),
    }
    const action = mock(async () => {})

    registerAuthorizedTelegramCommand(bot, 'new', () => false, action)

    const denied = createCommandContext({ userId: 999 })
    await handlers.get('new')!(denied.ctx)

    expect(action).not.toHaveBeenCalled()
    expect(denied.replies[0]).toContain('未授权')
  })

  it('only resolves pending permission callbacks from authorized users', () => {
    const sendPermissionResponse = mock(() => true)
    const pendingRequestIds = new Set(['req-1'])
    const base = {
      chatId: '42',
      decision: { requestId: 'req-1', allowed: true },
      pendingRequestIds,
      sendPermissionResponse,
    }

    expect(resolveTelegramPermissionCallback({
      ...base,
      userId: 999,
      isAllowedUser: () => false,
    })).toBe('unauthorized')
    expect(sendPermissionResponse).not.toHaveBeenCalled()

    expect(resolveTelegramPermissionCallback({
      ...base,
      userId: 7,
      decision: { requestId: 'expired', allowed: true },
      isAllowedUser: () => true,
    })).toBe('not_pending')
    expect(sendPermissionResponse).not.toHaveBeenCalled()

    const disconnectedPending = new Set(['req-2'])
    expect(resolveTelegramPermissionCallback({
      ...base,
      userId: 7,
      decision: { requestId: 'req-2', allowed: false },
      pendingRequestIds: disconnectedPending,
      isAllowedUser: () => true,
      sendPermissionResponse: () => false,
    })).toBe('send_failed')
    expect(disconnectedPending.has('req-2')).toBe(true)

    expect(resolveTelegramPermissionCallback({
      ...base,
      userId: 7,
      isAllowedUser: () => true,
    })).toBe('sent')
    expect(sendPermissionResponse).toHaveBeenCalledWith('42', 'req-1', true, undefined)
    expect(pendingRequestIds.has('req-1')).toBe(false)
  })

  it('scopes duplicate message keys to the Telegram chat', () => {
    expect(telegramMessageDedupKey('42', 7)).toBe('telegram:42:7')
    expect(telegramMessageDedupKey('43', 7)).not.toBe(telegramMessageDedupKey('42', 7))
    const keys: string[] = []
    const dedup = {
      tryRecord: (key: string) => {
        keys.push(key)
        return true
      },
    }
    expect(shouldProcessTelegramMessage(dedup, '42', undefined)).toBe(false)
    expect(shouldProcessTelegramMessage(dedup, '42', 7)).toBe(true)
    expect(keys).toEqual(['telegram:42:7'])
  })

  it('syncs official provider command and rejects unauthorized private chats', async () => {
    const { controller, deps, runtimeModels } = createController()
    const allowed = createCommandContext({ match: 'claude' })

    await controller.handleProviderCommand(allowed.ctx)

    expect(deps.httpClient.activateOfficialProvider).toHaveBeenCalled()
    expect(deps.httpClient.setCurrentModel).toHaveBeenCalledWith('claude-opus-4-8')
    expect(runtimeModels).toEqual(['claude-opus-4-8'])
    expect(allowed.replies[0]).toContain('Claude 官方')

    const denied = createCommandContext({ userId: 999 })
    deps.isAllowedUser.mockImplementation(() => false)
    await controller.handleProviderCommand(denied.ctx)
    expect(denied.replies[0]).toContain('未授权')
  })

  it('supports direct custom provider and model commands', async () => {
    const { controller, deps, runtimeModels } = createController()

    await controller.handleProviderCommand(createCommandContext({ match: 'anthropic' }).ctx)
    expect(deps.httpClient.activateProvider).toHaveBeenCalledWith('anthropic')
    expect(deps.httpClient.setCurrentModel).toHaveBeenCalledWith('claude-sonnet-4-5')
    expect(runtimeModels).toContain('claude-sonnet-4-5')

    await controller.handleModelCommand(createCommandContext({ match: 'manual-model' }).ctx)
    expect(deps.httpClient.setCurrentModel).toHaveBeenCalledWith('manual-model')
    expect(runtimeModels).toContain('manual-model')
  })

  it('reports empty lists and command failures without throwing', async () => {
    const { controller, sent } = createController({
      defaultWorkDir: '',
      ensureExistingSession: mock(async () => null),
      httpClient: {
        listProviders: mock(async () => { throw new Error('providers down') }),
        activateOfficialProvider: mock(async () => {}),
        activateProvider: mock(async () => { throw new Error('bad provider') }),
        listModels: mock(async () => ({ provider: null, models: [] })),
        getCurrentModel: mock(async () => ({ model: { id: 'none' } })),
        setCurrentModel: mock(async () => { throw new Error('bad model') }),
        listSkills: mock(async () => ({ skills: [] })),
        listRecentProjects: mock(async () => []),
        listSessions: mock(async () => ({ sessions: [], total: 0 })),
      },
    })

    await controller.handleProviderCommand(createCommandContext().ctx)
    expect(sent.at(-1)?.text).toContain('无法获取 Provider 列表')

    const providerCtx = createCommandContext({ match: 'broken' })
    await controller.handleProviderCommand(providerCtx.ctx)
    expect(providerCtx.replies[0]).toContain('Provider 切换失败')

    await controller.handleModelCommand(createCommandContext().ctx)
    expect(sent.at(-1)?.text).toContain('没有可用模型')

    await controller.handleModelCommand(createCommandContext({ match: 'broken-model' }).ctx)
    expect(sent.at(-1)?.text).toContain('模型切换失败')

    await controller.handleSkillsCommand(createCommandContext().ctx)
    expect(sent.at(-1)?.text).toContain('请先发送 /new')

    await controller.handleResumeCommand(createCommandContext().ctx)
    expect(sent.at(-1)?.text).toContain('没有找到最近项目')
  })

  it('covers command fallback branches for help, paging, and list errors', async () => {
    const { controller, sent } = createController()
    const help = createCommandContext()
    await controller.sendHelp(help.ctx)
    expect(help.replies[0]).toContain('/resume')

    await controller.handleModelCommand(createCommandContext().ctx)
    const page = createCommandContext()
    page.ctx.editMessageText = mock(async () => { throw new Error('edit failed') })
    await controller.handleSelectionCallback(page.ctx, {
      kind: 'model',
      action: 'page',
      index: 0,
    })
    expect(sent.at(-1)?.text).toContain('选择模型')

    const noInvocable = createController({
      httpClient: {
        ...createController().deps.httpClient,
        listSkills: mock(async () => ({
          skills: [{
            name: 'hidden',
            displayName: 'Hidden',
            description: 'hidden',
            source: 'plugin',
            userInvocable: false,
            contentLength: 1,
            hasDirectory: false,
          }],
        })),
      },
    })
    await noInvocable.controller.handleSkillsCommand(createCommandContext().ctx)
    expect(noInvocable.sent.at(-1)?.text).toContain('没有可用 Skills')

    const listFailures = createController({
      httpClient: {
        ...createController().deps.httpClient,
        listModels: mock(async () => { throw new Error('models down') }),
        listSkills: mock(async () => { throw new Error('skills down') }),
        listRecentProjects: mock(async () => { throw new Error('projects down') }),
      },
    })
    await listFailures.controller.handleModelCommand(createCommandContext().ctx)
    await listFailures.controller.handleSkillsCommand(createCommandContext().ctx)
    await listFailures.controller.handleResumeCommand(createCommandContext().ctx)
    expect(listFailures.sent.map((message) => message.text).join('\n')).toContain('无法获取模型列表')
    expect(listFailures.sent.map((message) => message.text).join('\n')).toContain('无法获取 Skills')
    expect(listFailures.sent.map((message) => message.text).join('\n')).toContain('无法获取项目列表')
  })

  it('uses paginated callback state for provider selection', async () => {
    const { controller, deps, runtimeModels, sent } = createController()
    const command = createCommandContext()
    await controller.handleProviderCommand(command.ctx)

    expect(sent[0].text).toContain('选择 Provider')
    expect((sent[0].options as any).reply_markup.inline_keyboard[1][0].callback_data)
      .toBe('tgsel:provider:pick:1')

    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'provider',
      action: 'pick',
      index: 1,
    })

    expect(deps.httpClient.activateProvider).toHaveBeenCalledWith('openai-official')
    expect(deps.httpClient.setCurrentModel).toHaveBeenCalledWith(OPENAI_OFFICIAL_DEFAULT_MODEL_ID)
    expect(runtimeModels).toContain(OPENAI_OFFICIAL_DEFAULT_MODEL_ID)
    expect(callback.edits[0]).toContain('ChatGPT Official')
  })

  it('lists models and switches model through callback', async () => {
    const { controller, deps, sent, runtimeModels } = createController()
    await controller.handleModelCommand(createCommandContext().ctx)

    expect(sent[0].text).toContain('选择模型（Anthropic）')
    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'model',
      action: 'pick',
      index: 0,
    })

    expect(deps.httpClient.setCurrentModel).toHaveBeenCalledWith('claude-sonnet-4-5')
    expect(runtimeModels).toEqual(['claude-sonnet-4-5'])
    expect(callback.edits[0]).toContain('已切换模型')
  })

  it('lists invocable skills and sends the selected skill into the active agent session', async () => {
    const { controller, deps, sent, sentUserMessages } = createController()
    await controller.handleSkillsCommand(createCommandContext().ctx)

    expect(deps.httpClient.listSkills).toHaveBeenCalledWith('/work/repo')
    expect(sent[0].text).toContain('当前项目可用 Skills')

    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'skill',
      action: 'pick',
      index: 0,
    })
    expect(deps.ensureExistingSession).toHaveBeenCalledWith('42')
    expect(sentUserMessages).toEqual([{ chatId: '42', content: '/skill-a' }])
    expect(callback.edits[0]).toContain('已调用 Skill：Skill A')
  })

  it('does not claim a selected skill ran when the agent session is unavailable', async () => {
    const unavailable = createController({
      ensureExistingSession: mock(async () => null),
    })
    await unavailable.controller.handleSkillsCommand(createCommandContext().ctx)
    expect(unavailable.sent.at(-1)?.text).toContain('当前项目可用 Skills')

    const callback = createCommandContext()
    await unavailable.controller.handleSelectionCallback(callback.ctx, {
      kind: 'skill',
      action: 'pick',
      index: 0,
    })

    expect(unavailable.sentUserMessages).toEqual([])
    expect(callback.edits[0]).toContain('会话已失效')
  })

  it('reports a disconnected bridge instead of dropping a selected skill', async () => {
    const disconnected = createController({
      sendUserMessage: mock(() => false),
    })
    await disconnected.controller.handleSkillsCommand(createCommandContext().ctx)

    const callback = createCommandContext()
    await disconnected.controller.handleSelectionCallback(callback.ctx, {
      kind: 'skill',
      action: 'pick',
      index: 0,
    })

    expect(callback.edits[0]).toContain('发送失败')
  })

  it('resumes a historical project session through two callbacks', async () => {
    const { controller, deps, sent, bridgeEvents } = createController()
    await controller.handleResumeCommand(createCommandContext().ctx)

    expect(sent[0].text).toContain('选择要恢复的项目')
    const projectCallback = createCommandContext()
    await controller.handleSelectionCallback(projectCallback.ctx, {
      kind: 'resume_project',
      action: 'pick',
      index: 0,
    })

    expect(deps.httpClient.listSessions).toHaveBeenCalledWith({
      limit: 100,
      offset: 0,
    })
    expect(projectCallback.edits[0]).toContain('选择要恢复的会话')

    const sessionCallback = createCommandContext()
    await controller.handleSelectionCallback(sessionCallback.ctx, {
      kind: 'resume_session',
      action: 'pick',
      index: 0,
    })

    expect(bridgeEvents).toContain('connect:42:session-123456789')
    expect(bridgeEvents.indexOf('store:42:session-123456789:/work/repo'))
      .toBeGreaterThan(bridgeEvents.indexOf('connect:42:session-123456789'))
    expect(deps.httpClient.sessionExists).toHaveBeenCalledWith('session-123456789')
    expect(sessionCallback.edits[0]).toContain('已恢复会话')
  })

  it('keeps the current binding when a selected historical session has been deleted', async () => {
    const { controller, deps, bridgeEvents } = createController()
    deps.httpClient.sessionExists = mock(async () => false)
    await controller.handleResumeCommand(createCommandContext().ctx)
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'resume_project', action: 'pick', index: 0,
    })
    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'resume_session', action: 'pick', index: 0,
    })
    expect(bridgeEvents).toEqual([])
    expect(callback.edits[0]).toContain('不存在')
  })

  it('loads every history page and restores a worktree through the project resume menu', async () => {
    const { controller, deps } = createController()
    const histories = Array.from({ length: 105 }, (_, index) => ({
      id: `session-${String(index).padStart(3, '0')}`,
      title: index === 104 ? 'Tree migration' : `History ${index}`,
      createdAt: '2026-06-09T07:00:00.000Z',
      modifiedAt: '2026-06-09T08:00:00.000Z',
      messageCount: 5,
      workDir: index === 104 ? '/work/repo-feature' : '/work/repo',
      projectRoot: '/work/repo',
      projectPath: index === 104 ? '-work-repo-feature' : '-work-repo',
      workDirExists: true,
    }))
    histories.push({ ...histories[0], id: 'foreign', title: 'Other project', workDir: '/work/other', projectRoot: '/work/other' })
    deps.httpClient.listSessions.mockImplementation(async (query: { project?: string; limit: number; offset: number }) => {
      const matches = query.project ? histories.filter((session) => session.workDir === query.project) : histories
      return { sessions: matches.slice(query.offset, query.offset + query.limit), total: matches.length }
    })

    await controller.handleResumeCommand(createCommandContext().ctx)
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'resume_project', action: 'pick', index: 0,
    })
    const lastPage = createCommandContext()
    await controller.handleSelectionCallback(lastPage.ctx, {
      kind: 'resume_session', action: 'page', index: 13,
    })
    expect(lastPage.edits[0]).toContain('Tree migration')
    expect(lastPage.edits[0]).not.toContain('Other project')
    expect(deps.httpClient.listSessions.mock.calls).toEqual([
      [{ limit: 100, offset: 0 }],
      [{ limit: 100, offset: 100 }],
    ])

    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'resume_session', action: 'pick', index: 104,
    })
    expect(deps.setStoredSession).toHaveBeenCalledWith('42', 'session-104', '/work/repo-feature')
    expect(deps.connectBridgeSession).toHaveBeenCalledWith('42', 'session-104')
    expect(callback.edits[0]).toContain('已恢复会话')
  })

  it('refuses to switch an active turn or permission request from the resume menu', async () => {
    const { controller, deps, bridgeEvents } = createController({ isBusy: () => true })
    await controller.handleResumeCommand(createCommandContext().ctx)
    expect(deps.clearOtherSelections).toHaveBeenCalledWith('42')
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'resume_project', action: 'pick', index: 0,
    })
    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'resume_session', action: 'pick', index: 0,
    })
    expect(bridgeEvents).toEqual([])
    expect(callback.edits[0]).toContain('/stop')
    expect(deps.httpClient.sessionExists).not.toHaveBeenCalled()
  })

  it('clears an older menu before a new resume list fails to load', async () => {
    const { controller, deps } = createController()
    await controller.handleResumeCommand(createCommandContext().ctx)
    deps.httpClient.listRecentProjects.mockRejectedValueOnce(new Error('offline'))
    await controller.handleResumeCommand(createCommandContext().ctx)
    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'resume_project', action: 'pick', index: 0,
    })
    expect(callback.answers[0]).toContain('选择已过期')
    expect(deps.httpClient.listSessions).not.toHaveBeenCalled()
  })

  it('reports a preflight failure without disconnecting the current session', async () => {
    const { controller, deps, bridgeEvents } = createController()
    deps.httpClient.sessionExists.mockRejectedValueOnce(new Error('server unavailable'))
    await controller.handleResumeCommand(createCommandContext().ctx)
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'resume_project', action: 'pick', index: 0,
    })
    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'resume_session', action: 'pick', index: 0,
    })
    expect(bridgeEvents).toEqual([])
    expect(callback.edits[0]).toContain('server unavailable')
  })

  it('handles selection callback edge cases and resume timeout cleanup', async () => {
    const unauthorized = createController({ isAllowedUser: mock(() => false) })
    const denied = createCommandContext()
    await unauthorized.controller.handleSelectionCallback(denied.ctx, {
      kind: 'model',
      action: 'pick',
      index: 0,
    })
    expect(denied.answers[0]).toBe('未授权')

    const { controller, deps, bridgeEvents } = createController({
      waitForBridgeOpen: mock(async () => false),
    })
    const stale = createCommandContext()
    await controller.handleSelectionCallback(stale.ctx, {
      kind: 'model',
      action: 'pick',
      index: 0,
    })
    expect(stale.answers[0]).toContain('选择已过期')

    await controller.handleModelCommand(createCommandContext().ctx)
    const noop = createCommandContext()
    await controller.handleSelectionCallback(noop.ctx, {
      kind: 'model',
      action: 'noop',
      index: 0,
    })
    expect(noop.answers).toContain(undefined)

    const missing = createCommandContext()
    await controller.handleSelectionCallback(missing.ctx, {
      kind: 'model',
      action: 'pick',
      index: 99,
    })
    expect(missing.answers[0]).toContain('选项不存在')

    await controller.handleResumeCommand(createCommandContext().ctx)
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'resume_project',
      action: 'pick',
      index: 0,
    })
    const timeout = createCommandContext()
    await controller.handleSelectionCallback(timeout.ctx, {
      kind: 'resume_session',
      action: 'pick',
      index: 0,
    })

    expect(deps.deleteStoredSession).not.toHaveBeenCalled()
    expect(deps.setStoredSession).not.toHaveBeenCalled()
    expect(bridgeEvents).toContain('connect:42:active')
    expect(timeout.edits[0]).toContain('超时')
  })

  it('handles selection callback failures for provider, model, and session lists', async () => {
    const provider = createController()
    await provider.controller.handleProviderCommand(createCommandContext().ctx)
    provider.deps.httpClient.activateProvider.mockImplementationOnce(async () => { throw new Error('provider failed') })
    const providerPick = createCommandContext()
    await provider.controller.handleSelectionCallback(providerPick.ctx, {
      kind: 'provider',
      action: 'pick',
      index: 1,
    })
    expect(providerPick.edits[0]).toContain('Provider 切换失败')

    const model = createController()
    await model.controller.handleModelCommand(createCommandContext().ctx)
    model.deps.httpClient.setCurrentModel.mockImplementationOnce(async () => { throw new Error('model failed') })
    const modelPick = createCommandContext()
    await model.controller.handleSelectionCallback(modelPick.ctx, {
      kind: 'model',
      action: 'pick',
      index: 0,
    })
    expect(modelPick.edits[0]).toContain('模型切换失败')

    const sessions = createController({
      httpClient: {
        ...createController().deps.httpClient,
        listSessions: mock(async () => ({ sessions: [], total: 0 })),
      },
    })
    await sessions.controller.handleResumeCommand(createCommandContext().ctx)
    const projectPick = createCommandContext()
    await sessions.controller.handleSelectionCallback(projectPick.ctx, {
      kind: 'resume_project',
      action: 'pick',
      index: 0,
    })
    expect(projectPick.edits[0]).toContain('没有可恢复会话')

    const sessionFailure = createController({
      httpClient: {
        ...createController().deps.httpClient,
        listSessions: mock(async () => { throw new Error('sessions down') }),
      },
    })
    await sessionFailure.controller.handleResumeCommand(createCommandContext().ctx)
    const failedProjectPick = createCommandContext()
    await sessionFailure.controller.handleSelectionCallback(failedProjectPick.ctx, {
      kind: 'resume_project',
      action: 'pick',
      index: 0,
    })
    expect(failedProjectPick.edits[0]).toContain('无法获取会话列表')
  })

  it('creates a controller from runtime dependencies', async () => {
    const events: string[] = []
    let allowPermissionUser = true
    let sendPermissionSucceeds = true
    const controller = createTelegramRuntimeCommandController({
      botApi: { sendMessage: mock(async () => {}) },
      httpClient: createController().deps.httpClient,
      defaultWorkDir: '/work/repo',
      bridge: {
        resetSession: (chatId) => events.push(`reset:${chatId}`),
        connectSession: (chatId, sessionId) => {
          events.push(`connect:${chatId}:${sessionId}`)
          return true
        },
        onServerMessage: (chatId, handler) => {
          events.push(`listen:${chatId}`)
          void handler({ type: 'connected' })
        },
        waitForOpen: mock(async () => true),
        sendUserMessage: (chatId, content) => {
          events.push(`send:${chatId}:${content}`)
          return true
        },
        sendPermissionResponse: (chatId, requestId, allowed, rule) => {
          events.push(`permit:${chatId}:${requestId}:${allowed}:${rule ?? ''}`)
          return sendPermissionSucceeds
        },
      },
      sessionStore: {
        get: () => ({ sessionId: 'active', workDir: '/work/repo', updatedAt: 1 }),
        set: (chatId, sessionId, workDir) => events.push(`store:${chatId}:${sessionId}:${workDir}`),
        delete: (chatId) => events.push(`delete:${chatId}`),
      },
      isAllowedUser: () => allowPermissionUser,
      ensureExistingSession: mock(async () => ({ sessionId: 'active', workDir: '/work/repo' })),
      clearTransientChatState: (chatId) => events.push(`clear:${chatId}`),
      clearOtherSelections: () => {},
      isBusy: () => false,
      handleServerMessage: (chatId, msg) => {
        events.push(`message:${chatId}:${(msg as any).type}`)
      },
      setRuntimeModel: (chatId, modelId) => events.push(`model:${chatId}:${modelId}`),
      setRuntimeBusy: (chatId) => events.push(`busy:${chatId}`),
    })

    await controller.setModelFromCommand('42', 'model-x')
    await controller.handleResumeCommand(createCommandContext().ctx)
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'resume_project',
      action: 'pick',
      index: 0,
    })
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'resume_session',
      action: 'pick',
      index: 0,
    })
    const permissionCtx = createCommandContext()
    await controller.handlePermissionCallback(permissionCtx.ctx, {
      requestId: 'req-1',
      allowed: true,
    }, new Map([['42', new Set(['req-1'])]]), (chatId) => events.push(`decrement:${chatId}`))

    expect(events).toContain('model:42:model-x')
    expect(events).toContain('message:42:connected')
    expect(events).toContain('permit:42:req-1:true:')
    expect(events).toContain('decrement:42')
    expect(permissionCtx.edits[0]).toContain('已允许')

    await controller.handleSkillsCommand(createCommandContext().ctx)
    await controller.handleSelectionCallback(createCommandContext().ctx, {
      kind: 'skill', action: 'pick', index: 0,
    })
    expect(events).toContain('send:42:/skill-a')
    expect(events).toContain('busy:42')

    const missingIdentityCtx = createCommandContext()
    delete (missingIdentityCtx.ctx as any).from
    await expect(controller.handlePermissionCallback(missingIdentityCtx.ctx, {
      requestId: 'missing-user',
      allowed: true,
    }, new Map(), () => {})).resolves.toBe('unauthorized')

    allowPermissionUser = false
    const unauthorizedCtx = createCommandContext()
    await expect(controller.handlePermissionCallback(unauthorizedCtx.ctx, {
      requestId: 'unauthorized',
      allowed: true,
    }, new Map([['42', new Set(['unauthorized'])]]), () => {})).resolves.toBe('unauthorized')
    expect(unauthorizedCtx.answers).toContain('未授权')

    allowPermissionUser = true
    const expiredCtx = createCommandContext()
    await expect(controller.handlePermissionCallback(expiredCtx.ctx, {
      requestId: 'expired',
      allowed: true,
    }, new Map(), () => {})).resolves.toBe('not_pending')
    expect(expiredCtx.answers).toContain('权限请求已失效')

    sendPermissionSucceeds = false
    const failedCtx = createCommandContext()
    await expect(controller.handlePermissionCallback(failedCtx.ctx, {
      requestId: 'send-failed',
      allowed: false,
    }, new Map([['42', new Set(['send-failed'])]]), () => {})).resolves.toBe('send_failed')
    expect(failedCtx.answers).toContain('权限响应发送失败')
  })
})
