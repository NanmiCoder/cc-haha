import { ApiError } from '../../middleware/errorHandler.js'
import {
  providerTextCompletion,
  type ProviderTextCompletionRequest,
  type ProviderTextCompletionResult,
} from '../providerTextCompletion.js'
import {
  cleanCorrectionOutput,
  isPlausibleCorrection,
  MAX_CORRECTION_TEXT_LENGTH,
  normalizeDictationText,
  rebuildCorrection,
} from './correction/diff.js'
import { buildCorrectionSystemPrompt, CORRECTION_MAX_TOKENS } from './correction/prompt.js'
import {
  createProviderTargetResolver,
  describeCorrectionTargets,
  resolvePreferredTarget,
  type CorrectionTargetResolver,
  type ResolvedCorrectionTarget,
} from './correction/target.js'
import { VoiceServiceError } from './errors.js'
import {
  buildPickUserMessage,
  HISTORY_PICK_MAX_TOKENS,
  HISTORY_PICK_SYSTEM_PROMPT,
  parsePickResponse,
} from './history/pick.js'
import {
  defaultHistoryPaths,
  isVoiceHistorySourceId,
  listHistorySources,
  scanHistoryTerms,
  type HistoryPaths,
} from './history/scan.js'
import { isVoiceDownloadSource, isVoiceLanguage } from './preferences.js'
import type { VoicePreferencesStore } from './preferencesStore.js'
import type { VoiceProviderRegistry } from './registry.js'
import {
  VOICE_LIMITS,
  type SpeechProvider,
  type VoiceCatalog,
  type VoiceCorrection,
  type VoiceHistorySource,
  type VoiceHistorySourceId,
  type VoiceHistorySuggestions,
  type VoiceLanguage,
  type VoicePreferences,
  type VoicePreparationState,
  type VoiceProviderStatus,
  type VoiceTranscript,
} from './types.js'
import { FileVoiceVocabularyStore, type VoiceVocabularyStore } from './vocabulary/store.js'
import { validateVoiceWav } from './wav.js'

export type TextCompletion = (request: ProviderTextCompletionRequest) => Promise<ProviderTextCompletionResult>

export type VoiceServiceOptions = {
  registry: VoiceProviderRegistry
  preferences: VoicePreferencesStore
  /** Which model AI correction and the history pick talk to. Defaults to the saved providers. */
  correctionTargets?: CorrectionTargetResolver
  /** The text transport; defaults to the one session titles use. */
  completeText?: TextCompletion
  /** Defaults to `<cc-haha>/voice-vocabulary.json`. */
  vocabulary?: VoiceVocabularyStore
  /** Where chat history lives; defaults to the Claude config home and Codex home. */
  historyPaths?: () => HistoryPaths
}

/** Hard server-side limit on one correction; the composer gives up sooner (3 s). */
export const CORRECTION_TIMEOUT_MS = 10_000
/** The pick answers ~100 grouped terms; the desktop waits up to 120 s for scan + pick. */
export const HISTORY_PICK_TIMEOUT_MS = 90_000
const MAX_CORRECTION_PROVIDER_ID_LENGTH = 80
const MAX_CORRECTION_MODEL_ID_LENGTH = 200

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function elapsedSeconds(started: number): number {
  return Math.round(performance.now() - started) / 1000
}

/**
 * Reads a `{ providerId, modelId }` choice: both null (or both absent) follows
 * the default provider, both non-empty strings name a fixed target.
 */
function parseModelChoice(
  providerId: unknown,
  modelId: unknown,
  labels: { provider: string; model: string },
): { providerId: string; modelId: string } | null {
  if ((providerId === null || providerId === undefined) && (modelId === null || modelId === undefined)) return null
  const provider = typeof providerId === 'string' ? providerId.trim() : ''
  const model = typeof modelId === 'string' ? modelId.trim() : ''
  if (!provider || !model) {
    throw ApiError.badRequest(`${labels.provider} and ${labels.model} must both be strings, or both null`)
  }
  if (provider.length > MAX_CORRECTION_PROVIDER_ID_LENGTH || model.length > MAX_CORRECTION_MODEL_ID_LENGTH) {
    throw ApiError.badRequest(`${labels.provider} or ${labels.model} is too long`)
  }
  return { providerId: provider, modelId: model }
}

function correctionFailure(result: Extract<ProviderTextCompletionResult, { ok: false }>, what: string): Error {
  if (result.reason === 'aborted') return abortError()
  return new VoiceServiceError('voice/correction-failed', `${what} failed: ${result.message}`, result.reason)
}

