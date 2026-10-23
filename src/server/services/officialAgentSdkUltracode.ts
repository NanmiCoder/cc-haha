import { areWorkflowsEnabled, describeWorkflowSizeGuideline } from '../../utils/workflows/enabled.js'
import { hasWorkflowKeyword } from '../../utils/workflows/keyword.js'
import { ULTRACODE_ENTER_REMINDER, ULTRACODE_STILL_ON_REMINDER, ULTRACODE_EXIT_REMINDER, WORKFLOW_KEYWORD_REMINDER } from '../../utils/workflows/ultracode.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

export type OfficialWorkflowInputContext = {
  isHumanInput: boolean
  /** Original composer text, before host attachments or skill expansion. */
  humanText?: string
}

/**
 * The desktop host attests to human provenance. The SDK itself is a
 * non-interactive transport, so its global interactive-session flag cannot
 * distinguish a composer turn from a cron job or a relayed agent message.
 */
export function appendOfficialUltracodeReminder(text: string, context?: OfficialWorkflowInputContext): string {
  if (context?.isHumanInput !== true) return text
  // The official child CLI watches its own config. This host-side adapter
  // must also observe desktop edits made after its process was started.
  resetSettingsCache()
  if (!areWorkflowsEnabled() ||
    getSettings_DEPRECATED().workflowKeywordTriggerEnabled === false ||
    !hasWorkflowKeyword(context.humanText ?? text)) return text
  return `${text}\n\n<system-reminder>\n${WORKFLOW_KEYWORD_REMINDER}\nUse mcp__cc_haha__Workflow. This opt-in applies only to this human turn; keep the chosen model and the user's requested scope, budget and workflow size guideline. ${describeWorkflowSizeGuideline()}\n</system-reminder>`
}


export type OfficialUltracodeState = {
  enabled: boolean
  active: boolean
  available: boolean
  reason?: 'workflows-disabled' | 'model' | 'session'
  model?: string
  effort?: string
  envOverride?: string
}

/**
 * The native /effort ultracode flag belongs to the running conversation, never
 * user settings or a resumed transcript. The SDK adapter keeps the same scope.
 */
