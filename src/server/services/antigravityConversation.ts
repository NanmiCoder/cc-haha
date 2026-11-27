import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  ASK_USER_QUESTION_CLARIFY_MESSAGE,
  ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX,
} from '../../constants/messages.js'
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
  estimateAntigravityComputerUseTokens,
  isAntigravityComputerUseToolName,
  type AntigravityComputerUseBridge,
} from './antigravityComputerUseBridge.js'

const CANCEL_TIMEOUT_MS = 3_000
const TRANSCRIPT_BASELINE_SCAN_BYTES = 128 * 1024
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024
const TRANSCRIPT_TAIL_MAX_READ_BYTES = 4 * 1024 * 1024
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,256}$/
const ELICITATION_SELECT_KEY_RE = /^q([1-9]\d*)$/
const ELICITATION_OTHER_KEY_RE = /^q([1-9]\d*)_other$/
const ELICITATION_OTHER_DESC_PREFIX = 'Optional free-form answer to: '

type Frame = Record<string, unknown>
type Option = { optionId: string; name: string; kind?: unknown }
type ElicitationOption = { constValue: string; title: string }
type ElicitationQuestion = {
  index: number
  selectKey?: string
  otherKey?: string
  question: string
  multiSelect: boolean
  options: ElicitationOption[]
}
type ElicitationPending = {
  id: number | string
  kind: 'elicitation'
  toolUseId: string
  questions: ElicitationQuestion[]
  allowFreeText: boolean
  hasNativeToolCall: boolean
}
type PendingPermission =
  | ({ options: Option[]; toolUseId?: string } & (
      | { id: number | string; question?: string }
      | { promptToolUseId: string; question: string }
    ))
  | ElicitationPending
type PromptQuestion = {
  tool: Frame
  question: string
  options: Option[]
  echo: string
  buffered: string
}
type ResolvedQuestionResult = {
  questions: Frame[]
  answers?: Record<string, string>
  annotations?: Record<string, { notes: string }>
  handedOff?: boolean
  handoffMessage?: string
}

type AccumulatedUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function createEmptyUsage(): AccumulatedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

function readPromptUsage(rawUsage: unknown): AccumulatedUsage {
  const usage = acpObject(rawUsage)
  const inputTokens = typeof usage?.inputTokens === 'number' && Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
  const rawOutputTokens = typeof usage?.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0
  const thoughtTokens = typeof usage?.thoughtTokens === 'number' && Number.isFinite(usage.thoughtTokens) ? usage.thoughtTokens : 0
  const cacheReadTokens = typeof usage?.cachedReadTokens === 'number' && Number.isFinite(usage.cachedReadTokens)
    ? usage.cachedReadTokens
    : typeof usage?.cacheReadTokens === 'number' && Number.isFinite(usage.cacheReadTokens)
      ? usage.cacheReadTokens
      : 0
  const cacheCreationTokens = typeof usage?.cachedWriteTokens === 'number' && Number.isFinite(usage.cachedWriteTokens)
    ? usage.cachedWriteTokens
    : typeof usage?.cacheCreationTokens === 'number' && Number.isFinite(usage.cacheCreationTokens)
      ? usage.cacheCreationTokens
      : 0
  const totalTokens = typeof usage?.totalTokens === 'number' && Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined
  // Real `agy acp` reports `outputTokens` inclusive of `thoughtTokens` (matching SQLite
  // ModelUsageStats field 3 = thinking + response), with `totalTokens = input + cached + output`.
  // When `totalTokens` proves inclusive semantics, do not add `thoughtTokens` twice.
  const promptSum = inputTokens + cacheReadTokens + cacheCreationTokens
  const thoughtIncludedInOutput =
    thoughtTokens > 0 &&
    rawOutputTokens >= thoughtTokens &&
    totalTokens !== undefined &&
    totalTokens > 0 &&
    Math.abs(totalTokens - (promptSum + rawOutputTokens)) <
      Math.abs(totalTokens - (promptSum + rawOutputTokens + thoughtTokens))
  const outputTokens = thoughtIncludedInOutput ? rawOutputTokens : rawOutputTokens + thoughtTokens
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  }
}

function addAccumulatedUsage(target: AccumulatedUsage, delta: AccumulatedUsage): void {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheCreationTokens += delta.cacheCreationTokens
}

type Turn = {
  entries: Frame[]
  permissions: Map<string, PendingPermission>
  pendingAskTools: Map<string, Frame>
  resolvedQuestions: Map<string, ResolvedQuestionResult>
  promptQuestion?: PromptQuestion
  promptAnswer?: { toolUseId: string; question: string; label: string }
  chunk?: { kind: 'text' | 'thinking'; text: string; index: number }
  nextIndex: number
  started: number
  apiDurationMs: number
  decodeDurationMs: number
  ttftMs?: number
  modelPhaseStart?: number
  decodeStart?: number
  lastChunkAt?: number
  isCompact: boolean
  preCompactTokens: number
  compactCommandXml?: string
  userUuid?: string
  detached: boolean
  promptSeq: number
  accumulatedUsage: AccumulatedUsage
  liveTranscriptUsage: AccumulatedUsage
  transcriptByteOffset: number
  transcriptPendingLine: string
  transcriptDecoder: StringDecoder
  seenTranscriptSteps: Set<number>
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
  totalAPIDuration: number
  totalDecodeDuration: number
  totalTtftDuration: number
  totalDuration: number
}

type ContextCategory = {
  name: string
  tokens: number
  color: string
}

function parseManualCompactPrompt(userContent: Frame[]): { args: string } | null {
  if (userContent.length === 0) return null
  const textParts: string[] = []
  for (const block of userContent) {
    if (block.type !== 'text' || typeof block.text !== 'string') return null
    textParts.push(block.text)
  }
  const trimmed = textParts.join('\n').trim()
  if (!/^\/compact(?:\s|$)/i.test(trimmed)) return null
  return { args: trimmed.slice('/compact'.length).trim() }
}

function formatCompactLocalCommandXml(args: string): string {
  return args
    ? `<command-name>/compact</command-name><command-args>${args}</command-args>`
    : '<command-name>/compact</command-name>'
}

function countUserContentChars(userContent: Frame[]): number {
  let chars = 0
  for (const block of userContent) {
    if (block.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length
    }
  }
  return chars
}

function buildContextGridRows(
  categories: ContextCategory[],
  used: number,
  maxTokens: number,
  filledSquares: number,
): Array<Array<{
  color: string
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number
}>> {
  const filledCategories = categories.filter(cat => cat.name !== 'Free space' && cat.tokens > 0)
  const counts = new Array<number>(filledCategories.length).fill(0)
  if (filledSquares > 0 && used > 0 && filledCategories.length > 0) {
    const exact = filledCategories.map(cat => (cat.tokens / used) * filledSquares)
    let assigned = 0
    for (let i = 0; i < exact.length; i++) {
      counts[i] = Math.floor(exact[i]!)
      assigned += counts[i]!
    }
    let remainder = filledSquares - assigned
    const order = exact
      .map((val, idx) => ({ idx, frac: val - Math.floor(val) }))
      .sort((a, b) => b.frac - a.frac || a.idx - b.idx)
    for (let i = 0; i < order.length && remainder > 0; i++) {
      counts[order[i]!.idx]! += 1
      remainder -= 1
    }
  }

  const cells: Array<{ color: string; isFilled: boolean; categoryName: string }> = []
  for (let i = 0; i < filledCategories.length; i++) {
    const cat = filledCategories[i]!
    const count = counts[i]!
    for (let j = 0; j < count; j++) {
      cells.push({ color: cat.color, isFilled: true, categoryName: cat.name })
    }
  }
  while (cells.length < 100) {
    cells.push({ color: '#a1a1aa', isFilled: false, categoryName: 'Free space' })
  }

  const tokensPerSquare = Math.round(maxTokens / 100)
  return Array.from({ length: 10 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => {
      const cell = cells[row * 10 + col]!
      return {
        color: cell.color,
        isFilled: cell.isFilled,
        categoryName: cell.categoryName,
        tokens: tokensPerSquare,
        percentage: 1,
        squareFullness: cell.isFilled ? 1 : 0,
      }
    }),
  )
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

function parseElicitationOptions(raw: unknown): ElicitationOption[] {
  if (!Array.isArray(raw)) return []
  const options: ElicitationOption[] = []
  for (const item of raw) {
    const entry = acpObject(item)
    if (entry && typeof entry.const === 'string' && entry.const.length > 0 && typeof entry.title === 'string' && entry.title.trim()) {
      options.push({ constValue: entry.const, title: entry.title })
    }
  }
  return options
}

function parseStringEnumOptions(raw: unknown): ElicitationOption[] {
  if (!Array.isArray(raw)) return []
  const options: ElicitationOption[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      options.push({ constValue: item, title: item })
    }
  }
  return options
}

