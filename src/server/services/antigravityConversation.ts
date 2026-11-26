import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  acpModeToCcHahaPermissionMode,
  acpObject,
  AntigravityError,
  configOption,
  parseAvailableCommands,
  type AntigravityAcp,
  type AntigravitySlashCommand,
} from './antigravityAcp.js'
import {
  isAntigravityComputerUseToolName,
  type AntigravityComputerUseBridge,
} from './antigravityComputerUseBridge.js'

const CANCEL_TIMEOUT_MS = 3_000

type Frame = Record<string, unknown>
type Option = { optionId: string; name: string; kind?: unknown }
type PendingPermission = { options: Option[] } & (
  | { id: number | string; question?: string }
  | { promptToolUseId: string; question: string }
)
type PromptQuestion = {
  tool: Frame
  question: string
  options: Option[]
  echo: string
  buffered: string
}

type Turn = {
  entries: Frame[]
  permissions: Map<string, PendingPermission>
  promptQuestion?: PromptQuestion
  promptAnswer?: { toolUseId: string; question: string; label: string }
  chunk?: { kind: 'text' | 'thinking'; text: string; index: number }
  nextIndex: number
  started: number
  detached: boolean
  nativeEnd?: { result: Frame; error?: AntigravityError }
  replyOpen: boolean
  finishing: boolean
  cancelled: boolean
  cancelTimer?: ReturnType<typeof setTimeout>
  resolve: () => void
}

type ProjectedTool = {
  name: string
  input: Frame
  displayName?: string
  description?: string
  antigravityToolName?: string
  subagentName?: string
  subagentId?: string
  isSubagentInvoke?: boolean
}

export type AntigravityConversationOptions = {
  computerUseBridge?: AntigravityComputerUseBridge | null
  onAvailableCommands?: (commands: AntigravitySlashCommand[]) => void
  antigravityAppDataDir?: string
}

type ContextUsageState = {
  used: number
  size: number
}

