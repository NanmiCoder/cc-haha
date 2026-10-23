import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openPage } = vi.hoisted(() => ({ openPage: vi.fn() }))
vi.mock('@/lib/desktopHost', async () => {
  const actual = await vi.importActual<typeof import('@/lib/desktopHost')>('@/lib/desktopHost')
  return { ...actual, getDesktopHost: () => ({ ...actual.getDesktopHost(), shell: { ...actual.getDesktopHost().shell, open: openPage } }) }
})
vi.mock('@/api/websocket', () => ({ wsManager: { connect: vi.fn(), disconnect: vi.fn(), onConnectionState: vi.fn(() => () => {}), onMessage: vi.fn(() => () => {}), clearHandlers: vi.fn(), send: vi.fn() } }))

import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTabStore } from '@/stores/tabStore'
import { PermissionDialog } from '@/components/chat/PermissionDialog'
import { MobileApprovalDock } from '@/components/chat/MobileApprovalDock'
import { OFFICIAL_SDK_DIALOG_TOOL, parseElicitationFields, type OfficialSdkDialog } from '../../../../src/shared/officialAgentSdkDialogs'

const respond = vi.fn()
const sessionId = 'sdk-dialog-session'
const requestId = 'sdk-dialog-request'
const form: OfficialSdkDialog = { sdkDialog: true, kind: 'elicitation', title: 'Fixture MCP', serverName: 'fixture', message: 'Choose where to save.', mode: 'form', fields: parseElicitationFields({ type: 'object', properties: {
  project: { type: 'string', title: 'Project', minLength: 2 }, count: { type: 'integer', title: 'Count', minimum: 1, maximum: 3 }, consent: { type: 'boolean', title: 'Share' },
  role: { type: 'string', title: 'Role', enum: ['reader', 'writer'], enumNames: ['Reader', 'Writer'] }, scopes: { type: 'array', title: 'Scopes', items: { enum: ['read', 'write'] }, minItems: 1 },
}, required: ['project', 'count', 'consent', 'role', 'scopes'] }) }
const url: OfficialSdkDialog = { sdkDialog: true, kind: 'elicitation', mode: 'url', title: 'Authorize fixture', message: 'Authorize in your browser.', serverName: 'auth', url: 'https://example.test/auth?state=fixture' }