function parseElicitationForm(params: Frame): { questions: ElicitationQuestion[]; allowFreeText: boolean } | undefined {
  if (params.mode !== 'form') return undefined
  const schema = acpObject(params.requestedSchema)
  const properties = acpObject(schema?.properties)
  if (!properties) return undefined

  type DraftEntry = {
    selectKey?: string
    selectProp?: Frame
    otherKey?: string
    otherProp?: Frame
  }
  const byIndex = new Map<number, DraftEntry>()
  for (const [key, value] of Object.entries(properties)) {
    const prop = acpObject(value)
    if (!prop) return undefined
    const selectMatch = key.match(ELICITATION_SELECT_KEY_RE)
    if (selectMatch) {
      const index = Number(selectMatch[1])
      const draft = byIndex.get(index) ?? {}
      draft.selectKey = key
      draft.selectProp = prop
      byIndex.set(index, draft)
      continue
    }
    const otherMatch = key.match(ELICITATION_OTHER_KEY_RE)
    if (otherMatch) {
      const index = Number(otherMatch[1])
      const draft = byIndex.get(index) ?? {}
      draft.otherKey = key
      draft.otherProp = prop
      byIndex.set(index, draft)
      continue
    }
    // Unrecognized form field: let AGY fall back cleanly rather than misrendering an unknown form.
    return undefined
  }

  const sortedIndices = [...byIndex.keys()].sort((a, b) => a - b)
  if (sortedIndices.length === 0) return undefined

  const fallbackMessage = typeof params.message === 'string' ? params.message.trim() : ''
  const seenQuestions = new Set<string>()
  const questions: ElicitationQuestion[] = []

  for (const index of sortedIndices) {
    const entry = byIndex.get(index)!
    let multiSelect = false
    let options: ElicitationOption[] = []

    if (entry.selectProp) {
      if (entry.selectProp.type === 'array') {
        multiSelect = true
        const items = acpObject(entry.selectProp.items)
        options = parseElicitationOptions(items?.anyOf)
        if (options.length === 0) options = parseStringEnumOptions(items?.enum)
      } else if (entry.selectProp.type === 'string') {
        multiSelect = false
        options = parseElicitationOptions(entry.selectProp.oneOf)
        if (options.length === 0) options = parseStringEnumOptions(entry.selectProp.enum)
      } else {
        return undefined
      }
      if (options.length === 0) return undefined
    }

    if (entry.otherProp && entry.otherProp.type !== 'string') {
      return undefined
    }

    if (options.length === 0 && !entry.otherKey) {
      return undefined
    }

    const selectTitle = typeof entry.selectProp?.title === 'string' ? entry.selectProp.title.trim() : ''
    const selectDesc = typeof entry.selectProp?.description === 'string' ? entry.selectProp.description.trim() : ''
    const otherTitleRaw = typeof entry.otherProp?.title === 'string' ? entry.otherProp.title.trim() : ''
    const otherTitle = otherTitleRaw && otherTitleRaw.toLowerCase() !== 'other' ? otherTitleRaw : ''
    const otherDescRaw = typeof entry.otherProp?.description === 'string' ? entry.otherProp.description.trim() : ''
    const otherDesc = otherDescRaw.startsWith(ELICITATION_OTHER_DESC_PREFIX)
      ? otherDescRaw.slice(ELICITATION_OTHER_DESC_PREFIX.length).trim()
      : ''

    const baseQuestion =
      selectTitle ||
      otherTitle ||
      otherDesc ||
      selectDesc ||
      (sortedIndices.length === 1 && fallbackMessage ? fallbackMessage : '') ||
      `Question ${index}`
    const question = seenQuestions.has(baseQuestion) ? `${baseQuestion} (${index})` : baseQuestion
    seenQuestions.add(question)

    questions.push({
      index,
      ...(entry.selectKey ? { selectKey: entry.selectKey } : {}),
      ...(entry.otherKey ? { otherKey: entry.otherKey } : {}),
      question,
      multiSelect,
      options,
    })
  }

  return {
    questions,
    allowFreeText: questions.some(q => Boolean(q.otherKey)),
  }
}

function buildElicitationQuestionInput(questions: ElicitationQuestion[], allowFreeText: boolean): Frame {
  return {
    allowFreeText,
    allowImages: false,
    questions: questions.map((q, idx) => ({
      question: q.question,
      header: questions.length > 1 ? `Q${idx + 1}` : 'Antigravity',
      multiSelect: q.multiSelect,
      ...(q.options.length > 0 ? { options: q.options.map(option => ({ label: option.title })) } : {}),
    })),
  }
}

function matchMultiSelectOptions(answer: string, options: ElicitationOption[]): string[] | null {
  if (!answer || options.length === 0) return null
  const exact = options.find(option => option.title === answer)
  if (exact) return [exact.constValue]

  const byLongestTitle = [...options].sort((a, b) => b.title.length - a.title.length)
  const matched: string[] = []
  let remaining = answer
  while (remaining.length > 0) {
    const hit = byLongestTitle.find(
      option => remaining === option.title || remaining.startsWith(`${option.title}, `),
    )
    if (!hit) return null
    if (!matched.includes(hit.constValue)) {
      matched.push(hit.constValue)
    }
    remaining = remaining.length === hit.title.length ? '' : remaining.slice(hit.title.length + 2)
  }
  return matched.length > 0 ? matched : null
}

