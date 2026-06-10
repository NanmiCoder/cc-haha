import { formatImHelp } from '../common/format.js'
import type {
  AdapterHttpClient,
  ProviderSummary,
  SessionListItem,
  SkillSummary,
} from '../common/http-client.js'
import {
  buildTelegramSelectionPage,
  parseTelegramSelectionCallback,
  type TelegramSelectionCallback,
  type TelegramSelectionItem,
  type TelegramSelectionKind,
} from './menu.js'

export const TELEGRAM_SELECTION_TTL_MS = 15 * 60 * 1000
export const OFFICIAL_PROVIDER_VALUE = 'official'
export const OPENAI_OFFICIAL_PROVIDER_ID = 'openai-official'
export const OFFICIAL_DEFAULT_MODEL_ID = 'claude-opus-4-7'
export const OPENAI_OFFICIAL_DEFAULT_MODEL_ID = 'gpt-5.3-codex'

type TelegramSendApi = {
  sendMessage: (chatId: number, text: string, options?: TelegramSendOptions) => Promise<unknown>
}

type TelegramSendOptions = {
  reply_markup?: TelegramInlineKeyboardMarkup
}

type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

type TelegramCommandContext = {
  chat?: { id: string | number; type?: string }
  from?: { id: number }
  match?: string | RegExpMatchArray
  callbackQuery?: {
    message?: {
      chat: { id: string | number }
      text?: string
    }
  }
  reply: (text: string) => Promise<unknown>
  editMessageText: (text: string, options?: TelegramSendOptions) => Promise<unknown>
  answerCallbackQuery: (text?: string) => Promise<unknown>
}

type PendingTelegramSelection = {
  kind: TelegramSelectionKind
  title: string
  items: TelegramSelectionItem[]
  page: number
  expiresAt: number
}

type NewSelection = Omit<PendingTelegramSelection, 'expiresAt'>

type RuntimeModelSetter = (chatId: string, modelId: string) => void

export type TelegramCommandControllerDeps = {
  api: TelegramSendApi
  httpClient: AdapterHttpClient
  defaultWorkDir: string
  isAllowedUser: (userId: number) => boolean
  ensureExistingSession: (chatId: string) => Promise<{ sessionId: string; workDir: string } | null>
  clearTransientChatState: (chatId: string) => void
  setStoredSession: (chatId: string, sessionId: string, workDir: string) => void
  deleteStoredSession: (chatId: string) => void
  resetBridgeSession: (chatId: string) => void
  connectBridgeSession: (chatId: string, sessionId: string) => void
  onBridgeServerMessage: (chatId: string) => void
  waitForBridgeOpen: (chatId: string) => Promise<boolean>
  setRuntimeModel: RuntimeModelSetter
}

export type TelegramCommandController = ReturnType<typeof createTelegramCommandController>

export type TelegramCommandRegistrar = {
  command: (command: string, handler: (ctx: TelegramCommandContext) => unknown) => unknown
}

export type TelegramRuntimeCommandControllerDeps = {
  botApi: TelegramSendApi
  httpClient: AdapterHttpClient
  defaultWorkDir: string
  bridge: {
    resetSession: (chatId: string) => void
    connectSession: (chatId: string, sessionId: string) => void
    onServerMessage: (chatId: string, handler: (msg: unknown) => void | Promise<void>) => void
    waitForOpen: (chatId: string) => Promise<boolean>
  }
  sessionStore: {
    set: (chatId: string, sessionId: string, workDir: string) => void
    delete: (chatId: string) => void
  }
  isAllowedUser: (userId: number) => boolean
  ensureExistingSession: (chatId: string) => Promise<{ sessionId: string; workDir: string } | null>
  clearTransientChatState: (chatId: string) => void
  handleServerMessage: (chatId: string, msg: unknown) => void | Promise<void>
  setRuntimeModel: (chatId: string, modelId: string) => void
}

