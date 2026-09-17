import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHostWorkbenchHarness } from '../../../test/hostWorkbenchHarness'
import { HostsWorkspace } from '../ui/HostsWorkspace'
import { useHostManagementStore } from '../stores/hostManagementStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { t } from '../../../i18n'
import { ELECTRON_IPC_CHANNELS } from '../../../../electron/ipc/channels'

const SECRET = 'M2_DOM_FIXTURE_SECRET_ONLY'
let fixture: Awaited<ReturnType<typeof createHostWorkbenchHarness>>
beforeEach(async () => {
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  fixture = await createHostWorkbenchHarness()
})
afterEach(async () => {
  cleanup()
  await fixture?.dispose()
})

async function openWorkspace() {
  const view = render(<HostsWorkspace />)
  await waitFor(() => expect(useHostManagementStore.getState().capabilities).not.toBeNull())
  await waitFor(() => expect(useHostManagementStore.getState().loading).toBe(false))
  return view
}
function fill(dialog: HTMLElement, id: string, value: string) {
  const input = dialog.querySelector(`#${id}`)
  if (!input) throw new Error(`Fixture input not found: ${id}`)
  fireEvent.change(input, { target: { value } })
}
async function newHost(name = 'DOM fixture host', temporary = false) {
  fireEvent.click(screen.getByRole('button', { name: t('common.add') }))
  const dialog = await screen.findByRole('dialog', { name: t('managedResources.newHost') })
  fill(dialog, 'host-name-input', name)
  fill(dialog, 'host-address-input', 'fixture.invalid')
  fill(dialog, 'host-password-input', SECRET)
  if (temporary) fireEvent.click(within(dialog).getByDisplayValue('temporary'))
  return dialog
}
async function saveDialog(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
}
function selectHost(name = 'DOM fixture host') {
  const card = screen.getAllByRole('button').find(button => button.getAttribute('role') === 'button' && button.textContent?.includes(name))
  if (!card) throw new Error('Host card missing')
  fireEvent.click(card)
}
async function openApplication() {
  fireEvent.click(screen.getByTestId('host-applications-tab'))
  fireEvent.click(screen.getByRole('button', { name: t('managedResources.newApplication') }))
  const dialog = await screen.findByRole('dialog', { name: t('managedResources.newApplication') })
  fill(dialog, 'app-name-input', 'DOM fixture application')
  return dialog
}
async function addAccount(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: t('managedResources.m2.addAccount') }))
  fill(dialog, 'new-account-label', 'Fixture account')
  fill(dialog, 'new-account-username', 'fixture-user')
  fill(dialog, 'new-account-password', SECRET)
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.add') }))
  expect(within(dialog).getByText(t('managedResources.m2.pendingPassword'))).toBeInTheDocument()
}