function buildElicitationResponse(
  pending: ElicitationPending,
  updatedInput?: Frame,
): {
  content: Record<string, string | string[]>
  answers: Record<string, string>
  annotations: Record<string, { notes: string }>
} | null {
  const rawAnswers = acpObject(updatedInput?.answers) ?? {}
  const rawAnnotations = acpObject(updatedInput?.annotations) ?? {}
  const content: Record<string, string | string[]> = {}
  const answers: Record<string, string> = {}
  const annotations: Record<string, { notes: string }> = {}

  for (const q of pending.questions) {
    const rawAnswer = typeof rawAnswers[q.question] === 'string' ? (rawAnswers[q.question] as string).trim() : ''
    const noteEntry = acpObject(rawAnnotations[q.question])
    const rawNotes = typeof noteEntry?.notes === 'string' ? noteEntry.notes.trim() : ''

    if (q.options.length === 0) {
      const writeIn = rawAnswer || rawNotes
      if (writeIn) {
        if (!q.otherKey) return null
        content[q.otherKey] = writeIn
        answers[q.question] = rawAnswer || rawNotes
      }
      continue
    }

    if (q.multiSelect) {
      const selectedIds = rawAnswer ? matchMultiSelectOptions(rawAnswer, q.options) : null
      if (selectedIds && q.selectKey) {
        content[q.selectKey] = selectedIds
        answers[q.question] = rawAnswer
        if (rawNotes) {
          if (q.otherKey) content[q.otherKey] = rawNotes
          annotations[q.question] = { notes: rawNotes }
        }
      } else if (rawAnswer) {
        if (!q.otherKey) return null
        content[q.otherKey] = rawNotes ? `${rawAnswer}\n${rawNotes}` : rawAnswer
        answers[q.question] = rawAnswer
        if (rawNotes) annotations[q.question] = { notes: rawNotes }
      } else if (rawNotes) {
        if (!q.otherKey) return null
        content[q.otherKey] = rawNotes
        answers[q.question] = rawNotes
      }
    } else {
      const exact = rawAnswer ? q.options.find(option => option.title === rawAnswer) : undefined
      if (exact && q.selectKey) {
        content[q.selectKey] = exact.constValue
        answers[q.question] = rawAnswer
        if (rawNotes) {
          if (q.otherKey) content[q.otherKey] = rawNotes
          annotations[q.question] = { notes: rawNotes }
        }
      } else if (rawAnswer) {
        if (!q.otherKey) return null
        content[q.otherKey] = rawNotes ? `${rawAnswer}\n${rawNotes}` : rawAnswer
        answers[q.question] = rawAnswer
        if (rawNotes) annotations[q.question] = { notes: rawNotes }
      } else if (rawNotes) {
        if (!q.otherKey) return null
        content[q.otherKey] = rawNotes
        answers[q.question] = rawNotes
      }
    }
  }

  if (Object.keys(content).length === 0) return null
  return { content, answers, annotations }
}

function resolveDefaultAppDataDir(): string {
  // Never inherit host Antigravity App/IDE's `ANTIGRAVITY_APP_DATA_DIR`:
  // `agy acp` runs with stripped env and always persists to `~/.gemini/antigravity-cli`.
  const configured = process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR?.trim()
  if (configured) return configured
  return join(homedir(), '.gemini', 'antigravity-cli')
}

/** 把外部 Agent 的回合及后续后台输出投影到实时消息与会话历史。 */
export class AntigravityConversation {
  private turn?: Turn
  private turnDone?: Promise<void>
  private appendChain: Promise<void> = Promise.resolve()
  private listening = false
  // 原生工具的寿命可以超过一次 prompt；null 记住已转发的终态，防止重复输出结果。
  private tools = new Map<string, Frame | null>()
  private toolStartedAt = new Map<string, number>()
  private availableCommands: AntigravitySlashCommand[] = []
  private contextUsage?: ContextUsageState
  private firstTurnBaselineTokens?: number
  private firstTurnUserChars?: number
  private baselineDiskChecked = false
  private cumulativeUsage: CumulativeUsageState = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalAPIDuration: 0,
    totalDecodeDuration: 0,
    totalTtftDuration: 0,
    totalDuration: 0,
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

  private resolveAntigravityTranscriptPath(): string | undefined {
    const nativeSessionId = this.acp.sessionId
    if (!nativeSessionId || !SAFE_SESSION_ID_RE.test(nativeSessionId)) return undefined
    return join(
      this.antigravityAppDataDir,
      'brain',
      nativeSessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    )
  }

  private getCurrentTranscriptByteSize(): number {
    const transcriptPath = this.resolveAntigravityTranscriptPath()
    if (!transcriptPath) return 0
    try {
      const size = statSync(transcriptPath).size
      return Number.isFinite(size) && size > 0 ? size : 0
    } catch {
      return 0
    }
  }

  private processLiveTranscriptLine(turn: Turn, rawLine: string): void {
    const line = rawLine.trim()
    if (!line) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const step = acpObject(parsed)
    if (!step) return
    const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : ''
    if (stepType !== 'PLANNER_RESPONSE') return
    const status = typeof step.status === 'string' ? step.status.toUpperCase() : ''
    if (status && status !== 'DONE' && status !== 'COMPLETED' && status !== 'SUCCESS') return
    const stepIndex = typeof step.step_index === 'number' && Number.isFinite(step.step_index)
      ? step.step_index
      : undefined
    if (stepIndex !== undefined) {
      if (turn.seenTranscriptSteps.has(stepIndex)) return
      turn.seenTranscriptSteps.add(stepIndex)
    }
    const stepIn = typeof step.input_tokens === 'number' && Number.isFinite(step.input_tokens) && step.input_tokens > 0
      ? step.input_tokens
      : 0
    const stepOut = typeof step.output_tokens === 'number' && Number.isFinite(step.output_tokens) && step.output_tokens > 0
      ? step.output_tokens
      : 0
    const stepCache = typeof step.cache_read_tokens === 'number' && Number.isFinite(step.cache_read_tokens) && step.cache_read_tokens > 0
      ? step.cache_read_tokens
      : 0
    const stepCacheWrite = typeof step.cache_creation_tokens === 'number' && Number.isFinite(step.cache_creation_tokens) && step.cache_creation_tokens > 0
      ? step.cache_creation_tokens
      : 0
    if (stepIn === 0 && stepOut === 0 && stepCache === 0 && stepCacheWrite === 0) return
    turn.liveTranscriptUsage.inputTokens += stepIn
    turn.liveTranscriptUsage.outputTokens += stepOut
    turn.liveTranscriptUsage.cacheReadTokens += stepCache
    turn.liveTranscriptUsage.cacheCreationTokens += stepCacheWrite
  }