export function createTelegramRuntimeCommandController(
  deps: TelegramRuntimeCommandControllerDeps,
): TelegramCommandController {
  return createTelegramCommandController({
    api: deps.botApi,
    httpClient: deps.httpClient,
    defaultWorkDir: deps.defaultWorkDir,
    isAllowedUser: deps.isAllowedUser,
    ensureExistingSession: deps.ensureExistingSession,
    clearTransientChatState: deps.clearTransientChatState,
    setStoredSession: (chatId, sessionId, workDir) => deps.sessionStore.set(chatId, sessionId, workDir),
    deleteStoredSession: (chatId) => deps.sessionStore.delete(chatId),
    resetBridgeSession: (chatId) => deps.bridge.resetSession(chatId),
    connectBridgeSession: (chatId, sessionId) => deps.bridge.connectSession(chatId, sessionId),
    onBridgeServerMessage: (chatId) => deps.bridge.onServerMessage(
      chatId,
      (msg) => deps.handleServerMessage(chatId, msg),
    ),
    waitForBridgeOpen: (chatId) => deps.bridge.waitForOpen(chatId),
    setRuntimeModel: deps.setRuntimeModel,
  })
}

export function registerTelegramExtendedCommands(
  bot: TelegramCommandRegistrar,
  controller: TelegramCommandController,
): void {
  bot.command('start', (ctx) => void controller.sendHelp(ctx))
  bot.command('help', (ctx) => void controller.sendHelp(ctx))
  bot.command('resume', (ctx) => void controller.handleResumeCommand(ctx))
  bot.command('provider', (ctx) => void controller.handleProviderCommand(ctx))
  bot.command('model', (ctx) => void controller.handleModelCommand(ctx))
  bot.command('skills', (ctx) => void controller.handleSkillsCommand(ctx))
}

export async function tryHandleTelegramSelectionCallback(
  data: string,
  ctx: TelegramCommandContext,
  controller: TelegramCommandController,
): Promise<boolean> {
  const callback = parseTelegramSelectionCallback(data)
  if (!callback) return false
  await controller.handleSelectionCallback(ctx, callback)
  return true
}