// No business module/store action is mocked. Only the native transport, dialog
// and safeStorage boundaries are fixtures; all persistence uses real temp files.
describe('M2 real DOM -> store -> DesktopHost -> IPC -> repository', () => {
  it('creates a host and two inline tags, keeps it selected, and reloads durable data', async () => {
    const view = await openWorkspace()
    const dialog = await newHost()
    for (const name of ['Fixture A', 'Fixture B']) {
      fill(dialog, 'host-new-tag', name)
      fireEvent.click(within(dialog).getByRole('button', { name: t('managedResources.addTag') }))
      await waitFor(() => expect(within(dialog).getByRole('button', { name, pressed: true })).toBeInTheDocument())
    }
    expect(JSON.stringify(useHostManagementStore.getState())).not.toContain(SECRET)
    await saveDialog(dialog)
    const doc = await fixture.document()
    expect(doc.hosts).toHaveLength(1)
    expect(doc.tags).toHaveLength(2)
    expect(doc.hosts[0]!.tagIds).toHaveLength(2)
    expect(doc.credentials).toHaveLength(1)
    expect(doc.hosts[0]!.auth.credentialId).toBe(doc.credentials[0]!.id)
    expect(useHostManagementStore.getState().selectedHostId).toBe(doc.hosts[0]!.id)
    expect(await fs.readFile(fixture.services.store.filePath, 'utf8')).not.toContain(SECRET)
    view.unmount()
    useHostManagementStore.setState(useHostManagementStore.getInitialState(), true)
    await openWorkspace()
    await waitFor(() => expect(useHostManagementStore.getState().hosts).toHaveLength(1))
    expect(useHostManagementStore.getState().hosts[0]!.tagIds).toEqual(doc.hosts[0]!.tagIds)
  })

  it('binds temporary credentials to the new id even for identical names and addresses', async () => {
    await openWorkspace()
    await saveDialog(await newHost('Duplicate fixture', true))
    await saveDialog(await newHost('Duplicate fixture', true))
    const doc = await fixture.document()
    expect(doc.hosts).toHaveLength(2)
    expect(doc.hosts[0]!.id).not.toBe(doc.hosts[1]!.id)
    expect(doc.credentials).toHaveLength(0)
    for (const host of doc.hosts) {
      expect(fixture.services.temporaryCredentials.resolveLatestForOwnerHost({ ownerId: 'window:99', hostId: host.id })).toMatchObject({ status: 'resolved', payload: { password: SECRET } })
    }
  })

  it('shows vault failure without partial save and permits retry in temporary mode', async () => {
    await fixture.dispose()
    fixture = await createHostWorkbenchHarness({ vaultAvailable: false })
    await openWorkspace()
    const dialog = await newHost()
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(t('managedResources.vaultUnavailableNotice')))
    expect((await fixture.document()).hosts).toHaveLength(0)
    expect((await fixture.document()).credentials).toHaveLength(0)
    fireEvent.click(within(dialog).getByDisplayValue('temporary'))
    await saveDialog(dialog)
    expect((await fixture.document()).hosts).toHaveLength(1)
  })

  it('switches authentication type with a matching new credential and no orphan', async () => {
    await openWorkspace()
    await saveDialog(await newHost())
    selectHost()
    fireEvent.click(screen.getByRole('button', { name: t('managedResources.editHost') }))
    const dialog = await screen.findByRole('dialog', { name: t('managedResources.editHost') })
    fireEvent.click(within(dialog).getByDisplayValue('privateKey'))
    expect(within(dialog).queryByText(t('managedResources.keepExistingCredential'))).not.toBeInTheDocument()
    fill(dialog, 'host-private-key-input', '-----BEGIN OPENSSH PRIVATE KEY-----\nM2_FIXTURE_NOT_A_REAL_KEY\n-----END OPENSSH PRIVATE KEY-----')
    await saveDialog(dialog)
    const doc = await fixture.document()
    expect(doc.hosts[0]!.auth.type).toBe('privateKey')
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]!.kind).toBe('ssh-private-key')
    expect(JSON.stringify(useHostManagementStore.getState())).not.toContain('M2_FIXTURE_NOT_A_REAL_KEY')
  })

  it('does not adopt a refreshed revision while a host edit form is open', async () => {
    await openWorkspace()
    await saveDialog(await newHost())
    selectHost()
    fireEvent.click(screen.getByRole('button', { name: t('managedResources.editHost') }))
    const dialog = await screen.findByRole('dialog', { name: t('managedResources.editHost') })
    const existing = (await fixture.document()).hosts[0]!
    await act(async () => {
      await fixture.services.libService.updateHost({ id: existing.id, expectedRevision: existing.revision, changes: { notes: 'another editor' } })
      await useHostManagementStore.getState().fetchHosts()
    })
    const before = await fs.readFile(fixture.services.store.filePath)
    fireEvent.click(within(dialog).getByRole('button', { name: t('managedResources.changeCredential') }))
    fill(dialog, 'host-password-input', 'M2_RETRY_FIXTURE_ONLY')
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(t('managedResources.revisionConflict')))
    expect(await fs.readFile(fixture.services.store.filePath)).toEqual(before)
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }))
    expect((await fixture.document()).credentials).toHaveLength(1)
  })

  it('cancels an application account draft without writing a credential', async () => {
    await openWorkspace()
    await saveDialog(await newHost('DOM fixture host', true))
    selectHost()
    const before = await fs.readFile(fixture.services.store.filePath)
    const dialog = await openApplication()
    await addAccount(dialog)
    expect((await fixture.document()).credentials).toHaveLength(0)
    expect(JSON.stringify(useHostManagementStore.getState())).not.toContain(SECRET)
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(await fs.readFile(fixture.services.store.filePath)).toEqual(before)
  })

  it('creates, replaces and deletes application credentials through actual dialogs', async () => {
    await openWorkspace()
    await saveDialog(await newHost('DOM fixture host', true))
    selectHost()
    const dialog = await openApplication()
    await addAccount(dialog)
    await saveDialog(dialog)
    let doc = await fixture.document()
    expect(doc.credentials).toHaveLength(1)
    const oldCredential = doc.credentials[0]!
    await fixture.services.credentialService.update({ id: oldCredential.id, expectedRevision: oldCredential.revision, secret: { kind: 'application-password', password: 'M2_UPDATED_RECORD_ONLY' } })
    fireEvent.click(screen.getByRole('button', { name: t('managedResources.editApp') }))
    const editing = await screen.findByRole('dialog', { name: t('managedResources.editApp') })
    fireEvent.click(within(editing).getByRole('button', { name: t('managedResources.editAccount') }))
    fill(editing, 'new-account-password', 'M2_REPLACEMENT_ACCOUNT_ONLY')
    const accountSave = within(editing).getAllByRole('button', { name: t('common.save') }).find(button => button.getAttribute('type') === 'button')!
    fireEvent.click(accountSave)
    await saveDialog(editing)
    doc = await fixture.document()
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]!.id).not.toBe(oldCredential.id)
    fireEvent.click(screen.getByRole('button', { name: t('managedResources.deleteApp') }))
    const confirmation = await screen.findByRole('dialog')
    fireEvent.click(within(confirmation).getByRole('button', { name: t('common.delete') }))
    await waitFor(() => expect(confirmation).not.toBeInTheDocument())
    expect((await fixture.document()).credentials).toHaveLength(0)
    expect((await fixture.document()).hosts[0]!.applications).toHaveLength(0)
    expect(fixture.calls).not.toContain(ELECTRON_IPC_CHANNELS.mrDeleteCredential)
    expect(JSON.stringify(useHostManagementStore.getState())).not.toContain('M2_REPLACEMENT_ACCOUNT_ONLY')
  })

  it('rejects credential URLs without echoing their contents into the error', async () => {
    await openWorkspace()
    await saveDialog(await newHost('DOM fixture host', true))
    selectHost()
    const dialog = await openApplication()
    fill(dialog, 'app-login-url-input', `https://fixture:${SECRET}@example.invalid/`)
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }))
    const error = within(dialog).getByRole('alert')
    expect(error).toHaveTextContent(t('managedResources.m2.invalidUrl'))
    expect(error).not.toHaveTextContent(SECRET)
    expect((await fixture.document()).hosts[0]!.applications).toHaveLength(0)
  })

  it.each(['en', 'zh', 'zh-TW', 'jp', 'kr'] as const)('renders localized form names and keyboard close in %s', async locale => {
    useSettingsStore.setState({ locale })
    await openWorkspace()
    const dialog = await newHost()
    expect(within(dialog).getByLabelText(t('managedResources.m2.newTagLabel'))).toBeInTheDocument()
    expect(within(dialog).getByPlaceholderText(t('managedResources.m2.hostNamePlaceholder'))).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: t('common.close') })).toBeInTheDocument()
    fireEvent.keyDown(dialog.querySelector('input')!, { key: 'Escape' })
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect((await fixture.document()).hosts).toHaveLength(0)
    expect((await fixture.document()).credentials).toHaveLength(0)
  })

  it('keeps an in-flight form open and rejects double submission without duplicate credentials', async () => {
    await openWorkspace()
    const dialog = await newHost()
    const release = fixture.holdNextSave()
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }))
      fireEvent.submit(dialog.querySelector('form')!)
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(dialog).toBeInTheDocument()
      expect(dialog.querySelector('fieldset')).toBeDisabled()
      expect((await fixture.document()).hosts).toHaveLength(0)
    } finally {
      await act(async () => release())
    }
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect((await fixture.document()).hosts).toHaveLength(1)
    expect((await fixture.document()).credentials).toHaveLength(1)
    expect(fixture.calls.filter(channel => channel === ELECTRON_IPC_CHANNELS.mrSaveHost)).toHaveLength(1)
  })

  it('does not save a host before an in-flight inline tag has been selected', async () => {
    await openWorkspace()
    const dialog = await newHost()
    const release = fixture.holdNextSave(ELECTRON_IPC_CHANNELS.mrSaveTag)
    try {
      fill(dialog, 'host-new-tag', 'In-flight tag')
      fireEvent.click(within(dialog).getByRole('button', { name: t('managedResources.addTag') }))
      expect(within(dialog).getByRole('button', { name: t('common.save') })).toBeDisabled()
      fireEvent.submit(dialog.querySelector('form')!)
      expect((await fixture.document()).hosts).toHaveLength(0)
    } finally {
      await act(async () => release())
    }
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'In-flight tag', pressed: true })).toBeInTheDocument())
    await saveDialog(dialog)
    const doc = await fixture.document()
    expect(doc.hosts[0]!.tagIds).toEqual([doc.tags[0]!.id])
  })

  it('leaves application credentials untouched after a real revision conflict and cancellation', async () => {
    await openWorkspace()
    await saveDialog(await newHost('DOM fixture host', true))
    const dialog = await openApplication()
    await addAccount(dialog)
    const host = (await fixture.document()).hosts[0]!
    await fixture.services.libService.updateHost({ id: host.id, expectedRevision: host.revision, changes: { notes: 'concurrent editor' } })
    const before = await fs.readFile(fixture.services.store.filePath)
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(t('managedResources.revisionConflict')))
    expect(await fs.readFile(fixture.services.store.filePath)).toEqual(before)
    expect((await fixture.document()).credentials).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }))
    expect(await fs.readFile(fixture.services.store.filePath)).toEqual(before)
  })

  it('shows real referrers when a host deletion is blocked by repository integrity', async () => {
    await openWorkspace()
    await saveDialog(await newHost('DOM fixture host', true))
    const host = (await fixture.document()).hosts[0]!
    const created = await fixture.services.libService.createDataConnection({
      name: 'Fixture referring connection', address: 'fixture.invalid', port: 5432,
      username: 'fixture', credentialId: null, tagIds: [], relatedHostId: host.id,
      environment: 'unspecified', tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null },
      description: '', accessInstructions: '', kind: 'database', engine: 'postgresql', database: 'fixture', schema: null, mode: 'inspection',
    })
    expect(created.status).toBe('created')
    fireEvent.click(screen.getByRole('button', { name: t('managedResources.deleteHost') }))
    const confirmation = await screen.findByRole('dialog')
    fireEvent.click(within(confirmation).getByRole('button', { name: t('common.delete') }))
    await screen.findByText('Fixture referring connection')
    expect((await fixture.document()).hosts).toHaveLength(1)
  })

  it('uses the actual import/export response counts and treats dialog cancellation as neutral', async () => {
    await openWorkspace()
    await saveDialog(await newHost('DOM fixture host', true))
    fireEvent.click(screen.getByRole('button', { name: t('managedResources.importExport') }))
    const dialog = await screen.findByRole('dialog', { name: t('managedResources.importExport') })
    fireEvent.click(within(dialog).getByRole('button', { name: t('managedResources.exportJson') }))
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('1'))
    expect(within(dialog).getByRole('status')).not.toHaveTextContent('undefined')
    const exportPath = path.join(fixture.tempDir, 'export.json')
    expect(await fs.readFile(exportPath, 'utf8')).not.toContain(SECRET)
    fixture.setImportPath(exportPath)
    fireEvent.click(within(dialog).getByRole('button', { name: t('managedResources.importSelectFile') }))
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent(t('managedResources.m2.importComplete', { count: 1 })))
    fixture.setImportPath(null)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: t('managedResources.importSelectFile') })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole('button', { name: t('managedResources.importSelectFile') }))
    await waitFor(() => expect(within(dialog).queryByRole('status')).not.toBeInTheDocument())
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })
})