  /**
   * Read-only incremental byte-offset tailer over Antigravity's live `transcript.jsonl`.
   * Each completed internal LLM step (`PLANNER_RESPONSE`) is flushed to disk immediately
   * by `agy`, allowing mid-turn usage & tok/s snapshots before `session/prompt` resolves.
   */
  private pollLiveTurnTranscriptUsage(turn: Turn): void {
    const transcriptPath = this.resolveAntigravityTranscriptPath()
    if (!transcriptPath) return
    let size: number
    try {
      size = statSync(transcriptPath).size
    } catch {
      return
    }
    if (!Number.isFinite(size) || size <= 0) return
    if (size < turn.transcriptByteOffset) {
      turn.transcriptByteOffset = 0
      turn.transcriptPendingLine = ''
      turn.transcriptDecoder = new StringDecoder('utf8')
      turn.seenTranscriptSteps.clear()
      turn.liveTranscriptUsage = createEmptyUsage()
    }
    if (size === turn.transcriptByteOffset) return
    let fd: number | undefined
    try {
      fd = openSync(transcriptPath, 'r')
      let position = turn.transcriptByteOffset
      const readLimit = Math.min(size, position + TRANSCRIPT_TAIL_MAX_READ_BYTES)
      const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, readLimit - position))
      while (position < readLimit) {
        const toRead = Math.min(buffer.length, readLimit - position)
        const bytesRead = readSync(fd, buffer, 0, toRead, position)
        if (bytesRead <= 0) break
        position += bytesRead
        turn.transcriptByteOffset = position
        let chunk = turn.transcriptDecoder.write(buffer.subarray(0, bytesRead))
        while (chunk.length > 0) {
          const newlineIndex = chunk.indexOf('\n')
          if (newlineIndex < 0) {
            turn.transcriptPendingLine += chunk
            break
          }
          const line = turn.transcriptPendingLine + chunk.slice(0, newlineIndex)
          turn.transcriptPendingLine = ''
          this.processLiveTranscriptLine(turn, line)
          chunk = chunk.slice(newlineIndex + 1)
        }
      }
    } catch {
      // Best-effort read-only poll; ignore transient filesystem errors.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch { /* ignore */ }
      }
    }
  }

  private resolveLiveUsageTotals(): CumulativeUsageState {
    const turn = this.turn
    if (!turn || turn.finishing) {
      return this.cumulativeUsage
    }
    this.pollLiveTurnTranscriptUsage(turn)
    // `liveTranscriptUsage` accumulates every completed step since `beginTurn()`,
    // while `accumulatedUsage` holds settled usage from any steered prompt in the
    // same turn; taking the per-bucket max avoids double-counting after a steer.
    const inFlightInput = Math.max(turn.accumulatedUsage.inputTokens, turn.liveTranscriptUsage.inputTokens)
    const inFlightOutput = Math.max(turn.accumulatedUsage.outputTokens, turn.liveTranscriptUsage.outputTokens)
    const inFlightCacheRead = Math.max(turn.accumulatedUsage.cacheReadTokens, turn.liveTranscriptUsage.cacheReadTokens)
    const inFlightCacheCreation = Math.max(turn.accumulatedUsage.cacheCreationTokens, turn.liveTranscriptUsage.cacheCreationTokens)
    // Pair completed-step output tokens with completed model-phase API time so an
    // active prefill/thinking phase whose tokens have not landed yet never dilutes tok/s.
    // Fall back to elapsed modelPhaseStart only if step 1 flushed to disk just before
    // the corresponding tool_call paused the phase.
    const inFlightApiDuration = inFlightOutput > 0
      ? (turn.apiDurationMs > 0
        ? turn.apiDurationMs
        : turn.modelPhaseStart !== undefined
          ? Math.max(0, Date.now() - turn.modelPhaseStart)
          : 0)
      : 0
    return {
      inputTokens: this.cumulativeUsage.inputTokens + inFlightInput,
      outputTokens: this.cumulativeUsage.outputTokens + inFlightOutput,
      cacheReadTokens: this.cumulativeUsage.cacheReadTokens + inFlightCacheRead,
      cacheCreationTokens: this.cumulativeUsage.cacheCreationTokens + inFlightCacheCreation,
      totalAPIDuration: this.cumulativeUsage.totalAPIDuration + inFlightApiDuration,
      totalDecodeDuration: this.cumulativeUsage.totalDecodeDuration + (inFlightOutput > 0 ? turn.decodeDurationMs : 0),
      totalTtftDuration: this.cumulativeUsage.totalTtftDuration + (inFlightOutput > 0 ? (turn.ttftMs ?? 0) : 0),
      totalDuration: this.cumulativeUsage.totalDuration + Math.max(0, Date.now() - turn.started),
    }
  }

  private readBaselineFromAntigravityTranscript(): number | undefined {
    const transcriptPath = this.resolveAntigravityTranscriptPath()
    if (!transcriptPath) return undefined
    let fd: number | undefined
    try {
      fd = openSync(transcriptPath, 'r')
      const buffer = Buffer.alloc(TRANSCRIPT_BASELINE_SCAN_BYTES)
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
      if (bytesRead <= 0) return undefined
      let chunk = buffer.subarray(0, bytesRead).toString('utf8')
      if (bytesRead === buffer.length) {
        const lastNewline = chunk.lastIndexOf('\n')
        if (lastNewline >= 0) chunk = chunk.slice(0, lastNewline)
      }
      let firstUserChars: number | undefined
      for (const rawLine of chunk.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const step = acpObject(parsed)
        if (!step) continue
        const stepType = typeof step.type === 'string' ? step.type.toUpperCase() : ''
        const stepSource = typeof step.source === 'string' ? step.source.toUpperCase() : ''
        if (firstUserChars === undefined && (stepType === 'USER_INPUT' || stepSource === 'USER_EXPLICIT')) {
          firstUserChars = typeof step.content === 'string' ? step.content.length : 0
          continue
        }
        if (stepType === 'PLANNER_RESPONSE') {
          const stepIn = typeof step.input_tokens === 'number' && Number.isFinite(step.input_tokens) ? step.input_tokens : 0
          const stepCache = typeof step.cache_read_tokens === 'number' && Number.isFinite(step.cache_read_tokens) ? step.cache_read_tokens : 0
          const observedPromptTokens = stepIn + stepCache
          if (observedPromptTokens > 0) {
            const estimatedUserTokens = Math.ceil((firstUserChars ?? 0) / 3.5)
            return Math.max(0, observedPromptTokens - estimatedUserTokens)
          }
        }
      }
      return undefined
    } catch {
      return undefined
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch { /* ignore */ }
      }
    }
  }

  private ensureFirstTurnBaselineFromDisk(): void {
    if (this.firstTurnBaselineTokens !== undefined || this.baselineDiskChecked) return
    this.baselineDiskChecked = true
    const fromDisk = this.readBaselineFromAntigravityTranscript()
    if (fromDisk !== undefined) {
      this.firstTurnBaselineTokens = fromDisk
    }
  }

  private captureFirstTurnBaseline(observedPromptTokens: number): void {
    if (this.firstTurnBaselineTokens !== undefined || observedPromptTokens <= 0) return
    this.ensureFirstTurnBaselineFromDisk()
    if (this.firstTurnBaselineTokens !== undefined) return
    const estimatedUserTokens = Math.ceil((this.firstTurnUserChars ?? 0) / 3.5)
    this.firstTurnBaselineTokens = Math.max(0, observedPromptTokens - estimatedUserTokens)
  }

  getContextUsageSnapshot(): Record<string, unknown> {
    this.ensureFirstTurnBaselineFromDisk()
    const used = this.contextUsage?.used ?? 0
    const maxTokens = this.contextUsage?.size && this.contextUsage.size > 0 ? this.contextUsage.size : 200_000
    const percentage = maxTokens > 0 ? Math.min(100, Math.round((used / maxTokens) * 100)) : 0
    const freeTokens = Math.max(0, maxTokens - used)
    const filledSquares = Math.min(100, Math.max(0, percentage))

    let categories: ContextCategory[]
    let estimateOnly = false
    if (used > 0 && this.firstTurnBaselineTokens !== undefined && this.firstTurnBaselineTokens > 0) {
      const baseline = Math.min(used, this.firstTurnBaselineTokens)
      const messageTokens = Math.max(0, used - baseline)
      categories = []
      if (this.computerUseBridge?.isEnabled()) {
        const cuTokens = Math.min(baseline, estimateAntigravityComputerUseTokens(this.computerUseBridge))
        const systemAndToolsTokens = baseline - cuTokens
        if (systemAndToolsTokens > 0) {
          categories.push({ name: 'System & tools', tokens: systemAndToolsTokens, color: '#6366f1' })
        }
        if (cuTokens > 0) {
          categories.push({ name: 'MCP tools (Computer Use)', tokens: cuTokens, color: '#0ea5e9' })
        }
      } else {
        categories.push({ name: 'System & tools', tokens: baseline, color: '#6366f1' })
      }
      if (messageTokens > 0) {
        categories.push({ name: 'Messages', tokens: messageTokens, color: '#7c3aed' })
      }
      categories.push({ name: 'Free space', tokens: freeTokens, color: '#a1a1aa' })
      estimateOnly = true
    } else {
      categories = [
        { name: 'Messages', tokens: used, color: '#7c3aed' },
        { name: 'Free space', tokens: freeTokens, color: '#a1a1aa' },
      ]
    }

    const liveUsage = this.resolveLiveUsageTotals()
    return {
      categories,
      totalTokens: used,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage,
      gridRows: buildContextGridRows(categories, used, maxTokens, filledSquares),
      model: this.acp.modelId ?? 'Antigravity',
      estimateOnly,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: {
        input_tokens: liveUsage.inputTokens,
        output_tokens: liveUsage.outputTokens,
        cache_creation_input_tokens: liveUsage.cacheCreationTokens,
        cache_read_input_tokens: liveUsage.cacheReadTokens,
      },
    }
  }

  getSessionUsageSnapshot(): Record<string, unknown> {
    const model = this.acp.modelId ?? 'Antigravity'
    const totals = this.resolveLiveUsageTotals()
    return {
      totalCostUSD: 0,
      costDisplay: '$0.00',
      hasUnknownModelCost: true,
      totalAPIDuration: totals.totalAPIDuration,
      totalDecodeDuration: totals.totalDecodeDuration,
      totalTtftDuration: totals.totalTtftDuration,
      totalDuration: totals.totalDuration,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalInputTokens: totals.inputTokens,
      totalOutputTokens: totals.outputTokens,
      totalCacheReadInputTokens: totals.cacheReadTokens,
      totalCacheCreationInputTokens: totals.cacheCreationTokens,
      totalWebSearchRequests: 0,
      models: [{
        model,
        displayName: model,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadInputTokens: totals.cacheReadTokens,
        cacheCreationInputTokens: totals.cacheCreationTokens,
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
    this.toolStartedAt.clear()
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

  private buildPromptBlocks(userContent: Frame[]): Frame[] {
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
    return prompt
  }

  private canSteerTurn(turn: Turn, userContent: Frame[]): boolean {
    if (!this.acp.isOpen || turn.cancelled || turn.finishing) return false
    if (turn.isCompact || parseManualCompactPrompt(userContent)) return false
    if (turn.permissions.size > 0 || turn.promptQuestion || turn.pendingAskTools.size > 0) return false
    return true
  }

  send(userContent: Frame[], uuid: string): boolean {
    if (this.turn || !this.acp.isOpen) return false
    const prompt = this.buildPromptBlocks(userContent)
    this.computerUseBridge?.resetTurnAbort()
    for (const [id, tool] of this.tools) {
      if (!tool) {
        this.tools.delete(id)
        this.toolStartedAt.delete(id)
      }
    }
    const compactCommand = parseManualCompactPrompt(userContent)
    const preCompactTokens = compactCommand ? (this.contextUsage?.used ?? 0) : 0
    if (!compactCommand && this.firstTurnBaselineTokens === undefined && this.firstTurnUserChars === undefined) {
      this.firstTurnUserChars = countUserContentChars(userContent)
    }
    const turn = this.beginTurn(false)
    if (compactCommand) {
      turn.isCompact = true
      turn.preCompactTokens = preCompactTokens
      turn.compactCommandXml = formatCompactLocalCommandXml(compactCommand.args)
      turn.userUuid = uuid
    }
    const seq = ++turn.promptSeq
    void this.run(
      turn,
      seq,
      prompt,
      compactCommand
        ? undefined
        : { type: 'user', uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: userContent } },
    )
    return true
  }

  steer(userContent: Frame[], uuid: string): boolean {
    const turn = this.turn
    if (!turn) return false
    const prompt = this.buildPromptBlocks(userContent)
    if (!this.canSteerTurn(turn, userContent)) return false
    this.flushChunk(turn)
    const user: Frame = {
      type: 'user',
      uuid,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: userContent },
    }
    const entriesToPersist = [...turn.entries.splice(0), user]
    // Taking ownership with a newer promptSeq prevents the superseded prompt RPC
    // (which agy acp immediately resolves with stopReason: 'end_turn') from
    // prematurely settling this turn.
    turn.nativeEnd = undefined
    turn.replyOpen = false
    const seq = ++turn.promptSeq
    void this.run(turn, seq, prompt, user, entriesToPersist)
    return true
  }

  cancel(): boolean {
    const turn = this.turn
    if (turn?.cancelled) return true
    this.listening = false
    this.tools.clear()
    this.toolStartedAt.clear()
    this.computerUseBridge?.abortCurrentTurn()
    const sent = this.acp.cancel()
    if (!turn) return sent
    this.pauseModelPhase(turn)
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

  respond(requestId: string, allowed: boolean, updatedInput?: Frame, rule?: string, denyMessage?: string): boolean {
    const turn = this.turn
    const pending = turn?.permissions.get(requestId)
    if (!turn || turn.cancelled || !pending) return false
    if ('kind' in pending && pending.kind === 'elicitation') {
      const questionPayload = buildElicitationQuestionInput(pending.questions, pending.allowFreeText)
      const projectedQuestions = questionPayload.questions as Frame[]
      if (allowed) {
        const built = buildElicitationResponse(pending, updatedInput)
        if (!built) return false
        if (!this.acp.reply(pending.id, { action: 'accept', content: built.content })) return false
        turn.resolvedQuestions.set(pending.toolUseId, {
          questions: projectedQuestions,
          answers: built.answers,
          ...(Object.keys(built.annotations).length > 0 ? { annotations: built.annotations } : {}),
        })
      } else {
        const feedback = denyMessage?.trim()
        const firstOtherKey = pending.questions.find(q => q.otherKey)?.otherKey
        if (feedback && firstOtherKey) {
          const clarifyMessage = `${ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX}${feedback}`
          if (!this.acp.reply(pending.id, { action: 'accept', content: { [firstOtherKey]: clarifyMessage } })) return false
          turn.resolvedQuestions.set(pending.toolUseId, {
            questions: projectedQuestions,
            handedOff: true,
            handoffMessage: clarifyMessage,
          })
        } else {
          if (!this.acp.reply(pending.id, { action: 'decline' })) return false
          if (denyMessage !== undefined) {
            turn.resolvedQuestions.set(pending.toolUseId, {
              questions: projectedQuestions,
              handedOff: true,
              handoffMessage: ASK_USER_QUESTION_CLARIFY_MESSAGE,
            })
          }
        }
      }
      turn.permissions.delete(requestId)
      if (!pending.hasNativeToolCall) {
        this.projectToolState(turn, pending.toolUseId, {
          toolCallId: pending.toolUseId,
          status: allowed || Boolean(denyMessage?.trim()) ? 'completed' : 'failed',
        })
      }
      this.maybeResumeModelPhase(turn)
      this.maybeFinish(turn)
      return true
    }
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
      void this.run(turn, ++turn.promptSeq, [{ type: 'text', text: choice.optionId }])
      return true
    }
    if (!this.replyPermission(pending.id, choice)) return false
    if (allowed && pending.toolUseId) {
      this.toolStartedAt.set(pending.toolUseId, Date.now())
    }
    turn.permissions.delete(requestId)
    this.maybeResumeModelPhase(turn)
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

  private extractConversationIdFromText(text: string): string | undefined {
    if (!text) return undefined
    const jsonMatch = text.match(/"(?:conversationId|conversation_id|agentId|agent_id)"\s*:\s*"([A-Za-z0-9_-]{8,128})"/)
    if (jsonMatch?.[1]) return jsonMatch[1]
    const lineMatch = text.match(/(?:^|\n)\s*(?:conversationId|conversation_id|agentId|agent_id)\s*[:=]\s*([A-Za-z0-9_-]{8,128})\b/)
    if (lineMatch?.[1]) return lineMatch[1]
    return undefined
  }

  private resolveChildConversationIdForInvoke(tool: Frame): string | undefined {
    const rawOutput = acpObject(tool.rawOutput)
    const direct = firstString(rawOutput?.conversationId, rawOutput?.conversation_id, rawOutput?.agentId, rawOutput?.agent_id)
    if (direct) {
      this.claimedSubagentIds.add(direct)
      return direct
    }
    const contentText = toolContent(tool)
    const fromContent = this.extractConversationIdFromText(contentText)
    if (fromContent) {
      this.claimedSubagentIds.add(fromContent)
      return fromContent
    }
    if (Array.isArray(tool.content)) {
      for (const item of tool.content) {
        const record = acpObject(item)
        const nested = acpObject(record?.content)
        const candidateId = firstString(
          record?.conversationId,
          record?.conversation_id,
          record?.agentId,
          record?.agent_id,
          nested?.conversationId,
          nested?.conversation_id,
        ) ?? (typeof nested?.text === 'string' ? this.extractConversationIdFromText(nested.text) : undefined)
        if (candidateId) {
          this.claimedSubagentIds.add(candidateId)
          return candidateId
        }
      }
    }
    const rawInput = acpObject(tool.rawInput) ?? acpObject(tool.args) ?? {}
    const expectedType = typeof rawInput.TypeName === 'string' && rawInput.TypeName.trim()
      ? rawInput.TypeName.trim()
      : undefined
    const expectedRole = typeof rawInput.Role === 'string' && rawInput.Role.trim()
      ? rawInput.Role.trim()
      : undefined
    const subagentsDir = join(this.antigravityAppDataDir, 'brain', this.acp.sessionId, '.system_generated', 'subagents')
    try {
      const files = readdirSync(subagentsDir).filter(name => name.endsWith('.json'))
      const candidates: Array<{ id: string; spawnStepIndex: number }> = []
      for (const file of files) {
        try {
          const parsed = JSON.parse(readFileSync(join(subagentsDir, file), 'utf8')) as Record<string, unknown>
          const id = typeof parsed.conversationId === 'string' ? parsed.conversationId : file.slice(0, -5)
          if (!id || this.claimedSubagentIds.has(id)) continue
          const desc = acpObject(parsed.subagentDescriptor)
          const descType = typeof desc?.typeName === 'string' ? desc.typeName : undefined
          const descRole = typeof desc?.role === 'string' ? desc.role : undefined
          // Exclude Swarm workers from invoke_subagent resolution.
          if (descType === 'worker' && descRole?.startsWith('Swarm Worker')) continue
          if (expectedType && descType !== expectedType) continue
          if (expectedRole && descRole !== expectedRole) continue
          candidates.push({
            id,
            spawnStepIndex: typeof parsed.spawnStepIndex === 'number' ? parsed.spawnStepIndex : Number.MAX_SAFE_INTEGER,
          })
        } catch { /* ignore individual malformed file */ }
      }
      candidates.sort((a, b) => a.spawnStepIndex - b.spawnStepIndex || a.id.localeCompare(b.id))
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

    if (rawName === 'read_file' || rawName === 'view_file') {
      const filePath = firstString(rawInput.Path, rawInput.AbsolutePath, rawInput.file_path, locationPath) ?? ''
      return {
        name: 'Read',
        input: {
          ...rawInput,
          ...(filePath ? { file_path: filePath } : {}),
        },
        displayName: title,
        antigravityToolName: rawName,
        ...(subagentName ? { subagentName } : {}),
        ...(subagentId ? { subagentId } : {}),
      }
    }

    if (rawName === 'list_dir' || rawName === 'find_by_name') {
      const targetPath = firstString(rawInput.DirectoryPath, rawInput.SearchDirectory, rawInput.path, locationPath) ?? ''
      const pattern = firstString(rawInput.Pattern, rawInput.pattern) ?? '*'
      return {
        name: 'Glob',
        input: {
          ...rawInput,
          pattern,
          ...(targetPath ? { path: targetPath } : {}),
        },
        displayName: title,
        antigravityToolName: rawName,
        ...(subagentName ? { subagentName } : {}),
        ...(subagentId ? { subagentId } : {}),
      }
    }

    if (rawName === 'grep_search') {
      const targetPath = firstString(rawInput.SearchPath, rawInput.path, locationPath) ?? ''
      const pattern = firstString(rawInput.Query, rawInput.pattern) ?? ''
      return {
        name: 'Grep',
        input: {
          ...rawInput,
          ...(pattern ? { pattern } : {}),
          ...(targetPath ? { path: targetPath } : {}),
        },
        displayName: title,
        antigravityToolName: rawName,
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
      entries: [], permissions: new Map(), pendingAskTools: new Map(), resolvedQuestions: new Map(),
      nextIndex: 0, started: Date.now(),
      apiDurationMs: 0, decodeDurationMs: 0, isCompact: false, preCompactTokens: 0,
      detached,
      promptSeq: 0,
      accumulatedUsage: createEmptyUsage(),
      liveTranscriptUsage: createEmptyUsage(),
      transcriptByteOffset: this.getCurrentTranscriptByteSize(),
      transcriptPendingLine: '',
      transcriptDecoder: new StringDecoder('utf8'),
      seenTranscriptSteps: new Set(),
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

  private hasActiveNonDaemonWork(turn: Turn): boolean {
    if (turn.permissions.size > 0) return true
    for (const tool of this.tools.values()) {
      if (tool && !toolHasFinished(tool) && acpObject(tool.rawInput)?.IsDaemon !== true) {
        return true
      }
    }
    return false
  }

  private startModelPhase(turn: Turn, now = Date.now()): void {
    if (turn.modelPhaseStart !== undefined) return
    turn.modelPhaseStart = now
    turn.decodeStart = undefined
    turn.lastChunkAt = undefined
  }

  private pauseModelPhase(turn: Turn, now = Date.now()): void {
    if (turn.modelPhaseStart === undefined) return
    turn.apiDurationMs += Math.max(0, now - turn.modelPhaseStart)
    if (turn.decodeStart !== undefined && turn.lastChunkAt !== undefined) {
      turn.decodeDurationMs += Math.max(0, turn.lastChunkAt - turn.decodeStart)
    }
    turn.modelPhaseStart = undefined
    turn.decodeStart = undefined
    turn.lastChunkAt = undefined
  }

  private recordModelChunk(turn: Turn, now = Date.now()): void {
    if (turn.modelPhaseStart === undefined) {
      this.startModelPhase(turn, now)
    }
    if (turn.decodeStart === undefined) {
      turn.decodeStart = now
      if (turn.ttftMs === undefined) {
        turn.ttftMs = Math.max(0, now - turn.modelPhaseStart!)
      }
    }
    turn.lastChunkAt = now
  }

  private maybeResumeModelPhase(turn: Turn, now = Date.now()): void {
    if (turn.cancelled || turn.finishing || turn.nativeEnd) return
    if (!this.hasActiveNonDaemonWork(turn)) {
      this.startModelPhase(turn, now)
    }
  }

  private replyPermission(id: number | string, choice?: Option): boolean {
    return this.acp.reply(id, {
      outcome: choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' },
    })
  }

  private cancelPermissions(turn: Turn): void {
    for (const [requestId, pending] of turn.permissions) {
      if ('kind' in pending && pending.kind === 'elicitation') {
        this.acp.reply(pending.id, { action: 'cancel' })
      } else if ('id' in pending) {
        this.replyPermission(pending.id)
      }
      this.emit({ type: 'control_cancel_request', request_id: requestId })
    }
    turn.permissions.clear()
  }

  private enqueueAppend(entries: Frame[]): Promise<void> {
    if (entries.length === 0) return this.appendChain
    const batch = entries.slice()
    const next = this.appendChain.catch(() => undefined).then(() => this.append(batch))
    this.appendChain = next
    void next.catch(() => undefined)
    return next
  }

  private async run(
    turn: Turn,
    seq: number,
    prompt: Frame[],
    user?: Frame,
    entriesToPersist?: Frame[],
  ): Promise<void> {
    let error: AntigravityError | undefined
    let result: Frame = {}
    try {
      if (entriesToPersist) await this.enqueueAppend(entriesToPersist)
      else if (user) await this.enqueueAppend([user])
      else if (turn.isCompact) await this.appendChain.catch(() => undefined)
      if (!turn.cancelled) {
        if (turn.isCompact) {
          this.emit({
            type: 'system',
            subtype: 'local_command',
            uuid: turn.userUuid ?? crypto.randomUUID(),
            content: turn.compactCommandXml ?? '<command-name>/compact</command-name>',
          })
          this.emit({ type: 'system', subtype: 'status', status: 'compacting' })
        } else if (user) {
          this.emit({ ...user, isReplay: true })
        }
        this.listening = true
        this.startModelPhase(turn)
        result = await this.acp.prompt(prompt)
        if (result.stopReason === 'refusal') {
          error = new AntigravityError('ANTIGRAVITY_TURN_FAILED', 'Antigravity declined the request.')
        }
      }
    } catch (cause) {
      error = cause instanceof AntigravityError ? cause : new AntigravityError('ANTIGRAVITY_TURN_FAILED', 'Could not save the Antigravity conversation.')
    } finally {
      if (seq === turn.promptSeq) {
        this.pauseModelPhase(turn)
      }
    }
    if (seq !== turn.promptSeq) {
      addAccumulatedUsage(turn.accumulatedUsage, readPromptUsage(result.usage))
      return
    }
    clearTimeout(turn.cancelTimer)
    this.finishPromptQuestion(turn, result.stopReason === 'end_turn' && !turn.cancelled && !error)
    turn.nativeEnd = { result, error }
    this.maybeFinish(turn)
  }

  private finishPromptQuestion(turn: Turn, canAsk: boolean): void {
    const pending = turn.promptQuestion
    if (pending) {
      turn.promptQuestion = undefined
      const { tool, question, options, echo, buffered } = pending
      const toolUseId = tool.toolCallId as string
      turn.pendingAskTools.delete(toolUseId)
      const ask = canAsk && tool.status === 'pending'
      // 只隐藏 AGY 自己生成、与结构化字段完全一致的编号列表，保留普通正文。
      if (buffered && (!ask || buffered !== echo)) this.chunk(turn, 'text', buffered)
      if (ask) {
        this.publishPermission(turn, tool, { promptToolUseId: toolUseId, question, options })
      } else if (!turn.cancelled) {
        this.toolCall(turn, tool)
      }
    }
    if (turn.pendingAskTools.size > 0) {
      const remaining = [...turn.pendingAskTools.values()]
      turn.pendingAskTools.clear()
      if (!turn.cancelled) {
        for (const tool of remaining) {
          this.toolCall(turn, tool)
        }
      }
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
    this.pauseModelPhase(turn)
    let error = end.error
    let compactBoundaryEvent: Frame | undefined
    try {
      do {
        this.flushChunk(turn)
        if (turn.entries.length) await this.enqueueAppend(turn.entries.splice(0))
        else await this.appendChain
        // 通过同一双工管道，后台事件可能在上一次历史写入期间继续到达。
        if (this.awaitsBackgroundWork(turn)) {
          turn.finishing = false
          return
        }
      } while (turn.entries.length || turn.chunk)
      if (turn.isCompact && !turn.cancelled && !error) {
        const compactUuid = crypto.randomUUID()
        const compactTimestamp = new Date().toISOString()
        const preTokens = turn.preCompactTokens
        const liveBoundary: Frame = {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: compactUuid,
          timestamp: compactTimestamp,
          compact_metadata: {
            trigger: 'manual',
            ...(preTokens > 0 ? { pre_tokens: preTokens } : {}),
          },
        }
        const persistedBoundary: Frame = {
          ...liveBoundary,
          content: 'Conversation compacted',
          message: { role: 'system', content: 'Conversation compacted' },
          compactMetadata: {
            trigger: 'manual',
            ...(preTokens > 0 ? { preTokens } : {}),
          },
        }
        await this.enqueueAppend([persistedBoundary])
        compactBoundaryEvent = liveBoundary
      }
    } catch {
      error = new AntigravityError('ANTIGRAVITY_TURN_FAILED', 'Could not save the Antigravity response.')
    }
    void this.computerUseBridge?.releaseLock()
    this.cancelPermissions(turn)
    this.turn = undefined
    const failed = !turn.cancelled && error
    if (turn.isCompact) {
      if (compactBoundaryEvent && !turn.cancelled && !error) {
        this.emit(compactBoundaryEvent)
      } else {
        this.emit({ type: 'system', subtype: 'status', status: null })
      }
    }
    if (failed) this.emit({ type: 'assistant', error: failed.code, isApiErrorMessage: true, message: { content: [{ type: 'text', text: failed.message }] } })
    const finalUsage = readPromptUsage(end.result.usage)
    const inputTokens = turn.accumulatedUsage.inputTokens + finalUsage.inputTokens
    const outputTokens = turn.accumulatedUsage.outputTokens + finalUsage.outputTokens
    const cacheReadTokens = turn.accumulatedUsage.cacheReadTokens + finalUsage.cacheReadTokens
    const cacheCreationTokens = turn.accumulatedUsage.cacheCreationTokens + finalUsage.cacheCreationTokens
    const observedPromptTokens = inputTokens + cacheReadTokens + cacheCreationTokens
    if (!turn.isCompact && observedPromptTokens > 0) {
      this.captureFirstTurnBaseline(observedPromptTokens)
    }
    const totalDurationMs = Math.max(0, Date.now() - turn.started)
    this.cumulativeUsage.inputTokens += inputTokens
    this.cumulativeUsage.outputTokens += outputTokens
    this.cumulativeUsage.cacheReadTokens += cacheReadTokens
    this.cumulativeUsage.cacheCreationTokens += cacheCreationTokens
    this.cumulativeUsage.totalAPIDuration += turn.apiDurationMs
    this.cumulativeUsage.totalDecodeDuration += turn.decodeDurationMs
    this.cumulativeUsage.totalTtftDuration += turn.ttftMs ?? 0
    this.cumulativeUsage.totalDuration += totalDurationMs
    this.emit({
      type: 'result', subtype: failed ? 'error' : 'success', is_error: Boolean(failed),
      ...(failed ? { result: failed.message } : {}),
      duration_ms: totalDurationMs,
      duration_api_ms: turn.apiDurationMs,
      ...(turn.decodeDurationMs > 0 ? { decode_ms: turn.decodeDurationMs } : {}),
      ...(turn.ttftMs !== undefined ? { ttft_ms: turn.ttftMs } : {}),
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
      timestamp: new Date().toISOString(),
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
    this.toolStartedAt.set(id, Date.now())
    this.flushChunk(turn)
    this.assistant(turn, {
      type: 'tool_use',
      id,
      name: overrideName ?? projected.name,
      input: overrideInput ?? projected.input,
    })
    if (projected.isSubagentInvoke && turn.entries.length > 0) {
      // Flush invoke_subagent tool_use immediately so clicking an in-progress subagent card
      // resolves from session history before the parent turn completes.
      void this.enqueueAppend(turn.entries.splice(0))
    }
    this.projectToolState(turn, id, tool)
    return projected
  }

  private projectToolState(turn: Turn, id: string, tool: Frame): void {
    if (!toolHasFinished(tool)) {
      this.tools.set(id, tool)
      if (acpObject(tool.rawInput)?.IsDaemon !== true) {
        this.pauseModelPhase(turn)
      }
      return
    }
    this.tools.set(id, null)
    const startedAt = this.toolStartedAt.get(id)
    this.toolStartedAt.delete(id)
    const durationMs = typeof startedAt === 'number' ? Math.max(0, Date.now() - startedAt) : undefined
    this.flushChunk(turn)
    const resolvedQuestion = turn.resolvedQuestions.get(id)
    if (resolvedQuestion) turn.resolvedQuestions.delete(id)
    const answer = turn.promptAnswer?.toolUseId === id ? turn.promptAnswer : undefined
    if (answer) turn.promptAnswer = undefined
    let content: unknown
    if (resolvedQuestion && (tool.status === 'completed' || resolvedQuestion.handedOff)) {
      content = resolvedQuestion.handedOff
        ? { handedOff: true, message: resolvedQuestion.handoffMessage ?? ASK_USER_QUESTION_CLARIFY_MESSAGE }
        : {
            questions: resolvedQuestion.questions,
            answers: resolvedQuestion.answers ?? {},
            ...(resolvedQuestion.annotations ? { annotations: resolvedQuestion.annotations } : {}),
          }
    } else if (answer && tool.status === 'completed') {
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
      timestamp: new Date().toISOString(),
      ...(durationMs !== undefined ? { durationMs } : {}),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: tool.status === 'failed' }] },
    }
    turn.entries.push(message)
    this.emit(message)
    this.maybeResumeModelPhase(turn)
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
    if (method === 'elicitation/create' && rpcId !== undefined) {
      if (!matches) {
        this.acp.reply(rpcId, { action: 'cancel' })
        return
      }
      const parsed = parseElicitationForm(params)
      if (!parsed) {
        this.acp.reply(rpcId, undefined, -32602)
        return
      }
      const turn = this.turn ?? this.beginTurn(true)
      const rawToolCallId = typeof params.toolCallId === 'string' && params.toolCallId.trim()
        ? params.toolCallId.trim()
        : undefined
      const toolUseId = rawToolCallId ?? `elicitation_${String(rpcId)}`
      const heldTool = rawToolCallId ? turn.pendingAskTools.get(rawToolCallId) : undefined
      if (rawToolCallId) turn.pendingAskTools.delete(rawToolCallId)
      if (turn.promptQuestion && (!rawToolCallId || turn.promptQuestion.tool.toolCallId === rawToolCallId)) {
        const { buffered, echo } = turn.promptQuestion
        turn.promptQuestion = undefined
        if (buffered && buffered !== echo) this.chunk(turn, 'text', buffered)
      }
      const toolFrame: Frame = heldTool
        ? { ...heldTool, toolCallId: toolUseId, status: 'pending' }
        : {
            toolCallId: toolUseId,
            name: 'ask_question',
            title: typeof params.message === 'string' && params.message.trim() ? params.message.trim() : 'Ask question',
            status: 'pending',
          }
      if (turn.nativeEnd) turn.replyOpen = true
      this.publishPermission(turn, toolFrame, {
        id: rpcId,
        kind: 'elicitation',
        toolUseId,
        questions: parsed.questions,
        allowFreeText: parsed.allowFreeText,
        hasNativeToolCall: Boolean(rawToolCallId),
      })
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
        this.recordModelChunk(turn)
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
        // interaction_* 等权限 RPC；ask_question 等 elicitation/create 或旧版终端回退。
        if (typeof update.toolCallId !== 'string' || update.toolCallId.startsWith('interaction_') || this.tools.has(update.toolCallId)) return
        turn ??= this.beginTurn(true)
        if (turn.pendingAskTools.has(update.toolCallId) || turn.promptQuestion?.tool.toolCallId === update.toolCallId) return
        if (update.name === 'ask_question' && !toolHasFinished(update) && !turn.nativeEnd) {
          this.flushChunk(turn)
          turn.pendingAskTools.set(update.toolCallId, update)
          const question = !turn.promptQuestion && readPromptQuestion(update)
          if (question) turn.promptQuestion = question
        } else {
          this.toolCall(turn, update)
        }
        break
      }
      case 'tool_call_update': {
        const id = update.toolCallId
        if (typeof id !== 'string') return
        const heldAskTool = turn?.pendingAskTools.get(id)
        if (turn && heldAskTool) {
          const merged = { ...heldAskTool, ...update }
          if (turn.promptQuestion?.tool.toolCallId === id) {
            turn.promptQuestion.tool = merged
          }
          if (toolHasFinished(merged)) {
            turn.pendingAskTools.delete(id)
            if (turn.promptQuestion?.tool.toolCallId === id) {
              this.finishPromptQuestion(turn, false)
            } else if (!turn.cancelled) {
              this.toolCall(turn, merged)
            }
          } else {
            turn.pendingAskTools.set(id, merged)
          }
          break
        }
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
        if (used !== undefined && used > 0 && !turn?.isCompact) {
          this.captureFirstTurnBaseline(used)
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
    const previousTool = this.tools.get(toolUseId)
    const definedToolFields = Object.fromEntries(
      Object.entries(tool).filter(([, value]) => value !== undefined),
    )
    const mergedTool: Frame = previousTool
      ? { ...previousTool, ...definedToolFields }
      : tool
    if (previousTool && !toolHasFinished(mergedTool)) {
      this.tools.set(toolUseId, mergedTool)
    }

    const input = acpObject(mergedTool.rawInput) ?? acpObject(mergedTool.args) ?? {}
    const question = toolUseId.startsWith('interaction_')
      ? (typeof input.question === 'string' ? input.question : typeof mergedTool.title === 'string' ? mergedTool.title : undefined)
      : undefined
    if (toolUseId.startsWith('interaction_') && (!question || options.length === 0 || new Set(options.map(option => option.name)).size !== options.length)) {
      this.replyPermission(rpcId)
      return
    }

    // Auto-approve our own injected Computer Use MCP server when Computer Use is globally enabled in Settings.
    const rawToolName = typeof mergedTool.name === 'string' ? mergedTool.name : undefined
    if (!question && this.computerUseBridge?.isEnabled() && isAntigravityComputerUseToolName(rawToolName)) {
      const allowOption = options.find(option => option.kind === 'allow_once')
        ?? options.find(option => option.kind === 'allow_always')
      if (allowOption) {
        this.toolCall(turn, mergedTool)
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
    this.publishPermission(turn, mergedTool, { id: rpcId, options, question, toolUseId })
  }

  private publishPermission(turn: Turn, tool: Frame, pending: PendingPermission): void {
    const projected = this.projectTool(tool)
    const isElicitation = 'kind' in pending && pending.kind === 'elicitation'
    const isQuestion = isElicitation || Boolean(pending.question)
    const name = isQuestion ? 'AskUserQuestion' : projected.name
    const input = isElicitation
      ? buildElicitationQuestionInput(pending.questions, pending.allowFreeText)
      : pending.question
        ? questionInput(pending.question, pending.options)
        : projected.input
    const supportsAllowAlways = !isQuestion && pending.options.some(option => option.kind === 'allow_always')
    const permissionDescription = projected.description ?? projected.displayName
    const requestId = crypto.randomUUID()
    this.toolCall(turn, tool, name, input)
    turn.permissions.set(requestId, pending)
    this.pauseModelPhase(turn)
    this.emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: name,
        tool_use_id: tool.toolCallId,
        input,
        ...(!isQuestion && permissionDescription ? { description: permissionDescription } : {}),
        ...(!isQuestion ? { display_name: 'Antigravity' } : {}),
        ...(!isQuestion && projected.antigravityToolName ? { antigravity_tool_name: projected.antigravityToolName } : {}),
        ...(projected.subagentName ? { subagent_name: projected.subagentName } : {}),
        ...(projected.subagentId ? { agent_id: projected.subagentId } : {}),
        ...(!isQuestion ? { supports_allow_always: supportsAllowAlways } : {}),
      },
    })
  }
}
