import { acpObject, AntigravityError, type AntigravityAcp } from './antigravityAcp.js'

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

function textContent(value: unknown): string {
  const block = acpObject(value)
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

function toolName(tool: Frame): string {
  // ACP 标题是显示文本，不应触发同名的 Claude Code 特殊工具逻辑。
  return typeof tool.title === 'string' && tool.title.trim() ? `Antigravity: ${tool.title}` : 'Antigravity'
}

function toolContent(tool: Frame): string {
  const output = acpObject(tool.rawOutput)
  const commandOutput = output?.combinedOutput ?? output?.combined_output
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

/** 把外部 Agent 的回合及后续后台输出投影到实时消息与会话历史。 */
export class AntigravityConversation {
  private turn?: Turn
  private turnDone?: Promise<void>
  private listening = false
  // 原生工具的寿命可以超过一次 prompt；null 记住已转发的终态，防止重复输出结果。
  private tools = new Map<string, Frame | null>()

  constructor(
    readonly acp: AntigravityAcp,
    private readonly emit: (message: Frame) => void,
    private readonly append: (entries: Frame[]) => Promise<void>,
  ) {
    acp.onMessage = (method, params, id) => this.receive(method, params, id)
  }

  get isResponding(): boolean {
    return !!this.turn && !this.turn.cancelled
  }

  get pendingTurnCompletion(): Promise<void> | undefined {
    return this.turn ? this.turnDone : undefined
  }

  async waitForCancelledTurn(): Promise<void> {
    if (this.turn?.cancelled) await this.turnDone
  }

  async waitForExit(): Promise<void> {
    await this.acp.drained
    this.listening = false
    this.tools.clear()
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

  respond(requestId: string, allowed: boolean, updatedInput?: Frame): boolean {
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
    } else {
      choice = pending.options.find(option => option.kind === (allowed ? 'allow_once' : 'reject_once'))
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
    this.cancelPermissions(turn)
    this.turn = undefined
    const failed = !turn.cancelled && error
    if (failed) this.emit({ type: 'assistant', error: failed.code, isApiErrorMessage: true, message: { content: [{ type: 'text', text: failed.message }] } })
    const usage = acpObject(end.result.usage)
    this.emit({
      type: 'result', subtype: failed ? 'error' : 'success', is_error: Boolean(failed),
      ...(failed ? { result: failed.message } : {}),
      duration_ms: Date.now() - turn.started,
      usage: {
        input_tokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0,
        output_tokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0,
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

  private toolCall(turn: Turn, tool: Frame, name?: string, input?: Frame): void {
    const id = tool.toolCallId
    if (typeof id !== 'string' || this.tools.has(id)) return
    this.flushChunk(turn)
    this.assistant(turn, {
      type: 'tool_use', id, name: name ?? toolName(tool),
      input: input ?? acpObject(tool.rawInput) ?? {},
    })
    this.projectToolState(turn, id, tool)
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
    const content = answer && tool.status === 'completed' ? { answers: { [answer.question]: answer.label } } : toolContent(tool)
    const message = {
      type: 'user', uuid: crypto.randomUUID(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: tool.status === 'failed' }] },
    }
    turn.entries.push(message)
    this.emit(message)
  }

  private receive(method: string, params: Frame, rpcId?: number | string): void {
    const matches = this.listening && params.sessionId === this.acp.sessionId
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
    if (method !== 'session/update' || !matches) return
    const update = acpObject(params.update)
    if (!update) return
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
      case 'usage_update':
        // AGY 的脱离 prompt 回复以 usage_update 收尾。
        if (turn) turn.replyOpen = false
        break
    }
    if (turn) this.maybeFinish(turn)
  }

  private requestPermission(turn: Turn, tool: Frame, rawOptions: unknown, rpcId: number | string): void {
    const options = Array.isArray(rawOptions) ? rawOptions.map(acpObject).flatMap((option): Option[] =>
      typeof option?.optionId === 'string' && typeof option.name === 'string' ? [{ optionId: option.optionId, name: option.name, kind: option.kind }] : []) : []
    const toolUseId = String(tool.toolCallId)
    const input = acpObject(tool.rawInput) ?? {}
    const question = toolUseId.startsWith('interaction_')
      ? (typeof input.question === 'string' ? input.question : typeof tool.title === 'string' ? tool.title : undefined)
      : undefined
    if (toolUseId.startsWith('interaction_') && (!question || options.length === 0 || new Set(options.map(option => option.name)).size !== options.length)) {
      this.replyPermission(rpcId)
      return
    }
    if (!question && !options.some(option => option.kind === 'allow_once')) {
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
    const name = pending.question ? 'AskUserQuestion' : toolName(tool)
    const input = pending.question ? questionInput(pending.question, pending.options) : acpObject(tool.rawInput) ?? {}
    const requestId = crypto.randomUUID()
    this.toolCall(turn, tool, name, input)
    turn.permissions.set(requestId, pending)
    this.emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, tool_use_id: tool.toolCallId, input } })
  }
}