type PrepareTask = {
  controller: AbortController
  state: VoicePreparationState
  /** Settles once the provider's prepare() has fully stopped, even after cancel. */
  settled: Promise<void>
}

function isUnsupportedPlatform(state: VoicePreparationState): boolean {
  return state.phase === 'failed' && state.error?.reason === 'unsupported-platform'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function providerLanguage(provider: SpeechProvider, preferred: VoiceLanguage): VoiceLanguage {
  const { languages } = provider.info
  if (languages.includes(preferred)) return preferred
  return languages.includes('auto') ? 'auto' : (languages[0] ?? 'auto')
}

export class VoiceService {
  private readonly registry: VoiceProviderRegistry
  private readonly preferences: VoicePreferencesStore
  private readonly tasks = new Map<string, PrepareTask>()
  /** Last failed/cancelled outcome per provider; disk state alone would read as `unprepared`. */
  private readonly outcomes = new Map<string, VoicePreparationState>()
  /** Cancelled tasks whose provider.prepare() has not stopped yet. */
  private readonly winding = new Map<string, Promise<void>>()
  private readonly targets: CorrectionTargetResolver
  private readonly completeText: TextCompletion
  private readonly vocabularyStore: VoiceVocabularyStore
  private readonly historyPaths: () => HistoryPaths

  constructor(options: VoiceServiceOptions) {
    this.registry = options.registry
    this.preferences = options.preferences
    this.targets = options.correctionTargets ?? createProviderTargetResolver()
    this.completeText = options.completeText ?? providerTextCompletion
    this.vocabularyStore = options.vocabulary ?? new FileVoiceVocabularyStore()
    this.historyPaths = options.historyPaths ?? defaultHistoryPaths
  }

  get vocabulary(): VoiceVocabularyStore {
    return this.vocabularyStore
  }

  private requireProvider(id: string): SpeechProvider {
    const provider = this.registry.get(id)
    if (!provider) {
      throw new VoiceServiceError('voice/unknown-provider', `Unknown voice provider: ${id}`)
    }
    return provider
  }

  private async providerPreparation(provider: SpeechProvider): Promise<VoicePreparationState> {
    const task = this.tasks.get(provider.info.id)
    if (task) return task.state
    if (!provider.preparation) return { phase: 'ready' }
    const onDisk = await provider.preparation.status()
    if (onDisk.phase === 'ready') {
      this.outcomes.delete(provider.info.id)
      return onDisk
    }
    return this.outcomes.get(provider.info.id) ?? onDisk
  }

  private async providerStatus(provider: SpeechProvider): Promise<VoiceProviderStatus> {
    return { info: provider.info, preparation: await this.providerPreparation(provider) }
  }

  async catalog(): Promise<VoiceCatalog> {
    const providers = await Promise.all(this.registry.list().map(provider => this.providerStatus(provider)))
    const preferences = await this.preferences.read()
    return {
      // Providers report `unsupported-platform` themselves; the feature is only
      // unavailable when every one of them does.
      supported: providers.some(item => !isUnsupportedPlatform(item.preparation)),
      providers,
      preferences,
      limits: VOICE_LIMITS,
      correction: await describeCorrectionTargets(this.targets, preferences),
    }
  }

  async status(providerId: string): Promise<VoiceProviderStatus> {
    return this.providerStatus(this.requireProvider(providerId))
  }

  async updatePreferences(patch: unknown): Promise<VoicePreferences> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw ApiError.badRequest('Voice preferences must be an object')
    }
    const input = patch as Record<string, unknown>
    const next: Partial<VoicePreferences> = {}

    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw ApiError.badRequest('enabled must be a boolean')
      next.enabled = input.enabled
    }
    if (input.providerId !== undefined) {
      if (typeof input.providerId !== 'string' || !this.registry.get(input.providerId)) {
        throw new VoiceServiceError('voice/unknown-provider', `Unknown voice provider: ${String(input.providerId)}`)
      }
      next.providerId = input.providerId
    }
    if (input.language !== undefined) {
      if (!isVoiceLanguage(input.language)) throw ApiError.badRequest(`Unsupported language: ${String(input.language)}`)
      next.language = input.language
    }
    if (input.downloadSource !== undefined) {
      if (!isVoiceDownloadSource(input.downloadSource)) {
        throw ApiError.badRequest(`Unsupported download source: ${String(input.downloadSource)}`)
      }
      next.downloadSource = input.downloadSource
    }
    if (input.correctionEnabled !== undefined) {
      if (typeof input.correctionEnabled !== 'boolean') throw ApiError.badRequest('correctionEnabled must be a boolean')
      next.correctionEnabled = input.correctionEnabled
    }
    if ('correctionProviderId' in input || 'correctionModelId' in input) {
      const choice = parseModelChoice(input.correctionProviderId, input.correctionModelId, {
        provider: 'correctionProviderId',
        model: 'correctionModelId',
      })
      // Absent keys are not "follow the default": only an explicit null pair is.
      if (!choice && (input.correctionProviderId === undefined || input.correctionModelId === undefined)) {
        throw ApiError.badRequest('correctionProviderId and correctionModelId must be sent together')
      }
      if (choice && !(await this.targets.resolveFixed(choice.providerId, choice.modelId))) {
        throw ApiError.badRequest(`Unknown correction provider: ${choice.providerId}`)
      }
      next.correctionProviderId = choice?.providerId ?? null
      next.correctionModelId = choice?.modelId ?? null
    }

    const current = await this.preferences.read()
    const provider = this.requireProvider(next.providerId ?? current.providerId)
    if (next.language !== undefined) {
      if (!provider.info.languages.includes(next.language)) {
        throw ApiError.badRequest(`${provider.info.name} does not support language: ${next.language}`)
      }
    } else if (next.providerId !== undefined && !provider.info.languages.includes(current.language)) {
      // Switching provider must not leave a language the new provider cannot serve.
      next.language = providerLanguage(provider, current.language)
    }

    const updated = await this.preferences.update(next)
    if (next.providerId !== undefined && next.providerId !== current.providerId) {
      // Not awaited: the release waits for the old model's queued work, which
      // can take minutes. The switch is saved; the client must hear so now.
      void this.releaseProvider(current.providerId)
    }
    return updated
  }

  /** Lets the provider the user switched away from free its warm model; never fails the switch. */
  private async releaseProvider(providerId: string): Promise<void> {
    const previous = this.registry.get(providerId)
    if (!previous?.release) return
    try {
      await previous.release()
    } catch (error) {
      console.warn(`[voice] Releasing ${providerId} failed: ${describeError(error)}`)
    }
  }

  // --- AI correction ----------------------------------------------------------

  /**
   * Fixes misheard terms in one dictation. The reply is the recognized text
   * with only the model's term edits applied, each listed in `changes`.
   */
  async correct(rawText: unknown, signal: AbortSignal): Promise<VoiceCorrection> {
    if (typeof rawText !== 'string') throw ApiError.badRequest('text must be a string')
    const text = normalizeDictationText(rawText)
    if (!text) throw ApiError.badRequest('text is empty')
    if (text.length > MAX_CORRECTION_TEXT_LENGTH) {
      throw ApiError.badRequest(`text is too long (limit ${MAX_CORRECTION_TEXT_LENGTH} characters)`)
    }
    const started = performance.now()

    const preferences = await this.preferences.read()
    if (!preferences.correctionEnabled) {
      throw new VoiceServiceError('voice/correction-unavailable', 'AI correction is turned off')
    }
    const resolved = await this.resolveTarget(() => resolvePreferredTarget(this.targets, preferences))
    // An unreadable vocabulary file (permissions, a disk error) must not cost the
    // user the correction itself; correct without the extra hints.
    const vocabulary = await this.vocabularyStore.snapshot().catch((error: unknown) => {
      console.warn(`[voice] Reading the vocabulary failed, correcting without it: ${describeError(error)}`)
      return { terms: [], known: new Set<string>(), excluded: new Set<string>() }
    })

    const result = await this.completeText({
      provider: resolved.provider,
      modelId: resolved.target.modelId,
      system: buildCorrectionSystemPrompt(vocabulary.terms),
      user: text,
      maxTokens: CORRECTION_MAX_TOKENS,
      // The same dictation should correct the same way every time (the benchmark
      // ran at ~0). Unpinned, DeepSeek Flash gave different answers for one sentence.
      temperature: 0,
      // The dictation waits on this call; keep OpenAI-format reasoning models short.
      reasoningEffort: 'low',
      signal,
      timeoutMs: CORRECTION_TIMEOUT_MS,
    })
    if (!result.ok) throw correctionFailure(result, 'AI correction')

    const output = cleanCorrectionOutput(result.text, text)
    if (!isPlausibleCorrection(text, output)) {
      throw new VoiceServiceError(
        'voice/correction-failed',
        'The correction model did not return a corrected version of the text',
        'invalid-output',
      )
    }
    const rebuilt = rebuildCorrection(text, output)
    const changes = rebuilt.changes.map(change => ({
      ...change,
      inVocabulary: vocabulary.known.has(change.to.toLowerCase()),
    }))

    const unexplained = changes.filter(change => !change.inVocabulary)
    if (unexplained.length > 0) {
      try {
        await this.vocabularyStore.recordSuggestions(unexplained)
      } catch (error) {
        // Suggestions are a convenience; the corrected text is still good.
        console.warn(`[voice] Recording vocabulary suggestions failed: ${describeError(error)}`)
      }
    }

    return { text: rebuilt.text, changes, target: resolved.target, seconds: elapsedSeconds(started) }
  }

  private async resolveTarget(
    resolve: () => Promise<ResolvedCorrectionTarget | null>,
  ): Promise<ResolvedCorrectionTarget> {
    let resolved: ResolvedCorrectionTarget | null
    try {
      resolved = await resolve()
    } catch {
      resolved = null
    }
    if (!resolved) {
      throw new VoiceServiceError('voice/correction-unavailable', 'No model is available for AI correction')
    }
    return resolved
  }

  // --- Vocabulary from chat history ------------------------------------------

  async historySources(): Promise<VoiceHistorySource[]> {
    return listHistorySources(this.historyPaths())
  }

  /**
   * Counts terms in the user's own messages locally, then asks the model once
   * to pick vocabulary from the candidate words and their session counts.
   */
  async suggestFromHistory(body: unknown, signal: AbortSignal): Promise<VoiceHistorySuggestions> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest('History request must be an object')
    }
    const input = body as Record<string, unknown>
    if (!Array.isArray(input.sources) || input.sources.length === 0 || !input.sources.every(isVoiceHistorySourceId)) {
      throw ApiError.badRequest('sources must be a non-empty list of claude-code / codex')
    }
    const sources = [...new Set(input.sources as VoiceHistorySourceId[])]
    const choice = parseModelChoice(input.providerId, input.modelId, { provider: 'providerId', model: 'modelId' })
    const resolved = await this.resolveTarget(() => choice
      ? this.targets.resolveFixed(choice.providerId, choice.modelId)
      : this.targets.resolveDefault())
    const started = performance.now()

    const vocabulary = await this.vocabularyStore.snapshot()
    const scan = await scanHistoryTerms(sources, {
      paths: this.historyPaths(),
      signal,
      exclude: vocabulary.excluded,
    })

    let groups: VoiceHistorySuggestions['groups'] = []
    if (scan.candidates.length > 0) {
      const result = await this.completeText({
        provider: resolved.provider,
        modelId: resolved.target.modelId,
        system: HISTORY_PICK_SYSTEM_PROMPT,
        user: buildPickUserMessage(scan.candidates),
        maxTokens: HISTORY_PICK_MAX_TOKENS,
        temperature: 0,
        reasoningEffort: 'low',
        signal,
        timeoutMs: HISTORY_PICK_TIMEOUT_MS,
        attemptTimeoutMs: HISTORY_PICK_TIMEOUT_MS,
      })
      if (!result.ok) throw correctionFailure(result, 'Picking vocabulary')
      const picked = parsePickResponse(result.text, scan.candidates, vocabulary.known)
      if (!picked) {
        throw new VoiceServiceError('voice/correction-failed', 'The model did not return a term list', 'invalid-output')
      }
      groups = picked
    }
    if (signal.aborted) throw abortError()

    await this.vocabularyStore.markHistoryRun()
    return {
      groups,
      sessions: scan.sessions,
      messages: scan.messages,
      candidates: scan.candidates.length,
      target: resolved.target,
      seconds: elapsedSeconds(started),
    }
  }

  /** Starts (or joins) the background download for a provider; returns immediately. */
  async prepare(providerId: string): Promise<VoiceProviderStatus> {
    const provider = this.requireProvider(providerId)
    const preparation = provider.preparation
    if (!preparation || this.tasks.has(providerId)) {
      return this.providerStatus(provider)
    }

    this.outcomes.delete(providerId)
    const controller = new AbortController()
    const task: PrepareTask = {
      controller,
      state: { phase: 'downloading' },
      settled: Promise.resolve(),
    }
    this.tasks.set(providerId, task)
    task.settled = this.runPrepare(provider, task)
    return { info: provider.info, preparation: task.state }
  }

  private async runPrepare(provider: SpeechProvider, task: PrepareTask): Promise<void> {
    const id = provider.info.id
    const preparation = provider.preparation!
    const isCurrent = () => this.tasks.get(id) === task
    let final: VoicePreparationState

    try {
      await this.winding.get(id)
      if (task.controller.signal.aborted) return
      const onDisk = await preparation.status()
      if (onDisk.phase === 'ready') {
        final = onDisk
      } else {
        const { downloadSource } = await this.preferences.read()
        await preparation.prepare(task.controller.signal, state => {
          if (isCurrent()) task.state = state
        }, { downloadSource })
        const after = await preparation.status()
        if (after.phase === 'ready') {
          final = after
        } else if (task.state.phase === 'failed') {
          final = task.state
        } else {
          final = {
            phase: 'failed',
            error: { reason: 'unknown', message: 'Preparation finished but the assets are not ready' },
          }
        }
      }
    } catch (error) {
      if (task.controller.signal.aborted) {
        final = { phase: 'cancelled' }
      } else if (task.state.phase === 'failed') {
        final = task.state
      } else {
        final = { phase: 'failed', error: { reason: 'unknown', message: describeError(error) } }
      }
    }

    // A cancel or remove already retired this task; its outcome is recorded there.
    if (!isCurrent()) return
    this.tasks.delete(id)
    if (final.phase === 'ready') this.outcomes.delete(id)
    else this.outcomes.set(id, final)
  }

  async cancel(providerId: string): Promise<VoiceProviderStatus> {
    const provider = this.requireProvider(providerId)
    const task = this.tasks.get(providerId)
    if (task) {
      this.tasks.delete(providerId)
      this.outcomes.set(providerId, { phase: 'cancelled' })
      task.controller.abort()
      // Keep a later prepare()/remove() from racing the winding-down download.
      const winding: Promise<void> = task.settled.finally(() => {
        if (this.winding.get(providerId) === winding) this.winding.delete(providerId)
      })
      this.winding.set(providerId, winding)
    }
    return this.providerStatus(provider)
  }

  async removeAssets(providerId: string): Promise<VoiceProviderStatus> {
    const provider = this.requireProvider(providerId)
    await this.cancel(providerId)
    await this.winding.get(providerId)
    this.outcomes.delete(providerId)
    if (provider.preparation) {
      const removing = provider.preparation.remove()
      // A prepare() arriving mid-removal must wait for it; otherwise its fresh
      // download would be deleted underneath it (or leave a half-removed tree).
      const winding: Promise<void> = removing
        .then(() => {}, () => {})
        .finally(() => {
          if (this.winding.get(providerId) === winding) this.winding.delete(providerId)
        })
      this.winding.set(providerId, winding)
      try {
        await removing
      } catch (error) {
        throw new VoiceServiceError('voice/failed', `Failed to remove voice assets: ${describeError(error)}`)
      }
    }
    return this.providerStatus(provider)
  }

  async transcribe(
    providerId: string | undefined,
    wav: Uint8Array,
    language: VoiceLanguage | undefined,
    signal: AbortSignal,
  ): Promise<VoiceTranscript> {
    const preferences = await this.preferences.read()
    const provider = this.requireProvider(providerId ?? preferences.providerId)
    if (language !== undefined && !provider.info.languages.includes(language)) {
      throw ApiError.badRequest(`${provider.info.name} does not support language: ${language}`)
    }
    const effectiveLanguage = language ?? providerLanguage(provider, preferences.language)

    const { audioSeconds } = validateVoiceWav(wav)

    const preparation = await this.providerPreparation(provider)
    if (preparation.phase !== 'ready') {
      throw new VoiceServiceError('voice/not-ready', `${provider.info.name} is not ready (${preparation.phase})`)
    }

    try {
      const transcript = await provider.transcribe(wav, { language: effectiveLanguage }, signal)
      return { ...transcript, audioSeconds }
    } catch (error) {
      if (signal.aborted) throw error
      // Providers classify their own failures (invalid audio, model removed
      // after the readiness check); wrapping those would turn a 400/409 into 500.
      if (error instanceof VoiceServiceError) throw error
      throw new VoiceServiceError('voice/failed', `Transcription failed: ${describeError(error)}`)
    }
  }
}