function seed(dialog: OfficialSdkDialog, pending = true) {
  const permission = { requestId, toolName: OFFICIAL_SDK_DIALOG_TOOL, input: dialog }
  useChatStore.setState({ respondToPermission: respond, sessions: { [sessionId]: { messages: [], chatState: pending ? 'permission_pending' : 'idle', connectionState: 'connected', pendingPermissions: pending ? { [requestId]: permission } : {}, pendingPermission: pending ? permission : null } } } as never)
}
function card(dialog: OfficialSdkDialog) {
  seed(dialog)
  return render(<PermissionDialog sessionId={sessionId} requestId={requestId} toolName={OFFICIAL_SDK_DIALOG_TOOL} input={dialog} />)
}
describe('official SDK interactive dialogs', () => {
  beforeEach(() => { respond.mockReset(); openPage.mockReset().mockResolvedValue(undefined); useSettingsStore.setState({ locale: 'en' }); useTabStore.setState({ activeTabId: sessionId, tabs: [] }) })
  it('renders typed MCP fields and validates them before sending a one-time answer', () => {
    card(form)
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Check the required fields')
    fireEvent.change(screen.getByLabelText(/^Project\s*\*/), { target: { value: 'Example' } })
    fireEvent.change(screen.getByLabelText(/^Count\s*\*/), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Share *'), { target: { value: 'false' } })
    fireEvent.change(screen.getByLabelText('Role *'), { target: { value: JSON.stringify('reader') } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).toHaveBeenCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { action: 'accept', content: { project: 'Example', count: 2, consent: false, role: 'reader', scopes: ['read'] } } } })
    expect(screen.queryByRole('button', { name: 'Allow for session' })).not.toBeInTheDocument()
  })
  it('opens an authorization URL only on a click and requires a separate completion action', async () => {
    card(url)
    const completed = screen.getByRole('button', { name: 'I have completed this step' })
    expect(completed).toBeDisabled()
    expect(openPage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open page' }))
    await waitFor(() => expect(completed).toBeEnabled())
    expect(openPage).toHaveBeenCalledWith(url.url)
    expect(respond).not.toHaveBeenCalled()
    fireEvent.click(completed)
    expect(respond).toHaveBeenCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { action: 'accept', openedUrl: url.url } } })
  })
  it('keeps failed or unsafe browser requests unapproved and supports decline/cancel', async () => {
    openPage.mockRejectedValueOnce(new Error('fixture failure'))
    card(url)
    fireEvent.click(screen.getByRole('button', { name: 'Open page' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not open'))
    expect(screen.getByRole('button', { name: 'I have completed this step' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(respond).toHaveBeenLastCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { action: 'decline' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(respond).toHaveBeenLastCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { action: 'cancel' } } })
  })
  it('reconnect snapshot restores the form, and resolution hides all entered form values', () => {
    const view = card(form)
    fireEvent.change(screen.getByLabelText(/^Project\s*\*/), { target: { value: 'private-fixture-value' } })
    act(() => seed(form, false))
    expect(screen.queryByDisplayValue('private-fixture-value')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    act(() => seed(form))
    view.rerender(<PermissionDialog sessionId={sessionId} requestId={requestId} toolName={OFFICIAL_SDK_DIALOG_TOOL} input={form} />)
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
  })
  it('mobile dock opens the full dialog without generic allow or persistent approval shortcuts', () => {
    seed(form)
    render(<MobileApprovalDock sessionId={sessionId} />)
    const dock = screen.getByTestId('mobile-approval-dock')
    expect(dock).toHaveAttribute('data-kind', 'dialog')
    expect(within(dock).queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    expect(within(dock).queryByRole('button', { name: 'Allow for session' })).not.toBeInTheDocument()
    fireEvent.click(within(dock).getByRole('button', { name: 'View details' }))
    expect(within(screen.getByTestId('mobile-approval-sheet')).getByLabelText(/^Project\s*\*/)).toBeInTheDocument()
  })
  it('unsupported schemas remain reviewable but cannot be submitted', () => {
    card({ ...form, fields: undefined, unsupportedSchema: true })
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be displayed safely')
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
  })
})

const refusal: OfficialSdkDialog = { sdkDialog: true, kind: 'choice', nativeKind: 'refusal_fallback_prompt', title: 'Model response paused', message: 'Review the request.',
  refusal: { originalModel: 'fixture-original', fallbackModel: 'fixture-fallback', retractedMessageUuids: ['fixture-partial'] },
  choices: [{ value: 'retry_fallback', label: 'fixture-fallback' }, { value: 'edit_prompt', label: 'sdkDialog.editPrompt' }, { value: 'cancelled', label: 'sdkDialog.stop' }] }

describe('native special dialog choices', () => {
  beforeEach(() => { respond.mockReset(); openPage.mockReset(); useSettingsStore.setState({ locale: 'en' }); useTabStore.setState({ activeTabId: sessionId, tabs: [] }) })
  it.each([['Retry with fixture-fallback', 'retry_fallback'], ['Edit my request', 'edit_prompt'], ['Stop', 'cancelled']])('requires the explicit %s action and does not expose generic approval', (label, choice) => {
    card(refusal)
    expect(screen.getByText(/fixture-original could not complete/)).toHaveTextContent('fixture-fallback')
    expect(respond).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(respond).toHaveBeenCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { choice } } })
  })
  it('retirement hides refusal choices and mobile reconnect can still answer the original pending request', () => {
    seed(refusal)
    render(<MobileApprovalDock sessionId={sessionId} />)
    fireEvent.click(within(screen.getByTestId('mobile-approval-dock')).getByRole('button', { name: 'View details' }))
    const sheet = screen.getByTestId('mobile-approval-sheet')
    expect(within(sheet).getByRole('button', { name: 'Edit my request' })).toBeInTheDocument()
    act(() => seed(refusal, false))
    expect(screen.queryByRole('button', { name: 'Edit my request' })).not.toBeInTheDocument()
    expect(respond).not.toHaveBeenCalled()
  })
  it('shows separate usage credit consent with balance, enablement and switch choice', () => {
    card({ sdkDialog: true, kind: 'choice', nativeKind: 'fable_overage_consent_prompt', title: 'Credits', message: '',
      creditConsent: { modelName: 'Fable 5', overagesEnabled: false, balanceCents: 8733, currency: 'USD' },
      choices: [{ value: 'consent', label: 'sdkDialog.useCredits' }, { value: 'switch_default', label: 'sdkDialog.switchDefault' }, { value: 'cancelled', label: 'sdkDialog.cancel' }] })
    expect(screen.getByText(/Fable 5 uses usage credits/)).toBeInTheDocument()
    expect(screen.getByText(/87.33/)).toBeInTheDocument()
    expect(screen.getByText(/Usage credits are not enabled/)).toBeInTheDocument()
    expect(respond).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to the default model' }))
    expect(respond).toHaveBeenCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { choice: 'switch_default' } } })
  })
  it('submits schema-permitted empty strings and an empty required selection without dropping fields', () => {
    card({ ...form, fields: parseElicitationFields({ type: 'object', properties: {
      empty: { type: 'string', title: 'Empty allowed' }, explicit: { type: 'string', title: 'Clear optional', default: 'initial' },
      scopes: { type: 'array', title: 'Empty selection', items: { enum: ['read'] } },
    }, required: ['empty', 'scopes'] }) })
    fireEvent.change(screen.getByLabelText('Clear optional'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).toHaveBeenCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { action: 'accept', content: { empty: '', explicit: '', scopes: [] } } } })
  })
})

it('distinguishes an empty enum value from the unanswered placeholder', () => {
  respond.mockReset()
  card({ ...form, fields: parseElicitationFields({ type: 'object', properties: {
    scope: { type: 'string', title: 'Scope', oneOf: [{ const: '', title: 'No scope' }, { const: 'read', title: 'Read' }] },
  }, required: ['scope'] }) })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(respond).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Scope *'), { target: { value: JSON.stringify('') } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(respond).toHaveBeenCalledWith(sessionId, requestId, true, { updatedInput: { sdkDialogResult: { action: 'accept', content: { scope: '' } } } })
})