export function createTelegramCommandController(deps: TelegramCommandControllerDeps) {
  const pendingSelections = new Map<string, PendingTelegramSelection>()

  const sendSelection = async (chatId: string, selection: NewSelection): Promise<void> => {
    const next = setPendingSelection(pendingSelections, chatId, selection)
    const view = renderSelectionView(next)
    await deps.api.sendMessage(Number(chatId), view.text, { reply_markup: view.replyMarkup })
  }

  const editSelection = async (ctx: TelegramCommandContext, selection: NewSelection): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    const next = setPendingSelection(pendingSelections, chatId, selection)
    const view = renderSelectionView(next)
    try {
      await ctx.editMessageText(view.text, { reply_markup: view.replyMarkup })
    } catch {
      await deps.api.sendMessage(Number(chatId), view.text, { reply_markup: view.replyMarkup })
    }
  }

  const ensureAuthorizedPrivateChat = async (ctx: TelegramCommandContext): Promise<boolean> => {
    if (!ctx.from || ctx.chat?.type !== 'private') return false
    if (deps.isAllowedUser(ctx.from.id)) return true
    await ctx.reply('🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
    return false
  }

  const showProviderPicker = async (chatId: string): Promise<void> => {
    try {
      const { providers, activeId } = await deps.httpClient.listProviders()
      await sendSelection(chatId, {
        kind: 'provider',
        title: '选择 Provider：',
        items: buildProviderSelectionItems(providers, activeId),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取 Provider 列表', err)
    }
  }

  const applyProviderByValue = async (
    chatId: string,
    providerValue: string,
    label?: string,
  ): Promise<{ label: string; defaultModel?: string }> => {
    if (providerValue === OFFICIAL_PROVIDER_VALUE || providerValue === 'claude') {
      await deps.httpClient.activateOfficialProvider()
      await deps.httpClient.setCurrentModel(OFFICIAL_DEFAULT_MODEL_ID)
      deps.setRuntimeModel(chatId, OFFICIAL_DEFAULT_MODEL_ID)
      return { label: 'Claude 官方', defaultModel: OFFICIAL_DEFAULT_MODEL_ID }
    }

    const isOpenAiOfficial = providerValue === OPENAI_OFFICIAL_PROVIDER_ID || providerValue === 'openai'
    const providerId = isOpenAiOfficial ? OPENAI_OFFICIAL_PROVIDER_ID : providerValue
    await deps.httpClient.activateProvider(providerId)

    let defaultModel = isOpenAiOfficial ? OPENAI_OFFICIAL_DEFAULT_MODEL_ID : undefined
    if (!defaultModel) {
      const { providers } = await deps.httpClient.listProviders()
      defaultModel = providers.find((provider) => provider.id === providerId)?.models?.main?.trim() || undefined
    }
    if (defaultModel) {
      await deps.httpClient.setCurrentModel(defaultModel)
      deps.setRuntimeModel(chatId, defaultModel)
    }

    return {
      label: label ? stripSelectedPrefix(label) : isOpenAiOfficial ? 'ChatGPT Official' : providerId,
      defaultModel,
    }
  }

  const handleProviderCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedPrivateChat(ctx)) return
    const chatId = String(ctx.chat!.id)
    const query = getCommandMatchText(ctx)
    if (!query) {
      await showProviderPicker(chatId)
      return
    }

    try {
      const result = await applyProviderByValue(chatId, query)
      await ctx.reply(formatProviderChangedMessage(result.label, result.defaultModel, '发送 /new 后新配置会用于新会话。'))
    } catch (err) {
      await ctx.reply(`❌ Provider 切换失败：${toErrorMessage(err)}`)
    }
  }

  const applyProviderSelection = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    try {
      const result = await applyProviderByValue(chatId, item.value, item.label)
      pendingSelections.delete(chatId)
      await ctx.editMessageText(formatProviderChangedMessage(
        result.label,
        result.defaultModel,
        '当前已运行的会话可能仍使用旧 runtime；发送 /new 后会按新配置启动。',
      ))
    } catch (err) {
      await ctx.editMessageText(`❌ Provider 切换失败：${toErrorMessage(err)}`)
    }
  }

  const showModelPicker = async (chatId: string): Promise<void> => {
    try {
      const [modelsResult, currentResult] = await Promise.all([
        deps.httpClient.listModels(),
        deps.httpClient.getCurrentModel().catch(() => null),
      ])
      if (modelsResult.models.length === 0) {
        await deps.api.sendMessage(Number(chatId), '没有可用模型。请先在桌面端配置 Provider。')
        return
      }

      await sendSelection(chatId, {
        kind: 'model',
        title: `选择模型（${modelsResult.provider?.name ?? 'Claude 官方'}）：`,
        items: buildModelSelectionItems(modelsResult.models, currentResult?.model.id),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取模型列表', err)
    }
  }

  const setModelFromCommand = async (chatId: string, modelId: string): Promise<void> => {
    try {
      await deps.httpClient.setCurrentModel(modelId)
      deps.setRuntimeModel(chatId, modelId)
      await deps.api.sendMessage(Number(chatId), formatModelChangedMessage(modelId))
    } catch (err) {
      await deps.api.sendMessage(Number(chatId), `❌ 模型切换失败：${toErrorMessage(err)}`)
    }
  }

  const handleModelCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedPrivateChat(ctx)) return
    const chatId = String(ctx.chat!.id)
    const modelId = getCommandMatchText(ctx)
    if (modelId) {
      await setModelFromCommand(chatId, modelId)
      return
    }
    await showModelPicker(chatId)
  }

  const applyModelSelection = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    try {
      await deps.httpClient.setCurrentModel(item.value)
      deps.setRuntimeModel(chatId, item.value)
      pendingSelections.delete(chatId)
      await ctx.editMessageText([
        `✅ 已切换模型：${stripSelectedPrefix(item.label)}`,
        item.value,
        '',
        '当前已运行的会话可能仍使用旧 runtime；发送 /new 后会按新模型启动。',
      ].join('\n'))
    } catch (err) {
      await ctx.editMessageText(`❌ 模型切换失败：${toErrorMessage(err)}`)
    }
  }

  const showSkills = async (chatId: string): Promise<void> => {
    const stored = await deps.ensureExistingSession(chatId)
    const cwd = stored?.workDir || deps.defaultWorkDir
    if (!cwd) {
      await deps.api.sendMessage(Number(chatId), '请先发送 /new 选择项目，再查看 Skills。')
      return
    }

    try {
      const { skills } = await deps.httpClient.listSkills(cwd)
      const visibleSkills = skills.filter((skill) => skill.userInvocable)
      if (visibleSkills.length === 0) {
        await deps.api.sendMessage(Number(chatId), `当前项目没有可用 Skills：${cwd}`)
        return
      }

      await sendSelection(chatId, {
        kind: 'skill',
        title: `当前项目可用 Skills：\n${cwd}`,
        items: visibleSkills.map(skillToSelectionItem),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取 Skills', err)
    }
  }

  const handleSkillsCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedPrivateChat(ctx)) return
    await showSkills(String(ctx.chat!.id))
  }

  const applySkillSelection = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    pendingSelections.delete(chatId)
    await ctx.editMessageText([
      `Skill：${item.label}`,
      item.description,
      '',
      '可以直接描述任务让 Agent 自动选择，也可以在桌面端 /skills 查看详情。',
    ].filter(Boolean).join('\n'))
  }

  const showResumeProjectPicker = async (chatId: string): Promise<void> => {
    try {
      const projects = await deps.httpClient.listRecentProjects()
      if (projects.length === 0) {
        await deps.api.sendMessage(Number(chatId), '没有找到最近项目。请先发送 /new 创建会话。')
        return
      }

      await sendSelection(chatId, {
        kind: 'resume_project',
        title: '选择要恢复的项目：',
        items: projects.map((project) => ({
          label: `${project.projectName}${project.branch ? ` (${project.branch})` : ''}`,
          value: project.realPath,
          description: `${project.realPath} · ${project.sessionCount} 个会话`,
        })),
        page: 0,
      })
    } catch (err) {
      await sendError(deps.api, chatId, '无法获取项目列表', err)
    }
  }

  const handleResumeCommand = async (ctx: TelegramCommandContext): Promise<void> => {
    if (!await ensureAuthorizedPrivateChat(ctx)) return
    await showResumeProjectPicker(String(ctx.chat!.id))
  }

  const showResumeSessionPicker = async (
    ctx: TelegramCommandContext,
    project: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    try {
      const { sessions } = await deps.httpClient.listSessions({
        project: project.value,
        limit: 50,
        offset: 0,
      })
      const resumableSessions = sessions.filter((session) => session.workDir)
      if (resumableSessions.length === 0) {
        pendingSelections.delete(chatId)
        await ctx.editMessageText(`没有可恢复会话：${project.label}`)
        return
      }

      await editSelection(ctx, {
        kind: 'resume_session',
        title: `选择要恢复的会话：\n${project.label}`,
        items: resumableSessions.map(sessionToSelectionItem),
        page: 0,
      })
    } catch (err) {
      await ctx.editMessageText(`❌ 无法获取会话列表：${toErrorMessage(err)}`)
    }
  }

  const resumeSessionForChat = async (
    ctx: TelegramCommandContext,
    item: TelegramSelectionItem,
  ): Promise<void> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId) return
    const workDir = item.meta?.workDir
    if (!workDir) {
      await ctx.editMessageText('❌ 这个会话缺少工作目录，无法恢复。')
      return
    }

    deps.resetBridgeSession(chatId)
    deps.clearTransientChatState(chatId)
    deps.setStoredSession(chatId, item.value, workDir)
    deps.connectBridgeSession(chatId, item.value)
    deps.onBridgeServerMessage(chatId)
    const opened = await deps.waitForBridgeOpen(chatId)
    if (!opened) {
      deps.deleteStoredSession(chatId)
      await ctx.editMessageText('⚠️ 恢复会话时连接服务器超时，请重试。')
      return
    }

    pendingSelections.delete(chatId)
    await ctx.editMessageText([
      `✅ 已恢复会话：${item.label}`,
      workDir,
      '',
      '可以继续发送消息。',
    ].join('\n'))
  }

  const handleSelectionCallback = async (
    ctx: TelegramCommandContext,
    callback: TelegramSelectionCallback,
  ): Promise<boolean> => {
    const chatId = getCallbackChatId(ctx)
    if (!chatId || !ctx.from || !deps.isAllowedUser(ctx.from.id)) {
      await ctx.answerCallbackQuery('未授权').catch(() => {})
      return true
    }

    const selection = getPendingSelection(pendingSelections, chatId, callback.kind)
    if (!selection) {
      await ctx.answerCallbackQuery('选择已过期，请重新发送命令').catch(() => {})
      return true
    }

    if (callback.action === 'noop') {
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (callback.action === 'page') {
      await ctx.answerCallbackQuery().catch(() => {})
      await editSelection(ctx, {
        ...selection,
        page: callback.index,
      })
      return true
    }

    const item = selection.items[callback.index]
    if (!item) {
      await ctx.answerCallbackQuery('选项不存在，请重新发送命令').catch(() => {})
      return true
    }

    await ctx.answerCallbackQuery('处理中...').catch(() => {})
    switch (callback.kind) {
      case 'provider':
        await applyProviderSelection(ctx, item)
        break
      case 'model':
        await applyModelSelection(ctx, item)
        break
      case 'resume_project':
        await showResumeSessionPicker(ctx, item)
        break
      case 'resume_session':
        await resumeSessionForChat(ctx, item)
        break
      case 'skill':
        await applySkillSelection(ctx, item)
        break
    }
    return true
  }

  return {
    sendHelp: (ctx: TelegramCommandContext) => ctx.reply(buildTelegramHelpText()),
    handleProviderCommand,
    handleModelCommand,
    handleSkillsCommand,
    handleResumeCommand,
    handleSelectionCallback,
    clearPendingSelections: (chatId: string) => pendingSelections.delete(chatId),
    showProviderPicker,
    showModelPicker,
    showSkills,
    showResumeProjectPicker,
    setModelFromCommand,
  }
}

