import { describe, expect, mock, test } from 'bun:test'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk/core'
import { createOfficialAgentSdkDialogs, officialSdkSupportedDialogKinds } from './officialAgentSdkDialogs.js'
import { OFFICIAL_SDK_DIALOG_TOOL } from '../../shared/officialAgentSdkDialogs.js'

const options = () => ({ requestId: crypto.randomUUID(), signal: new AbortController().signal })
const form = { serverName: 'fixture', message: 'Choose a project', requestedSchema: { type: 'object', properties: { project: { type: 'string', enum: ['one', 'two'] }, consent: { type: 'boolean' } }, required: ['project', 'consent'] } }
function harness(response: PermissionResult) {
  const ask = mock(async () => response)
  return { ask, ...createOfficialAgentSdkDialogs(ask as CanUseTool) }
}
function accepted(result: unknown): PermissionResult { return { behavior: 'allow', updatedInput: { sdkDialogResult: result } } }

describe('official SDK blocking dialogs', () => {
  test('passes original request identity and cancellation signal through existing reconnectable permission queue', async () => {
    const h = harness(accepted({ action: 'accept', content: { project: 'one', consent: false } }))
    const request = options()
    expect(await h.onElicitation!(form, request)).toEqual({ action: 'accept', content: { project: 'one', consent: false } })
    expect(h.ask).toHaveBeenCalledWith(OFFICIAL_SDK_DIALOG_TOOL, expect.objectContaining({ sdkDialog: true, kind: 'elicitation', serverName: 'fixture' }), expect.objectContaining({ ...request, suppressAlwaysAllowRule: true, defaultToNo: true }))
  })
  test('never accepts generic allow, malformed forms, persistent grants or guessed URL completion', async () => {
    for (const response of [{ behavior: 'allow', updatedInput: {} }, accepted({ action: 'accept', content: { project: 'admin', consent: true } }), accepted({ action: 'accept', content: { project: 'one', consent: 'true' } })] as PermissionResult[]) {
      expect(await harness(response).onElicitation!(form, options())).toEqual({ action: 'cancel' })
    }
    const request = { serverName: 'auth', message: 'Authorize', mode: 'url' as const, url: 'https://example.test/auth' }
    expect(await harness(accepted({ action: 'accept' })).onElicitation!(request, options())).toEqual({ action: 'cancel' })
    expect(await harness(accepted({ action: 'accept', openedUrl: request.url })).onElicitation!(request, options())).toEqual({ action: 'accept' })
    expect(await harness(accepted({ action: 'accept', openedUrl: 'file:///tmp/a' })).onElicitation!({ ...request, url: 'file:///tmp/a' }, options())).toEqual({ action: 'cancel' })
  })
  test('supports decline, stop cancellation, aborted-before-display and unknown native kinds', async () => {
    expect(await harness({ behavior: 'deny', message: 'No' }).onElicitation!(form, options())).toEqual({ action: 'decline' })
    const h = harness({ behavior: 'deny', message: 'Stopped', interrupt: true })
    expect(await h.onElicitation!(form, options())).toEqual({ action: 'cancel' })
    const aborted = AbortSignal.abort()
    h.ask.mockClear()
    expect(await h.onElicitation!(form, { ...options(), signal: aborted })).toEqual({ action: 'cancel' })
    expect(await h.onUserDialog!({ dialogKind: 'future-kind', payload: {} }, options())).toEqual({ behavior: 'cancelled' })
    expect(h.ask).not.toHaveBeenCalled()
  })
  test('keeps URL elicitation identity through the initial and waiting dialogs', async () => {
    const h = harness(accepted({ choice: 'retry' }))
    const params = { mode: 'url' as const, message: 'Authorize', url: 'https://example.test/auth', elicitationId: 'auth-flow' }
    await h.onElicitation!({ ...params, serverName: 'fixture' }, options())
    expect(h.ask).toHaveBeenLastCalledWith(OFFICIAL_SDK_DIALOG_TOOL, expect.objectContaining({
      serverName: 'fixture', elicitationId: 'auth-flow', kind: 'elicitation',
    }), expect.anything())
    await h.onUserDialog!({ dialogKind: 'mcp_elicitation_waiting', payload: { serverName: 'fixture', params } }, options())
    expect(h.ask).toHaveBeenLastCalledWith(OFFICIAL_SDK_DIALOG_TOOL, expect.objectContaining({
      serverName: 'fixture', elicitationId: 'auth-flow', kind: 'choice', nativeKind: 'mcp_elicitation_waiting',
    }), expect.anything())
  })
  test('renders native MCP dialogs and only explicitly reviewed billing/read-scope choices', async () => {
    const formAnswer = { action: 'accept', content: { project: 'two', consent: true } }
    expect(await harness(accepted(formAnswer)).onUserDialog!({ dialogKind: 'mcp_elicitation', payload: { serverName: form.serverName, params: form } }, options())).toEqual({ behavior: 'completed', result: formAnswer })
    const billing = { dialogKind: 'auto_mode_server_fallback', payload: { title: 'Classifier usage', paragraphs: ['This changes billing.'], helpUrl: 'https://example.test/help' } }
    expect(await harness(accepted({ choice: 'continue' })).onUserDialog!(billing, options())).toEqual({ behavior: 'completed', result: 'continue' })
    expect(await harness(accepted({ choice: 'allow' })).onUserDialog!(billing, options())).toEqual({ behavior: 'cancelled' })
    const outside = { dialogKind: 'auto_mode_outside_reads', payload: { title: 'Read outside project', question: 'Allow?', explainer: 'Applies to future projects.', path: '/fixture/other', options: [{ value: 'allow_once', label: 'Allow once' }, { value: 'block', label: 'Block future reads' }] } }
    expect(await harness(accepted({ choice: 'allow_once' })).onUserDialog!(outside, options())).toEqual({ behavior: 'completed', result: 'allow_once' })
    expect(await harness(accepted({ choice: 'allow' })).onUserDialog!(outside, options())).toEqual({ behavior: 'cancelled' })
    expect(officialSdkSupportedDialogKinds).not.toContain('future-kind')
  })
})