type CumulativeUsageState = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function textContent(value: unknown): string {
  const block = acpObject(value)
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

function fallbackToolName(tool: Frame): string {
  // ACP 标题是显示文本，不应触发同名的 Claude Code 特殊工具逻辑。
  return typeof tool.title === 'string' && tool.title.trim() ? `Antigravity: ${tool.title}` : 'Antigravity'
}

function toolContent(tool: Frame): string {
  const output = acpObject(tool.rawOutput)
  const commandOutput = output?.combinedOutput ?? output?.combined_output ?? output?.output
  if (typeof commandOutput === 'string') return commandOutput
  const content = Array.isArray(tool.content) ? tool.content.map(value => {
    const item = acpObject(value)
    if (item?.type === 'content') return textContent(item.content)
    if (item?.type === 'diff' && typeof item.path === 'string') return item.path
    return ''
  }).filter(Boolean).join('\n') : ''
  if (content) return content
  return typeof tool.rawOutput === 'string' ? tool.rawOutput : typeof tool.title === 'string' ? tool.title : ''
}

function toolHasFinished(tool: Frame): boolean {
  return tool.status === 'completed' || tool.status === 'failed'
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function extractDiffBlock(tool: Frame): { path?: string; oldText?: string; newText?: string } | undefined {
  if (!Array.isArray(tool.content)) return undefined
  for (const item of tool.content) {
    const record = acpObject(item)
    if (record?.type === 'diff') {
      return {
        path: typeof record.path === 'string' ? record.path : undefined,
        oldText: typeof record.oldText === 'string' ? record.oldText : undefined,
        newText: typeof record.newText === 'string' ? record.newText : undefined,
      }
    }
  }
  return undefined
}

function extractLocationPath(tool: Frame): string | undefined {
  if (!Array.isArray(tool.locations)) return undefined
  for (const item of tool.locations) {
    const record = acpObject(item)
    if (typeof record?.path === 'string' && record.path.trim()) return record.path
  }
  return undefined
}

/**
 * Extract child subagent/swarm-worker conversationId from ACP toolCallId prefix.
 * Verified in `agy 1.5.17`: child calls arrive as `<childConversationId>:call_<digits>`.
 */
export function parseSubagentToolCallPrefix(toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined
  const colon = toolCallId.indexOf(':')
  if (colon <= 0) return undefined
  const prefix = toolCallId.slice(0, colon)
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(prefix)) return undefined
  return prefix
}

function joinReplacementChunks(chunks: unknown, key: 'TargetContent' | 'ReplacementContent'): string | undefined {
  if (!Array.isArray(chunks) || chunks.length === 0) return undefined
  const parts = chunks
    .map(acpObject)
    .map(chunk => (typeof chunk?.[key] === 'string' ? chunk[key] as string : ''))
  return parts.join('\n---\n')
}

function readPromptQuestion(tool: Frame): PromptQuestion | undefined {
  if (tool.name !== 'ask_question') return
  const questions = acpObject(tool.rawInput)?.questions
  if (!Array.isArray(questions) || questions.length !== 1) return
  const input = acpObject(questions[0])
  if (!input || typeof input.question !== 'string' || !input.question.trim() || input.is_multi_select !== false) return
  const labels: unknown = input.options
  if (!Array.isArray(labels) || !labels.length || !labels.every((label): label is string => typeof label === 'string' && !!label.trim()) || new Set(labels).size !== labels.length) return
  const options = labels.map((name, index) => ({ name, optionId: String(index + 1) }))
  return {
    tool, question: input.question, options, buffered: '',
    echo: `\n${input.question}\n${options.map(option => `- [${option.optionId}] ${option.name}\n`).join('')}`,
  }
}

function questionInput(question: string, options: Option[]): Frame {
  return {
    allowFreeText: false,
    questions: [{ question, header: 'Antigravity', multiSelect: false, options: options.map(option => ({ label: option.name })) }],
  }
}

function resolveDefaultAppDataDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

/** 把外部 Agent 的回合及后续后台输出投影到实时消息与会话历史。 */
export class AntigravityConversation {
  private turn?: Turn
  private turnDone?: Promise<void>
  private listening = false
  // 原生工具的寿命可以超过一次 prompt；null 记住已转发的终态，防止重复输出结果。
  private tools = new Map<string, Frame | null>()
  private availableCommands: AntigravitySlashCommand[] = []
  private contextUsage?: ContextUsageState
  private cumulativeUsage: CumulativeUsageState = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
  private readonly subagentNameCache = new Map<string, string>()
  private readonly claimedSubagentIds = new Set<string>()
  private readonly computerUseBridge?: AntigravityComputerUseBridge | null
  private readonly onAvailableCommands?: (commands: AntigravitySlashCommand[]) => void
  private readonly antigravityAppDataDir: string

  constructor(
    readonly acp: AntigravityAcp,
    private readonly emit: (message: Frame) => void,
    private readonly append: (entries: Frame[]) => Promise<void>,
    options: AntigravityConversationOptions = {},
  ) {
    this.computerUseBridge = options.computerUseBridge
    this.onAvailableCommands = options.onAvailableCommands
    this.antigravityAppDataDir = options.antigravityAppDataDir ?? resolveDefaultAppDataDir()
    acp.onMessage = (method, params, id) => this.receive(method, params, id)
    if (acp.initialAvailableCommands.length > 0) {
      this.availableCommands = acp.initialAvailableCommands
      this.onAvailableCommands?.(this.availableCommands)
    }
  }

  get isResponding(): boolean {
    return !!this.turn && !this.turn.cancelled
  }

  get pendingTurnCompletion(): Promise<void> | undefined {
    return this.turn ? this.turnDone : undefined
  }

  get slashCommands(): AntigravitySlashCommand[] {
    return this.availableCommands
  }

  getContextUsageSnapshot(): Record<string, unknown> {
    const used = this.contextUsage?.used ?? 0
    const maxTokens = this.contextUsage?.size && this.contextUsage.size > 0 ? this.contextUsage.size : 200_000
    const percentage = maxTokens > 0 ? Math.min(100, Math.round((used / maxTokens) * 100)) : 0
    const freeTokens = Math.max(0, maxTokens - used)
    const filledSquares = Math.min(100, Math.max(0, percentage))
    return {
      categories: [
        { name: 'Messages', tokens: used, color: '#7c3aed' },
        { name: 'Free space', tokens: freeTokens, color: '#a1a1aa' },
      ],
      totalTokens: used,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage,
      gridRows: Array.from({ length: 10 }, (_, row) =>
        Array.from({ length: 10 }, (_, col) => {
          const index = row * 10 + col
          const isFilled = index < filledSquares
          return {
            color: isFilled ? '#7c3aed' : '#a1a1aa',
            isFilled,
            categoryName: isFilled ? 'Messages' : 'Free space',
            tokens: Math.round(maxTokens / 100),
            percentage: 1,
            squareFullness: isFilled ? 1 : 0,
          }
        }),
      ),
      model: this.acp.modelId ?? 'Antigravity',
      estimateOnly: false,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: {
        input_tokens: this.cumulativeUsage.inputTokens,
        output_tokens: this.cumulativeUsage.outputTokens,
        cache_creation_input_tokens: this.cumulativeUsage.cacheCreationTokens,
        cache_read_input_tokens: this.cumulativeUsage.cacheReadTokens,
      },
    }
  }

  getSessionUsageSnapshot(): Record<string, unknown> {
    const model = this.acp.modelId ?? 'Antigravity'
    return {
      totalCostUSD: 0,
      costDisplay: '$0.00',
      hasUnknownModelCost: true,
      totalAPIDuration: 0,
      totalDecodeDuration: 0,
      totalTtftDuration: 0,
      totalDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalInputTokens: this.cumulativeUsage.inputTokens,
      totalOutputTokens: this.cumulativeUsage.outputTokens,
      totalCacheReadInputTokens: this.cumulativeUsage.cacheReadTokens,
      totalCacheCreationInputTokens: this.cumulativeUsage.cacheCreationTokens,
      totalWebSearchRequests: 0,
      models: [{
        model,
        displayName: model,
        inputTokens: this.cumulativeUsage.inputTokens,
        outputTokens: this.cumulativeUsage.outputTokens,
        cacheReadInputTokens: this.cumulativeUsage.cacheReadTokens,
        cacheCreationInputTokens: this.cumulativeUsage.cacheCreationTokens,
        webSearchRequests: 0,
        costUSD: 0,
        costDisplay: '$0.00',
        contextWindow: this.contextUsage?.size ?? 200_000,
        maxOutputTokens: 0,
      }],
    }
  }

  async waitForCancelledTurn(): Promise<void> {
    if (this.turn?.cancelled) await this.turnDone
  }

  async waitForExit(): Promise<void> {
    await this.acp.drained
    this.listening = false
    this.tools.clear()
    void this.computerUseBridge?.releaseLock()
    const turn = this.turn
    if (turn) {
      turn.replyOpen = false
      this.cancelPermissions(turn)
      this.maybeFinish(turn)
    }
    await this.turnDone
  }

  flushForShutdown(): Promise<void> | undefined {
    // 不依赖子进程确认取消或主动关闭 stdout；只等本地受控的历史写入。
    if (this.turn || [...this.tools.values()].some(tool => tool?.status === 'in_progress')) this.cancel()
    this.listening = false
    this.acp.end()
    void this.computerUseBridge?.releaseLock()
    return this.turnDone
  }

  send(userContent: Frame[], uuid: string): boolean {
    if (this.turn || !this.acp.isOpen) return false
    const prompt = userContent.flatMap((block): Frame[] => {
      if (block.type === 'text' && typeof block.text === 'string') return [block]
      const source = acpObject(block.source)
      if (block.type === 'image' && source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string' && this.acp.supportsImages) {
        return [{ type: 'image', data: source.data, mimeType: source.media_type }]
      }
      return []
    })
    if (prompt.length !== userContent.length) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', 'The selected Antigravity CLI cannot receive these attachments.')
    }
    this.computerUseBridge?.resetTurnAbort()
    for (const [id, tool] of this.tools) if (!tool) this.tools.delete(id)
    const turn = this.beginTurn(false)
    void this.run(turn, prompt, { type: 'user', uuid, message: { role: 'user', content: userContent } })
    return true
  }

  cancel(): boolean {
    const turn = this.turn
    if (turn?.cancelled) return true
    this.listening = false
    this.tools.clear()
    this.computerUseBridge?.abortCurrentTurn()
    const sent = this.acp.cancel()
    if (!turn) return sent
    turn.cancelled = true
    if (!turn.nativeEnd) {
      // 截止时间属于 ACP 回合，不受 WebSocket 重连或下一条输入影响。
      turn.cancelTimer = setTimeout(() => {
        if (this.turn === turn) this.acp.close('SIGKILL')
      }, CANCEL_TIMEOUT_MS)
    }
    this.cancelPermissions(turn)
    this.maybeFinish(turn)
    return sent
  }

  respond(requestId: string, allowed: boolean, updatedInput?: Frame, rule?: string): boolean {
    const turn = this.turn
    const pending = turn?.permissions.get(requestId)
    if (!turn || turn.cancelled || !pending) return false
    let choice: Option | undefined
    if (pending.question) {
      const answer = acpObject(updatedInput?.answers)?.[pending.question]
      if (allowed) {
        choice = pending.options.find(option => option.name === answer)
        if (!choice) return false
      }
    } else if (allowed) {
      choice = rule === 'always'
        ? pending.options.find(option => option.kind === 'allow_always') ?? pending.options.find(option => option.kind === 'allow_once')
        : pending.options.find(option => option.kind === 'allow_once') ?? pending.options.find(option => option.kind === 'allow_always')
    } else {
      choice = rule === 'always'
        ? pending.options.find(option => option.kind === 'reject_always') ?? pending.options.find(option => option.kind === 'reject_once')
        : pending.options.find(option => option.kind === 'reject_once') ?? pending.options.find(option => option.kind === 'reject_always')
    }
    if ('promptToolUseId' in pending) {
      if (!this.acp.isOpen) return false
      turn.permissions.delete(requestId)
      if (!choice) return this.cancel()
      turn.promptAnswer = { toolUseId: pending.promptToolUseId, question: pending.question, label: choice.name }
      // AGY 在原请求返回 end_turn 后，才会从下一次 prompt 读取选项编号。
      turn.nativeEnd = undefined
      turn.replyOpen = false
      void this.run(turn, [{ type: 'text', text: choice.optionId }])
      return true
    }
    if (!this.replyPermission(pending.id, choice)) return false
    turn.permissions.delete(requestId)
    this.maybeFinish(turn)
    return true
  }

  private resolveSubagentName(childConversationId: string): string {
    const cached = this.subagentNameCache.get(childConversationId)
    if (cached) return cached

    const brainDir = join(this.antigravityAppDataDir, 'brain', this.acp.sessionId, '.system_generated')
    try {
      const membersRaw = JSON.parse(readFileSync(join(brainDir, 'swarm', 'members.json'), 'utf8')) as Record<string, unknown>
      const members = acpObject(membersRaw.members)
      if (members) {
        for (const [rosterName, value] of Object.entries(members)) {
          const member = acpObject(value)
          if (member?.conversation_id === childConversationId) {
            this.subagentNameCache.set(childConversationId, rosterName)
            return rosterName
          }
        }
      }
    } catch { /* swarm file absent or unreadable */ }

    try {
      const subagentRaw = JSON.parse(readFileSync(join(brainDir, 'subagents', `${childConversationId}.json`), 'utf8')) as Record<string, unknown>
      const desc = acpObject(subagentRaw.subagentDescriptor)
      const label = firstString(desc?.role, desc?.typeName)
      if (label) {
        this.subagentNameCache.set(childConversationId, label)
        return label
      }
    } catch { /* subagent metadata file absent or unreadable */ }

    return childConversationId.slice(0, 8)
  }

  private resolveChildConversationIdForInvoke(tool: Frame): string | undefined {
    const rawOutput = acpObject(tool.rawOutput)
    const direct = firstString(rawOutput?.conversationId, rawOutput?.conversation_id, rawOutput?.agentId, rawOutput?.agent_id)
    if (direct) {
      this.claimedSubagentIds.add(direct)
      return direct
    }
    const rawInput = acpObject(tool.rawInput) ?? acpObject(tool.args) ?? {}
    const expectedType = typeof rawInput.TypeName === 'string' ? rawInput.TypeName : undefined
    const expectedRole = typeof rawInput.Role === 'string' ? rawInput.Role : undefined
    const subagentsDir = join(this.antigravityAppDataDir, 'brain', this.acp.sessionId, '.system_generated', 'subagents')
    try {
      const files = readdirSync(subagentsDir).filter(name => name.endsWith('.json'))
      const candidates: Array<{ id: string; spawnStepIndex: number; matchesType: boolean; matchesRole: boolean }> = []
      for (const file of files) {
        try {
          const parsed = JSON.parse(readFileSync(join(subagentsDir, file), 'utf8')) as Record<string, unknown>
          const id = typeof parsed.conversationId === 'string' ? parsed.conversationId : file.slice(0, -5)
          if (!id || this.claimedSubagentIds.has(id)) continue
          const desc = acpObject(parsed.subagentDescriptor)
          const matchesType = !expectedType || desc?.typeName === expectedType
          const matchesRole = !expectedRole || desc?.role === expectedRole
          if (!matchesType && !matchesRole) continue
          candidates.push({
            id,
            spawnStepIndex: typeof parsed.spawnStepIndex === 'number' ? parsed.spawnStepIndex : Number.MAX_SAFE_INTEGER,
            matchesType,
            matchesRole,
          })
        } catch { /* ignore individual malformed file */ }
      }
      candidates.sort((a, b) => {
        const scoreA = (a.matchesType ? 2 : 0) + (a.matchesRole ? 1 : 0)
        const scoreB = (b.matchesType ? 2 : 0) + (b.matchesRole ? 1 : 0)
        if (scoreB !== scoreA) return scoreB - scoreA
        return a.spawnStepIndex - b.spawnStepIndex
      })
      const winner = candidates[0]
      if (winner) {
        this.claimedSubagentIds.add(winner.id)
        return winner.id
      }
    } catch { /* subagents dir absent */ }
    return undefined
  }

  private projectTool(tool: Frame): ProjectedTool {
    const rawName = typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : undefined
    const rawInput = acpObject(tool.rawInput) ?? acpObject(tool.args) ?? {}
    const diff = extractDiffBlock(tool)
    const locationPath = extractLocationPath(tool)
    const toolCallId = typeof tool.toolCallId === 'string' ? tool.toolCallId : undefined
    const subagentId = parseSubagentToolCallPrefix(toolCallId)
    const explicitSubagentName = firstString(
      tool.subagentName,
      acpObject(tool._meta)?.subagentName,
    )
    const subagentName = explicitSubagentName ?? (subagentId ? this.resolveSubagentName(subagentId) : undefined)
    const title = typeof tool.title === 'string' && tool.title.trim() ? tool.title.trim() : undefined

    if (rawName === 'invoke_subagent') {
      const description = firstString(rawInput.Role, rawInput.TypeName, title) ?? 'Subagent'
      const prompt = typeof rawInput.Prompt === 'string' ? rawInput.Prompt : ''
      const subagentType = typeof rawInput.TypeName === 'string' ? rawInput.TypeName : undefined
      return {
        name: 'Agent',
        input: {
          ...rawInput,
          description,
          prompt,
          ...(subagentType ? { subagent_type: subagentType } : {}),
          antigravityToolName: 'invoke_subagent',
        },
        displayName: description,
        antigravityToolName: 'invoke_subagent',
        isSubagentInvoke: true,
        ...(subagentName ? { subagentName } : {}),
        ...(subagentId ? { subagentId } : {}),
      }
    }

    if (rawName === 'run_command') {
      const command = firstString(rawInput.CommandLine, rawInput.command, title) ?? ''
      const description = firstString(rawInput.toolSummary, rawInput.description)
      return {
        name: 'Bash',
        input: {
          ...rawInput,
          command,
          ...(description ? { description } : {}),
        },
        displayName: description ?? title,
        description,
        antigravityToolName: 'run_command',
        ...(subagentName ? { subagentName } : {}),
        ...(subagentId ? { subagentId } : {}),
      }
    }

    const isEditTool =
      rawName === 'edit_file' ||
      rawName === 'replace_file_content' ||
      rawName === 'multi_replace_file_content' ||
      (tool.kind === 'edit' && diff !== undefined && typeof diff.oldText === 'string')

    if (isEditTool) {
      const filePath = firstString(rawInput.Path, rawInput.TargetFile, rawInput.file_path, diff?.path, locationPath) ?? ''
      const oldString =
        typeof diff?.oldText === 'string' ? diff.oldText
          : typeof rawInput.Target === 'string' ? rawInput.Target
            : typeof rawInput.TargetContent === 'string' ? rawInput.TargetContent
              : joinReplacementChunks(rawInput.ReplacementChunks, 'TargetContent') ?? ''
      const newString =
        typeof diff?.newText === 'string' ? diff.newText
          : typeof rawInput.Replacement === 'string' ? rawInput.Replacement
            : typeof rawInput.ReplacementContent === 'string' ? rawInput.ReplacementContent
              : joinReplacementChunks(rawInput.ReplacementChunks, 'ReplacementContent') ?? ''
      return {
        name: 'Edit',
        input: {
          ...rawInput,
          file_path: filePath,
          old_string: oldString,
          new_string: newString,
        },
        displayName: title,
        antigravityToolName: rawName ?? 'edit_file',
        ...(subagentName ? { subagentName } : {}),
        ...(subagentId ? { subagentId } : {}),
      }
    }

    const isWriteTool =
      rawName === 'write_file' ||
      rawName === 'write_to_file' ||
      (tool.kind === 'edit' && diff !== undefined && typeof diff.newText === 'string')

    if (isWriteTool) {
      const filePath = firstString(rawInput.Path, rawInput.TargetFile, rawInput.file_path, diff?.path, locationPath) ?? ''
      const content =
        typeof rawInput.Content === 'string' ? rawInput.Content
          : typeof rawInput.CodeContent === 'string' ? rawInput.CodeContent
            : typeof diff?.newText === 'string' ? diff.newText : ''
      return {
        name: 'Write',
        input: {
          ...rawInput,
          file_path: filePath,
          content,
        },
        displayName: title,
        antigravityToolName: rawName ?? 'write_file',
        ...(subagentName ? { subagentName } : {}),
        ...(subagentId ? { subagentId } : {}),
      }
    }

    return {
      name: fallbackToolName(tool),
      input: rawInput,
      displayName: title,
      ...(rawName ? { antigravityToolName: rawName } : {}),
      ...(subagentName ? { subagentName } : {}),
      ...(subagentId ? { subagentId } : {}),
    }
  }

  private beginTurn(detached: boolean): Turn {
    const { promise, resolve } = Promise.withResolvers<void>()
    const turn: Turn = {
      entries: [], permissions: new Map(), nextIndex: 0, started: Date.now(), detached,
      nativeEnd: detached ? { result: {} } : undefined,
      replyOpen: false, finishing: false, cancelled: false, resolve,
    }
    this.turn = turn
    this.turnDone = promise
    if (detached) {
      this.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      this.stream({ type: 'message_start' })
    }
    return turn
  }

  private replyPermission(id: number | string, choice?: Option): boolean {
    return this.acp.reply(id, {
      outcome: choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' },
    })
  }

  private cancelPermissions(turn: Turn): void {
    for (const [requestId, pending] of turn.permissions) {
      if ('id' in pending) this.replyPermission(pending.id)
      this.emit({ type: 'control_cancel_request', request_id: requestId })
    }
    turn.permissions.clear()
  }

  private async run(turn: Turn, prompt: Frame[], user?: Frame): Promise<void> {
    let error: AntigravityError | undefined
    let result: Frame = {}
    try {
      if (user) await this.append([user])
      if (!turn.cancelled) {
        if (user) this.emit({ ...user, isReplay: true })
        this.listening = true
        result = await this.acp.prompt(prompt)
        if (result.stopReason === 'refusal') {
          error = new AntigravityError('ANTIGRAVITY_TURN_FAILED', 'Antigravity declined the request.')
        }
      }
    } catch (cause) {
      error = cause instanceof AntigravityError ? cause : new AntigravityError('ANTIGRAVITY_TURN_FAILED', 'Could not save the Antigravity conversation.')
    }
    clearTimeout(turn.cancelTimer)
    this.finishPromptQuestion(turn, result.stopReason === 'end_turn' && !turn.cancelled && !error)
    turn.nativeEnd = { result, error }
    this.maybeFinish(turn)
  }

  private finishPromptQuestion(turn: Turn, canAsk: boolean): void {
    const pending = turn.promptQuestion
    if (!pending) return
    turn.promptQuestion = undefined
    const { tool, question, options, echo, buffered } = pending
    const toolUseId = tool.toolCallId as string
    const ask = canAsk && tool.status === 'pending'
    // 只隐藏 AGY 自己生成、与结构化字段完全一致的编号列表，保留普通正文。
    if (buffered && (!ask || buffered !== echo)) this.chunk(turn, 'text', buffered)
    if (ask) {
      this.publishPermission(turn, tool, { promptToolUseId: toolUseId, question, options })
    } else if (!turn.cancelled) {
      this.toolCall(turn, tool)
    }
  }

  private awaitsBackgroundWork(turn: Turn): boolean {
    if (turn.cancelled || turn.nativeEnd?.error) return false
    if (turn.replyOpen || turn.permissions.size > 0) return true
    for (const tool of this.tools.values()) {
      if (tool?.status === 'in_progress' && acpObject(tool.rawInput)?.IsDaemon !== true) return true
    }
    return false
  }

  private maybeFinish(turn: Turn): void {
    if (!turn.nativeEnd || turn.finishing || this.awaitsBackgroundWork(turn)) return
    turn.finishing = true
    void this.finish(turn, turn.nativeEnd)
  }

  private async finish(turn: Turn, end: NonNullable<Turn['nativeEnd']>): Promise<void> {
    let error = end.error
    try {
      do {
        this.flushChunk(turn)
        if (turn.entries.length) await this.append(turn.entries.splice(0))
        // 通过同一双工管道，后台事件可能在上一次历史写入期间继续到达。
        if (this.awaitsBackgroundWork(turn)) {
          turn.finishing = false
          return
        }
      } while (turn.entries.length || turn.chunk)
    } catch {
      error = new AntigravityError('ANTIGRAVITY_TURN_FAILED', 'Could not save the Antigravity response.')
    }
    void this.computerUseBridge?.releaseLock()
    this.cancelPermissions(turn)
    this.turn = undefined
    const failed = !turn.cancelled && error
    if (failed) this.emit({ type: 'assistant', error: failed.code, isApiErrorMessage: true, message: { content: [{ type: 'text', text: failed.message }] } })
    const usage = acpObject(end.result.usage)
    const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0
    const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0
    const cacheReadTokens = typeof usage?.cachedReadTokens === 'number'
      ? usage.cachedReadTokens
      : typeof usage?.cacheReadTokens === 'number'
        ? usage.cacheReadTokens
        : 0
    const cacheCreationTokens = typeof usage?.cachedWriteTokens === 'number'
      ? usage.cachedWriteTokens
      : typeof usage?.cacheCreationTokens === 'number'
        ? usage.cacheCreationTokens
        : 0
    this.cumulativeUsage.inputTokens += inputTokens
    this.cumulativeUsage.outputTokens += outputTokens
    this.cumulativeUsage.cacheReadTokens += cacheReadTokens
    this.cumulativeUsage.cacheCreationTokens += cacheCreationTokens
    this.emit({
      type: 'result', subtype: failed ? 'error' : 'success', is_error: Boolean(failed),
      ...(failed ? { result: failed.message } : {}),
      duration_ms: Date.now() - turn.started,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(cacheCreationTokens > 0 ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
      },
    })
    if (turn.detached) this.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    turn.resolve()
  }

  private assistant(turn: Turn, content: Frame): void {
    const message = {
      type: 'assistant', uuid: crypto.randomUUID(),
      message: { role: 'assistant', model: this.acp.modelId ?? 'Antigravity', content: [content] },
    }
    turn.entries.push(message)
    this.emit(message)
  }

  private stream(event: Frame): void {
    this.emit({ type: 'stream_event', event })
  }

  private flushChunk(turn: Turn): void {
    const chunk = turn.chunk
    if (!chunk) return
    turn.chunk = undefined
    this.stream({ type: 'content_block_stop', index: chunk.index })
    this.assistant(turn, chunk.kind === 'text' ? { type: 'text', text: chunk.text } : { type: 'thinking', thinking: chunk.text })
  }

  private chunk(turn: Turn, kind: 'text' | 'thinking', text: string): void {
    if (!text) return
    if (turn.nativeEnd) turn.replyOpen = true
    if (turn.chunk?.kind !== kind) {
      this.flushChunk(turn)
      turn.chunk = { kind, text: '', index: turn.nextIndex++ }
      this.stream({ type: 'content_block_start', index: turn.chunk.index, content_block: { type: kind } })
    }
    turn.chunk.text += text
    this.stream({ type: 'content_block_delta', index: turn.chunk.index, delta: kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } })
  }

  private toolCall(turn: Turn, tool: Frame, overrideName?: string, overrideInput?: Frame): ProjectedTool {
    const projected = this.projectTool(tool)
    const id = tool.toolCallId
    if (typeof id !== 'string' || this.tools.has(id)) return projected
    this.flushChunk(turn)
    this.assistant(turn, {
      type: 'tool_use',
      id,
      name: overrideName ?? projected.name,
      input: overrideInput ?? projected.input,
    })
    this.projectToolState(turn, id, tool)
    return projected
  }

  private projectToolState(turn: Turn, id: string, tool: Frame): void {
    if (!toolHasFinished(tool)) {
      this.tools.set(id, tool)
      return
    }
    this.tools.set(id, null)
    this.flushChunk(turn)
    const answer = turn.promptAnswer?.toolUseId === id ? turn.promptAnswer : undefined
    if (answer) turn.promptAnswer = undefined
    let content: unknown
    if (answer && tool.status === 'completed') {
      content = { answers: { [answer.question]: answer.label } }
    } else if (tool.name === 'invoke_subagent') {
      const childId = this.resolveChildConversationIdForInvoke(tool)
      const body = toolContent(tool)
      content = childId
        ? (body && body !== 'Run invoke_subagent' ? `agentId: ${childId}\n${body}` : `agentId: ${childId}`)
        : body
    } else {
      content = toolContent(tool)
    }
    const message = {
      type: 'user', uuid: crypto.randomUUID(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: tool.status === 'failed' }] },
    }
    turn.entries.push(message)
    this.emit(message)
  }

  private receive(method: string, params: Frame, rpcId?: number | string): void {
    const sameSession = params.sessionId === this.acp.sessionId
    const matches = this.listening && sameSession
    if (method === 'session/request_permission' && rpcId !== undefined) {
      const tool = acpObject(params.toolCall)
      if (!matches || typeof tool?.toolCallId !== 'string') {
        this.replyPermission(rpcId)
        return
      }
      const turn = this.turn ?? this.beginTurn(true)
      this.requestPermission(turn, tool, params.options, rpcId)
      this.maybeFinish(turn)
      return
    }
    if (rpcId !== undefined) {
      this.acp.reply(rpcId, undefined, -32601)
      return
    }
    if (method !== 'session/update' || !sameSession) return
    const update = acpObject(params.update)
    if (!update) return

    // Control-plane updates (commands, mode/config updates) must be processed even before the first prompt turn.
    if (update.sessionUpdate === 'available_commands_update') {
      const commands = parseAvailableCommands(update.availableCommands)
      this.availableCommands = commands
      this.onAvailableCommands?.(commands)
      return
    }
    if (update.sessionUpdate === 'current_mode_update') {
      const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : undefined
      const mapped = acpModeToCcHahaPermissionMode(modeId)
      if (mapped && !this.acp.launchedWithBypassPermissions) {
        this.acp.permissionMode = mapped
        this.emit({ type: 'system', subtype: 'status', status: null, permissionMode: mapped })
      }
      return
    }
    if (update.sessionUpdate === 'config_option_update') {
      const modeOpt = configOption(update, 'mode')
      const mapped = acpModeToCcHahaPermissionMode(typeof modeOpt?.currentValue === 'string' ? modeOpt.currentValue : undefined)
      if (mapped && !this.acp.launchedWithBypassPermissions) {
        this.acp.permissionMode = mapped
        this.emit({ type: 'system', subtype: 'status', status: null, permissionMode: mapped })
      }
      return
    }

    if (!matches) return
    let turn = this.turn
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = textContent(update.content)
        if (!text) return
        turn ??= this.beginTurn(true)
        const question = turn.promptQuestion
        if (update.sessionUpdate === 'agent_message_chunk' && question?.tool.status === 'pending' && question.buffered !== question.echo) {
          const buffered = question.buffered + text
          if (question.echo.startsWith(buffered)) {
            question.buffered = buffered
            return
          }
          question.buffered = ''
          question.echo = ''
          this.chunk(turn, 'text', buffered)
        } else {
          this.chunk(turn, update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking', text)
        }
        break
      }
      case 'tool_call': {
        // interaction_* 等权限 RPC；终端式 ask_question 等 pending 与 end_turn。
        if (typeof update.toolCallId !== 'string' || update.toolCallId.startsWith('interaction_') || this.tools.has(update.toolCallId)) return
        turn ??= this.beginTurn(true)
        if (turn.promptQuestion?.tool.toolCallId === update.toolCallId) return
        const question = !turn.nativeEnd && !turn.promptQuestion && readPromptQuestion(update)
        if (question) {
          this.flushChunk(turn)
          turn.promptQuestion = question
        } else {
          this.toolCall(turn, update)
        }
        break
      }
      case 'tool_call_update': {
        const id = update.toolCallId
        if (typeof id !== 'string') return
        const question = turn?.promptQuestion
        if (turn && question?.tool.toolCallId === id) {
          question.tool = { ...question.tool, ...update }
          if (toolHasFinished(question.tool)) this.finishPromptQuestion(turn, false)
          break
        }
        const previous = this.tools.get(id)
        if (!previous) return
        turn ??= this.beginTurn(true)
        this.projectToolState(turn, id, { ...previous, ...update })
        break
      }
      case 'usage_update': {
        const used = typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : undefined
        const size = typeof update.size === 'number' && Number.isFinite(update.size) ? update.size : undefined
        if (used !== undefined || size !== undefined) {
          this.contextUsage = {
            used: used ?? this.contextUsage?.used ?? 0,
            size: size ?? this.contextUsage?.size ?? 200_000,
          }
        }
        // AGY 的脱离 prompt 回复以 usage_update 收尾。
        if (turn) turn.replyOpen = false
        break
      }
    }
    if (turn) this.maybeFinish(turn)
  }

  private requestPermission(turn: Turn, tool: Frame, rawOptions: unknown, rpcId: number | string): void {
    const options = Array.isArray(rawOptions) ? rawOptions.map(acpObject).flatMap((option): Option[] =>
      typeof option?.optionId === 'string' && typeof option.name === 'string' ? [{ optionId: option.optionId, name: option.name, kind: option.kind }] : []) : []
    const toolUseId = String(tool.toolCallId)
    const input = acpObject(tool.rawInput) ?? acpObject(tool.args) ?? {}
    const question = toolUseId.startsWith('interaction_')
      ? (typeof input.question === 'string' ? input.question : typeof tool.title === 'string' ? tool.title : undefined)
      : undefined
    if (toolUseId.startsWith('interaction_') && (!question || options.length === 0 || new Set(options.map(option => option.name)).size !== options.length)) {
      this.replyPermission(rpcId)
      return
    }

    // Auto-approve our own injected Computer Use MCP server when Computer Use is globally enabled in Settings.
    const rawToolName = typeof tool.name === 'string' ? tool.name : undefined
    if (!question && this.computerUseBridge?.isEnabled() && isAntigravityComputerUseToolName(rawToolName)) {
      const allowOption = options.find(option => option.kind === 'allow_once')
        ?? options.find(option => option.kind === 'allow_always')
      if (allowOption) {
        this.toolCall(turn, tool)
        this.replyPermission(rpcId, allowOption)
        return
      }
    }

    if (!question && !options.some(option => option.kind === 'allow_once' || option.kind === 'allow_always')) {
      this.replyPermission(rpcId, options.find(option => option.kind === 'reject_once'))
      return
    }
    if (question) {
      // 有原生选择 RPC 时，不再把同回合的终端式问题转成第二张卡。
      turn.promptQuestion = undefined
    }
    if (turn.nativeEnd) turn.replyOpen = true
    this.publishPermission(turn, tool, { id: rpcId, options, question })
  }

  private publishPermission(turn: Turn, tool: Frame, pending: PendingPermission): void {
    const projected = this.projectTool(tool)
    const name = pending.question ? 'AskUserQuestion' : projected.name
    const input = pending.question ? questionInput(pending.question, pending.options) : projected.input
    const supportsAllowAlways = !pending.question && pending.options.some(option => option.kind === 'allow_always')
    const requestId = crypto.randomUUID()
    this.toolCall(turn, tool, name, input)
    turn.permissions.set(requestId, pending)
    this.emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: name,
        tool_use_id: tool.toolCallId,
        input,
        ...(!pending.question && projected.description ? { description: projected.description } : {}),
        ...(!pending.question && projected.displayName ? { display_name: projected.displayName } : {}),
        ...(!pending.question && projected.antigravityToolName ? { antigravity_tool_name: projected.antigravityToolName } : {}),
        ...(projected.subagentName ? { subagent_name: projected.subagentName } : {}),
        ...(projected.subagentId ? { agent_id: projected.subagentId } : {}),
        ...(!pending.question ? { supports_allow_always: supportsAllowAlways } : {}),
      },
    })
  }
}