export function buildTelegramHelpText(): string {
  return [
    '👋 Claude Code Bot 已就绪。',
    '',
    formatImHelp(),
    '',
    'Telegram 扩展命令：',
    '/resume — 恢复历史会话',
    '/provider — 切换 Provider',
    '/model [model] — 查看或切换模型',
    '/skills — 查看当前项目可用 Skills',
  ].join('\n')
}

export function buildProviderSelectionItems(
  providers: ProviderSummary[],
  activeId: string | null,
): TelegramSelectionItem[] {
  return [
    {
      label: `${activeId === null ? '✓ ' : ''}Claude 官方`,
      value: OFFICIAL_PROVIDER_VALUE,
      description: '使用 Claude 官方或环境变量配置',
      meta: { defaultModel: OFFICIAL_DEFAULT_MODEL_ID },
    },
    {
      label: `${activeId === OPENAI_OFFICIAL_PROVIDER_ID ? '✓ ' : ''}ChatGPT Official`,
      value: OPENAI_OFFICIAL_PROVIDER_ID,
      description: '使用 ChatGPT 登录的 Codex 模型',
      meta: { defaultModel: OPENAI_OFFICIAL_DEFAULT_MODEL_ID },
    },
    ...providers.map((provider) => providerToSelectionItem(provider, activeId)),
  ]
}

