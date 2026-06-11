import { describe, expect, it, mock } from 'bun:test'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  buildModelSelectionItems,
  buildProviderSelectionItems,
  createTelegramCommandController,
  createTelegramRuntimeCommandController,
  registerTelegramExtendedCommands,
  renderSelectionView,
  sessionToSelectionItem,
  skillToSelectionItem,
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
            projectPath: '/work/repo',
            workDirExists: true,
            modifiedAt: '2026-06-09T08:00:00.000Z',
            messageCount: 5,
          },
        ],
        total: 1,
      })),
    },
    defaultWorkDir: '/work/repo',
    isAllowedUser: mock(() => true),
    ensureExistingSession: mock(async () => ({ sessionId: 'active', workDir: '/work/repo' })),
    clearTransientChatState: mock((chatId: string) => bridgeEvents.push(`clear:${chatId}`)),
    setStoredSession: mock((chatId: string, sessionId: string, workDir: string) => {
      bridgeEvents.push(`store:${chatId}:${sessionId}:${workDir}`)
    }),
    deleteStoredSession: mock((chatId: string) => bridgeEvents.push(`delete:${chatId}`)),
    resetBridgeSession: mock((chatId: string) => bridgeEvents.push(`reset:${chatId}`)),
    connectBridgeSession: mock((chatId: string, sessionId: string) => {
      bridgeEvents.push(`connect:${chatId}:${sessionId}`)
    }),
    onBridgeServerMessage: mock((chatId: string) => bridgeEvents.push(`listen:${chatId}`)),
    waitForBridgeOpen: mock(async () => true),
    setRuntimeModel: mock((_chatId: string, modelId: string) => {
      runtimeModels.push(modelId)
    }),
    ...overrides,
  } as any

  return {
    controller: createTelegramCommandController(deps),
    deps,
    sent,
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
    expect(commands).toEqual(['start', 'help', 'resume', 'provider', 'model', 'skills'])

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

  it('syncs official provider command and rejects unauthorized private chats', async () => {
    const { controller, deps, runtimeModels } = createController()
    const allowed = createCommandContext({ match: 'claude' })

    await controller.handleProviderCommand(allowed.ctx)

    expect(deps.httpClient.activateOfficialProvider).toHaveBeenCalled()
    expect(deps.httpClient.setCurrentModel).toHaveBeenCalledWith('claude-opus-4-7')
    expect(runtimeModels).toEqual(['claude-opus-4-7'])
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

  it('lists invocable skills and shows selected skill details', async () => {
    const { controller, deps, sent } = createController()
    await controller.handleSkillsCommand(createCommandContext().ctx)

    expect(deps.httpClient.listSkills).toHaveBeenCalledWith('/work/repo')
    expect(sent[0].text).toContain('当前项目可用 Skills')

    const callback = createCommandContext()
    await controller.handleSelectionCallback(callback.ctx, {
      kind: 'skill',
      action: 'pick',
      index: 0,
    })
    expect(callback.edits[0]).toContain('Skill：Skill A')
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
      project: '/work/repo',
      limit: 50,
      offset: 0,
    })
    expect(projectCallback.edits[0]).toContain('选择要恢复的会话')

    const sessionCallback = createCommandContext()
    await controller.handleSelectionCallback(sessionCallback.ctx, {
      kind: 'resume_session',
      action: 'pick',
      index: 0,
    })

    expect(bridgeEvents).toEqual([
      'reset:42',
      'clear:42',
      'store:42:session-123456789:/work/repo',
      'connect:42:session-123456789',
      'listen:42',
    ])
    expect(sessionCallback.edits[0]).toContain('已恢复会话')
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

    expect(deps.deleteStoredSession).toHaveBeenCalledWith('42')
    expect(bridgeEvents).toContain('delete:42')
    expect(timeout.edits[0]).toContain('连接服务器超时')
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
    const controller = createTelegramRuntimeCommandController({
      botApi: { sendMessage: mock(async () => {}) },
      httpClient: createController().deps.httpClient,
      defaultWorkDir: '/work/repo',
      bridge: {
        resetSession: (chatId) => events.push(`reset:${chatId}`),
        connectSession: (chatId, sessionId) => events.push(`connect:${chatId}:${sessionId}`),
        onServerMessage: (chatId, handler) => {
          events.push(`listen:${chatId}`)
          void handler({ type: 'connected' })
        },
        waitForOpen: mock(async () => true),
      },
      sessionStore: {
        set: (chatId, sessionId, workDir) => events.push(`store:${chatId}:${sessionId}:${workDir}`),
        delete: (chatId) => events.push(`delete:${chatId}`),
      },
      isAllowedUser: () => true,
      ensureExistingSession: mock(async () => ({ sessionId: 'active', workDir: '/work/repo' })),
      clearTransientChatState: (chatId) => events.push(`clear:${chatId}`),
      handleServerMessage: (chatId, msg) => {
        events.push(`message:${chatId}:${(msg as any).type}`)
      },
      setRuntimeModel: (chatId, modelId) => events.push(`model:${chatId}:${modelId}`),
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

    expect(events).toContain('model:42:model-x')
    expect(events).toContain('message:42:connected')
  })
})