const refusal = { dialogKind: 'refusal_fallback_prompt', payload: {
  originalModel: 'claude-fixture-primary', fallbackModel: 'claude-fixture-fallback', apiRefusalCategory: 'fixture',
  guidanceText: 'Review your request before continuing.', retractedMessageUuids: ['partial-1', 'partial-2', 'partial-1'],
} }
describe('native refusal resolution contract', () => {
  test.each(['retry_fallback', 'edit_prompt', 'cancelled'] as const)('returns the exact native %s choice and retracts only after an answer', async choice => {
    let release!: (value: PermissionResult) => void
    const asked = mock(() => new Promise<PermissionResult>(resolve => { release = resolve }))
    const resolved = mock(() => {})
    const h = createOfficialAgentSdkDialogs(asked as CanUseTool, { onRefusalResolved: resolved })
    const opts = options()
    const result = h.onUserDialog!(refusal, opts)
    expect(asked).toHaveBeenCalledWith(OFFICIAL_SDK_DIALOG_TOOL, expect.objectContaining({ nativeKind: 'refusal_fallback_prompt', refusal: expect.objectContaining({ retractedMessageUuids: ['partial-1', 'partial-2'] }), choices: expect.arrayContaining([{ value: 'edit_prompt', label: 'sdkDialog.editPrompt' }]) }), expect.objectContaining({ suppressAlwaysAllowRule: true, defaultToNo: true }))
    expect(resolved).not.toHaveBeenCalled()
    release(accepted({ choice }))
    expect(await result).toEqual({ behavior: 'completed', result: choice })
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(resolved).toHaveBeenCalledWith({ requestId: opts.requestId, choice, retired: false,
      originalModel: refusal.payload.originalModel, fallbackModel: refusal.payload.fallbackModel, apiRefusalCategory: 'fixture', retractedMessageUuids: ['partial-1', 'partial-2'] })
  })
  test('native retirement retracts once and ignores a late affirmative answer', async () => {
    const abort = new AbortController()
    const resolved = mock(() => {})
    let release!: (value: PermissionResult) => void
    const h = createOfficialAgentSdkDialogs((() => new Promise<PermissionResult>(resolve => { release = resolve })) as CanUseTool, { onRefusalResolved: resolved })
    const result = h.onUserDialog!(refusal, { ...options(), signal: abort.signal })
    abort.abort()
    release(accepted({ choice: 'retry_fallback' }))
    expect(await result).toEqual({ behavior: 'completed', result: 'cancelled' })
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ choice: 'cancelled', retired: true }))
  })
  test('abort rejection resolves safely, while an invalid payload never opens or retracts anything', async () => {
    const abort = new AbortController()
    const resolved = mock(() => {})
    const h = createOfficialAgentSdkDialogs((async () => { abort.abort(); throw new DOMException('Retired', 'AbortError') }) as CanUseTool, { onRefusalResolved: resolved })
    expect(await h.onUserDialog!(refusal, { ...options(), signal: abort.signal })).toEqual({ behavior: 'completed', result: 'cancelled' })
    expect(resolved).toHaveBeenCalledTimes(1)
    resolved.mockClear()
    const bad = createOfficialAgentSdkDialogs(mock(async () => accepted({ choice: 'retry_fallback' })) as CanUseTool, { onRefusalResolved: resolved })
    for (const patch of [{ originalModel: 1 }, { fallbackModel: '' }, { guidanceText: {} }, { retractedMessageUuids: [4] }, { apiRefusalCategory: {} }]) {
      expect(await bad.onUserDialog!({ ...refusal, payload: { ...refusal.payload, ...patch } }, options())).toEqual({ behavior: 'cancelled' })
    }
    expect(resolved).not.toHaveBeenCalled()
  })
  test('generic approval, unknown choices and deny stop without silently switching models', async () => {
    for (const answer of [{ behavior: 'allow', updatedInput: {} }, accepted({ choice: 'allow' }), { behavior: 'deny', message: 'No' }] as PermissionResult[]) {
      const resolved = mock(() => {})
      const h = createOfficialAgentSdkDialogs((async () => answer) as CanUseTool, { onRefusalResolved: resolved })
      expect(await h.onUserDialog!(refusal, options())).toEqual({ behavior: 'completed', result: 'cancelled' })
      expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ choice: 'cancelled' }))
    }
  })
})