export function providerToSelectionItem(
  provider: ProviderSummary,
  activeId: string | null,
): TelegramSelectionItem {
  const mainModel = provider.models?.main?.trim()
  return {
    label: `${activeId === provider.id ? '✓ ' : ''}${provider.name}`,
    value: provider.id,
    description: mainModel ? `默认模型：${mainModel}` : provider.id,
    ...(mainModel ? { meta: { defaultModel: mainModel } } : {}),
  }
}

export function buildModelSelectionItems(
  models: Array<{ id: string; name?: string; context?: string; description?: string }>,
  currentModelId?: string,
): TelegramSelectionItem[] {
  return models.map((model) => ({
    label: `${model.id === currentModelId ? '✓ ' : ''}${model.name || model.id}`,
    value: model.id,
    description: [model.id, model.context, model.description].filter(Boolean).join(' · '),
  }))
}

export function skillToSelectionItem(skill: SkillSummary): TelegramSelectionItem {
  const source = skill.pluginName ? `${skill.source}:${skill.pluginName}` : skill.source
  return {
    label: skill.displayName || skill.name,
    value: skill.name,
    description: `${source} · ${skill.description}`,
  }
}

export function sessionToSelectionItem(session: SessionListItem): TelegramSelectionItem {
  const title = session.title || `会话 ${compactId(session.id)}`
  return {
    label: title,
    value: session.id,
    description: `${formatDateTime(session.modifiedAt)} · ${session.messageCount} 条消息 · ${session.workDir}`,
    ...(session.workDir ? { meta: { workDir: session.workDir } } : {}),
  }
}