export function createOfficialUltracodeController(deps: {
  getModel(): string | undefined
  getEffort(): string | undefined
  env: NodeJS.ProcessEnv
  eligible: boolean
  applySettings(settings: { ultracode: boolean; effortLevel?: 'xhigh' }): Promise<void>
  /** Bundled SDK exposes this read-only method; older runtimes use ack state. */
  readSettings?(): Promise<unknown>
}) {
  let enabled = false
  let announced = false
  let nativeState: { model?: string; effort?: string; requested: boolean; active: boolean; available: boolean; envOverride?: string } | undefined
  // Serialize control writes so a slow enable cannot overwrite a later disable.
  let writes: Promise<unknown> = Promise.resolve()
  const getModel = () => {
    const selected = deps.getModel() || deps.env.ANTHROPIC_MODEL
    if (!selected) return undefined
    const alias = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(selected)
    return alias ? deps.env[`ANTHROPIC_DEFAULT_${alias[1]!.toUpperCase()}_MODEL`] || selected : selected
  }
  const getState = (): OfficialUltracodeState => {
    resetSettingsCache()
    const model = nativeState?.model ?? getModel()
    const configuredEnv = getSettings_DEPRECATED().env
    const rawOverride = configuredEnv?.CLAUDE_CODE_EFFORT_LEVEL ?? deps.env.CLAUDE_CODE_EFFORT_LEVEL
    const envOverride = typeof rawOverride === 'string' && /^(low|medium|high|xhigh|max|auto|unset|[0-9]+)$/i.test(rawOverride)
      ? rawOverride.toLowerCase() : undefined
    const workflowsDisabled = /^(1|true|yes|on)$/i.test(deps.env.CLAUDE_CODE_DISABLE_WORKFLOWS ?? '') || !areWorkflowsEnabled()
    // Official API model IDs, including provider aliases, follow the same native
    // xhigh catalog. Never reinterpret an older model or switch it implicitly.
    const capable = nativeState?.available ?? Boolean(model && /(?:opus-(?:4-7|4-8|5)|sonnet-5|haiku-5|fable-5|mythos-5)/i.test(model))
    const reason = !deps.eligible ? 'session' : workflowsDisabled ? 'workflows-disabled' : !capable ? 'model' : undefined
    return {
      enabled: nativeState?.requested ?? enabled, active: (nativeState?.active ?? enabled) && !reason, available: !reason,
      ...(reason ? { reason } : {}), ...(model ? { model } : {}),
      ...((nativeState ? nativeState.effort : deps.getEffort()) ? { effort: nativeState ? nativeState.effort : deps.getEffort() } : {}),
      ...((nativeState?.envOverride ?? envOverride) ? { envOverride: nativeState?.envOverride ?? envOverride } : {}),
    }
  }
  const refreshState = async (): Promise<OfficialUltracodeState> => {
    if (!deps.readSettings) return getState()
    const result = await deps.readSettings()
    if (!result || typeof result !== 'object') throw new Error('Native Ultracode state is unavailable')
    const applied = (result as Record<string, unknown>).applied
    if (!applied || typeof applied !== 'object') throw new Error('Native Ultracode state is unavailable')
    const values = applied as Record<string, unknown>
    if (typeof values.ultracode !== 'boolean' || typeof values.ultracodeRequested !== 'boolean' || typeof values.ultracodeAvailable !== 'boolean') {
      throw new Error('This native runtime does not expose Ultracode state')
    }
    const effective = (result as { effective?: { env?: Record<string, unknown> } }).effective
    const override = effective?.env?.CLAUDE_CODE_EFFORT_LEVEL
    nativeState = {
      requested: values.ultracodeRequested, active: values.ultracode, available: values.ultracodeAvailable,
      ...(typeof values.model === 'string' ? { model: values.model } : {}),
      ...(typeof values.effort === 'string' ? { effort: values.effort } : {}),
      ...(typeof override === 'string' && /^(low|medium|high|xhigh|max|auto|unset|[0-9]+)$/i.test(override) ? { envOverride: override } : {}),
    }
    enabled = nativeState.requested
    return getState()
  }
  return {
    getState,
    refreshState,
    setEnabled(value: boolean): Promise<OfficialUltracodeState> {
      const next = writes.then(async () => {
        const state = await refreshState()
        if (value && !state.available) {
          const message = state.reason === 'workflows-disabled'
            ? 'Ultracode needs dynamic workflows enabled in Settings.'
            : state.reason === 'model'
              ? `Ultracode is not supported by ${state.model ?? 'this model'}. Choose a compatible model.`
              : 'Ultracode is available only in a full main conversation.'
          throw new Error(message)
        }
        await deps.applySettings({ ultracode: value })
        enabled = value
        return refreshState()
      })
      writes = next.catch(() => undefined)
      return next
    },
    // The native runtime clears the flag only when the effort actually moves.
    // Reapplying the same effort is a no-op, not another opt-in or opt-out.
    onEffortChanged(previous: string | undefined, next: string | undefined) {
      if (previous !== next) { enabled = false; nativeState = undefined }
    },
    transformPrompt(text: string, context?: OfficialWorkflowInputContext): string {
      if (context?.isHumanInput !== true) return text
      const active = getState().active
      let reminder: string | undefined
      if (active) reminder = announced ? ULTRACODE_STILL_ON_REMINDER : ULTRACODE_ENTER_REMINDER
      else if (announced) reminder = ULTRACODE_EXIT_REMINDER
      announced = active
      if (!reminder) return text
      return `${text}\n\n<system-reminder>\n${reminder}\nUse mcp__cc_haha__Workflow. Keep the chosen model and obey the human's explicit scope, agent-count limits and spending budget. This standing mode applies to substantive human tasks in this running conversation; it does not authorize new teams, schedules, or unrelated work. ${describeWorkflowSizeGuideline()}\n</system-reminder>`
    },
  }
}
