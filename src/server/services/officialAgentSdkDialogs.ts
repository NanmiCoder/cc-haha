import type { CanUseTool, ElicitationRequest, OnElicitation, OnUserDialog, Options } from '@anthropic-ai/claude-agent-sdk/core'
import { isDialogRecord, OFFICIAL_SDK_DIALOG_TOOL, parseElicitationFields, safeDialogUrl, validElicitationContent, type OfficialSdkDialog, type OfficialSdkRefusalResolution } from '../../shared/officialAgentSdkDialogs.js'

/** Known native dialog contracts verified against the bundled official runtime. */
export const officialSdkSupportedDialogKinds = [
  'mcp_elicitation', 'mcp_elicitation_waiting', 'auto_mode_server_fallback', 'auto_mode_outside_reads',
  'refusal_fallback_prompt', 'fable_overage_consent_prompt',
]

/** Reuse the host's pending-permission queue: reconnect, stop and worker routing already live there. */
export function createOfficialAgentSdkDialogs(canUseTool: CanUseTool, callbacks: {
  /** Resolve/retire only: the host must suppress this during process teardown. */
  onRefusalResolved?(resolution: OfficialSdkRefusalResolution): void | Promise<void>
} = {}): Pick<Options, 'onElicitation' | 'onUserDialog' | 'supportedDialogKinds'> {
  async function ask(dialog: OfficialSdkDialog, options: { signal: AbortSignal; requestId: string }): Promise<Record<string, unknown>> {
    const answer = await canUseTool(OFFICIAL_SDK_DIALOG_TOOL, dialog as unknown as Record<string, unknown>, {
      ...options, toolUseID: options.requestId, suppressAlwaysAllowRule: true, defaultToNo: true,
      title: dialog.title, displayName: dialog.serverName ?? dialog.title,
    }).catch(error => {
      if (options.signal.aborted) return { behavior: 'deny' as const, message: 'Dialog retired', interrupt: true }
      throw error
    })
    if (options.signal.aborted) return { action: 'cancel' }
    if (!answer || answer.behavior !== 'allow') return { action: answer?.behavior === 'deny' && !answer.interrupt ? 'decline' : 'cancel' }
    // No implicit acceptance: generic permission buttons and stale/older renderers
    // cannot authorize a form, browser flow or a native settings change.
    return isDialogRecord(answer.updatedInput?.sdkDialogResult) ? answer.updatedInput.sdkDialogResult : { action: 'cancel' }
  }

  const onElicitation: OnElicitation = async (request, options) => {
    if (options.signal.aborted) return { action: 'cancel' }
    const mode = request.mode ?? 'form'
    const fields = mode === 'form' ? parseElicitationFields(request.requestedSchema) : undefined
    const url = mode === 'url' ? safeDialogUrl(request.url) : undefined
    const response = await ask({ sdkDialog: true, kind: 'elicitation', mode,
      title: request.title ?? request.displayName ?? request.serverName, serverName: request.serverName,
      ...(typeof request.elicitationId === 'string' ? { elicitationId: request.elicitationId } : {}),
      message: [request.description, request.message].filter(Boolean).join('\n\n'),
      ...(mode === 'form' ? { fields, unsupportedSchema: !fields } : { url, unsupportedSchema: !url }),
    }, options)
    if (response.action === 'decline' || response.action === 'cancel') return { action: response.action }
    if (response.action !== 'accept') return { action: 'cancel' }
    if (mode === 'url') return url && response.openedUrl === url ? { action: 'accept' } : { action: 'cancel' }
    return fields && validElicitationContent(fields, response.content)
      ? { action: 'accept', content: response.content }
      : { action: 'cancel' }
  }

  const onUserDialog: OnUserDialog = async (request, options) => {
    const payload = request.payload
    if (options.signal.aborted || !isDialogRecord(payload)) return { behavior: 'cancelled' }
    if (request.dialogKind === 'mcp_elicitation') {
      if (typeof payload.serverName !== 'string' || !isDialogRecord(payload.params) || typeof payload.params.message !== 'string') return { behavior: 'cancelled' }
      const params = payload.params
      return { behavior: 'completed', result: await onElicitation({ ...params, serverName: payload.serverName,
        message: params.message, requestedSchema: params.requestedSchema,
      } as ElicitationRequest, options) }
    }
    let dialog: OfficialSdkDialog
    if (request.dialogKind === 'refusal_fallback_prompt') {
      if (typeof payload.originalModel !== 'string' || !payload.originalModel || typeof payload.fallbackModel !== 'string' || !payload.fallbackModel ||
        payload.guidanceText !== undefined && typeof payload.guidanceText !== 'string' ||
        payload.apiRefusalCategory !== undefined && payload.apiRefusalCategory !== null && typeof payload.apiRefusalCategory !== 'string' ||
        payload.retractedMessageUuids !== undefined && (!Array.isArray(payload.retractedMessageUuids) || !payload.retractedMessageUuids.every(value => typeof value === 'string'))) return { behavior: 'cancelled' }
      const refusal: NonNullable<OfficialSdkDialog['refusal']> = {
        originalModel: payload.originalModel, fallbackModel: payload.fallbackModel,
        ...(payload.apiRefusalCategory !== undefined ? { apiRefusalCategory: payload.apiRefusalCategory as string | null } : {}),
        retractedMessageUuids: [...new Set(payload.retractedMessageUuids as string[] | undefined ?? [])],
      }
      dialog = { sdkDialog: true, kind: 'choice', nativeKind: 'refusal_fallback_prompt', title: 'Model response paused',
        message: typeof payload.guidanceText === 'string' ? payload.guidanceText : '', refusal,
        choices: [{ value: 'retry_fallback', label: refusal.fallbackModel }, { value: 'edit_prompt', label: 'sdkDialog.editPrompt' }, { value: 'cancelled', label: 'sdkDialog.stop' }] }
      const response = await ask(dialog, options)
      const choice = response.choice === 'retry_fallback' || response.choice === 'edit_prompt' ? response.choice : 'cancelled'
      await callbacks.onRefusalResolved?.({ ...refusal, requestId: options.requestId, choice, retired: options.signal.aborted })
      return { behavior: 'completed', result: choice }
    } else if (request.dialogKind === 'fable_overage_consent_prompt') {
      if (typeof payload.overagesEnabled !== 'boolean' || payload.modelName !== undefined && typeof payload.modelName !== 'string' ||
        payload.model !== undefined && typeof payload.model !== 'string' ||
        payload.balanceCents !== undefined && payload.balanceCents !== null && (typeof payload.balanceCents !== 'number' || !Number.isFinite(payload.balanceCents)) ||
        payload.currency !== undefined && payload.currency !== null && typeof payload.currency !== 'string') return { behavior: 'cancelled' }
      dialog = { sdkDialog: true, kind: 'choice', nativeKind: 'fable_overage_consent_prompt', title: 'Usage credits required', message: '',
        creditConsent: { overagesEnabled: payload.overagesEnabled, modelName: payload.modelName as string | undefined ?? 'Fable',
          ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
          ...(payload.balanceCents !== undefined ? { balanceCents: payload.balanceCents as number | null } : {}),
          ...(payload.currency !== undefined ? { currency: payload.currency as string | null } : {}) },
        choices: [{ value: 'consent', label: 'sdkDialog.useCredits' }, { value: 'switch_default', label: 'sdkDialog.switchDefault' }, { value: 'cancelled', label: 'sdkDialog.cancel' }] }
    } else if (request.dialogKind === 'mcp_elicitation_waiting') {
      if (typeof payload.serverName !== 'string' || !isDialogRecord(payload.params) || typeof payload.params.message !== 'string') return { behavior: 'cancelled' }
      dialog = { sdkDialog: true, kind: 'choice', nativeKind: 'mcp_elicitation_waiting', title: payload.serverName, serverName: payload.serverName,
        ...(typeof payload.params.elicitationId === 'string' ? { elicitationId: payload.params.elicitationId } : {}),
        message: payload.params.message, url: safeDialogUrl(payload.params.url),
        choices: [{ value: 'retry', label: 'sdkDialog.retry' }, { value: 'dismiss', label: 'sdkDialog.completed' }] }
    } else if (request.dialogKind === 'auto_mode_server_fallback') {
      if (typeof payload.title !== 'string' || !Array.isArray(payload.paragraphs) || !payload.paragraphs.every(value => typeof value === 'string')) return { behavior: 'cancelled' }
      dialog = { sdkDialog: true, kind: 'choice', title: payload.title, message: payload.paragraphs.join('\n\n'), url: safeDialogUrl(payload.helpUrl),
        choices: [{ value: 'continue', label: 'sdkDialog.continue' }, { value: 'interrupt', label: 'sdkDialog.interrupt' }] }
    } else if (request.dialogKind === 'auto_mode_outside_reads') {
      const values = ['allow', 'block', 'ask_again', 'allow_once']
      if (typeof payload.title !== 'string' || typeof payload.question !== 'string' || typeof payload.explainer !== 'string' || typeof payload.path !== 'string' ||
        !Array.isArray(payload.options) || !payload.options.length || payload.options.some(option => !isDialogRecord(option) || !values.includes(String(option.value)) || typeof option.label !== 'string')) return { behavior: 'cancelled' }
      dialog = { sdkDialog: true, kind: 'choice', title: payload.title, message: [payload.path, payload.question, payload.explainer].join('\n\n'),
        choices: payload.options as Array<{ value: string; label: string }> }
    } else return { behavior: 'cancelled' }
    const response = await ask(dialog, options)
    return typeof response.choice === 'string' && dialog.choices?.some(choice => choice.value === response.choice)
      ? { behavior: 'completed', result: response.choice }
      : { behavior: 'cancelled' }
  }
  return { onElicitation, onUserDialog, supportedDialogKinds: [...officialSdkSupportedDialogKinds] }
}