export function renderSelectionView(selection: PendingTelegramSelection): {
  text: string
  replyMarkup: TelegramInlineKeyboardMarkup
} {
  const page = buildTelegramSelectionPage({
    kind: selection.kind,
    items: selection.items,
    page: selection.page,
  })
  const lines = page.visibleItems.map((item, offset) => {
    const number = offset + 1
    return item.description
      ? `${number}. ${item.label}\n   ${item.description}`
      : `${number}. ${item.label}`
  })
  const pageSuffix = page.totalPages > 1 ? `\n\n第 ${page.page + 1}/${page.totalPages} 页` : ''
  return {
    text: `${selection.title}\n\n${lines.join('\n\n')}${pageSuffix}`,
    replyMarkup: {
      inline_keyboard: page.rows.map((row) => row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      }))),
    },
  }
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function compactId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8)
}

function setPendingSelection(
  pendingSelections: Map<string, PendingTelegramSelection>,
  chatId: string,
  selection: NewSelection,
): PendingTelegramSelection {
  const next = {
    ...selection,
    expiresAt: Date.now() + TELEGRAM_SELECTION_TTL_MS,
  }
  pendingSelections.set(chatId, next)
  return next
}

function getPendingSelection(
  pendingSelections: Map<string, PendingTelegramSelection>,
  chatId: string,
  kind: TelegramSelectionKind,
): PendingTelegramSelection | null {
  const selection = pendingSelections.get(chatId)
  if (!selection || selection.kind !== kind) return null
  if (selection.expiresAt < Date.now()) {
    pendingSelections.delete(chatId)
    return null
  }
  return selection
}

function getCallbackChatId(ctx: TelegramCommandContext): string | null {
  const chatId = ctx.callbackQuery?.message?.chat.id
  return chatId === undefined || chatId === null ? null : String(chatId)
}

function getCommandMatchText(ctx: TelegramCommandContext): string | undefined {
  if (typeof ctx.match !== 'string') return undefined
  return ctx.match.trim() || undefined
}

function formatProviderChangedMessage(label: string, defaultModel: string | undefined, suffix: string): string {
  return [
    `✅ 已切换 Provider：${stripSelectedPrefix(label)}`,
    defaultModel ? `默认模型：${defaultModel}` : undefined,
    '',
    suffix,
  ].filter(Boolean).join('\n')
}

function formatModelChangedMessage(modelId: string): string {
  return [
    `✅ 已切换模型：${modelId}`,
    '',
    '当前已运行的会话可能仍使用旧 runtime；发送 /new 后会按新模型启动。',
  ].join('\n')
}

function stripSelectedPrefix(value: string): string {
  return value.replace(/^✓\s*/, '')
}

async function sendError(api: TelegramSendApi, chatId: string, label: string, err: unknown): Promise<void> {
  await api.sendMessage(Number(chatId), `❌ ${label}：${toErrorMessage(err)}`)
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