describe('native usage credit consent', () => {
  test.each(['consent', 'switch_default', 'cancelled'])('discloses usage credit state and returns only the explicit %s choice', async choice => {
    const h = harness(accepted({ choice }))
    expect(await h.onUserDialog!({ dialogKind: 'fable_overage_consent_prompt', payload: { model: 'claude-fixture-fable', modelName: 'Fable 5', overagesEnabled: false, balanceCents: 8733, currency: 'USD' } }, options())).toEqual({ behavior: 'completed', result: choice })
    expect(h.ask).toHaveBeenCalledWith(OFFICIAL_SDK_DIALOG_TOOL, expect.objectContaining({ nativeKind: 'fable_overage_consent_prompt', creditConsent: { model: 'claude-fixture-fable', modelName: 'Fable 5', overagesEnabled: false, balanceCents: 8733, currency: 'USD' } }), expect.objectContaining({ suppressAlwaysAllowRule: true, defaultToNo: true }))
  })
  test('malformed billing payloads and generic approval cannot consent', async () => {
    const h = harness({ behavior: 'allow', updatedInput: {} })
    expect(await h.onUserDialog!({ dialogKind: 'fable_overage_consent_prompt', payload: { overagesEnabled: true } }, options())).toEqual({ behavior: 'cancelled' })
    for (const patch of [{ overagesEnabled: 'true' }, { modelName: {} }, { balanceCents: Infinity }, { currency: {} }]) {
      expect(await h.onUserDialog!({ dialogKind: 'fable_overage_consent_prompt', payload: { overagesEnabled: true, ...patch } }, options())).toEqual({ behavior: 'cancelled' })
    }
    expect(h.ask).toHaveBeenCalledTimes(1)
    expect(officialSdkSupportedDialogKinds).toContain('refusal_fallback_prompt')
    expect(officialSdkSupportedDialogKinds).toContain('fable_overage_consent_prompt')
  })
})
