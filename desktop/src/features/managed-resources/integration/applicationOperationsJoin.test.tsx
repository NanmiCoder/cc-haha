import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { HostDetail } from '../ui/hosts/HostDetail'
import { ApplicationFilesPanel } from '../ui/hosts/ApplicationFilesPanel'
import { ApplicationOperationInputSchema, type ApplicationFileTarget, type ApplicationOperationInput } from '../api/applicationOperationsApi'
import { createApplicationOperationsService } from '../../../../electron/services/managedResources/applicationOperationsService'
import { quoteShellArgument } from '../../../../electron/services/managedResources/applicationOperationsIo'

type Harness = Awaited<ReturnType<typeof createApplicationOperationsHarness>>
let h: Harness
const api = () => h.fixture.host.hostManagement
// Folding now writes explicit preferences, but must never refetch files or touch SSH.
const nonPreferenceCalls = () => h.fixture.calls.filter(channel => channel !== 'desktop:managed-resources:host-tools').length
const target = (directory: ApplicationFileTarget['directory'] = 'bin/bin', relativePath = ''): ApplicationFileTarget => ({ hostId: h.host.id, applicationId: h.application.id, connectionId: h.ssh().connectionId!, generation: h.ssh().generation, rootIndex: 0, directory, relativePath })
async function call(input: ApplicationOperationInput) {
  const result = await api().applicationOperation(input)
  if (!result.ok) throw new Error(result.error.code)
  return result.data
}
async function start(name: string, mode: 'script' | 'tail' = 'script', requestId = randomUUID()) {
  const t = target(mode === 'script' ? 'bin/bin' : 'logs')
  const listed = await call({ ...t, action: 'list' })
  if (listed.kind !== 'files') throw new Error('Missing files')
  const file = listed.entries.find(f => f.name === name)!
  const input = { ...t, relativePath: file.relativePath, action: 'start' as const, mode, requestId, expectedRevision: file.revision, confirmed: true as const }
  await call(input)
  return input
}
async function terminal(id: string) {
  let current: Awaited<ReturnType<typeof call>>
  await waitFor(async () => {
    current = await call({ action: 'poll', operationId: id })
    expect(current.kind === 'operation' && ['completed', 'failed', 'stopped'].includes(current.operation.state)).toBe(true)
  }, { timeout: 6000 })
  return current!
}
beforeEach(async () => {
  // Supply absent layout primitives only; real HostDetail, xterm, stores and IPC remain in use.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  useSettingsStore.setState({ locale: 'en' }); h = await createApplicationOperationsHarness()
})
afterEach(async () => { cleanup(); await h?.dispose(); vi.unstubAllGlobals() })

describe('application operations: DOM -> DesktopHost -> preload -> IPC -> SSH/SFTP', () => {
  it('reaches all four side-by-side directory lists from the real applications tab and navigates nested files', async () => {
    await h.remote.seedFile(h.root + '/conf/nested/中文.conf', 'x=1')
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-applications-tab'))
    await screen.findByRole('button', { name: 'Execute: start.sh' }, { timeout: 6000 })
    const lists = screen.getByTestId('application-file-lists')
    expect(lists).toHaveClass('grid')
    expect(lists).not.toHaveClass('flex-col')
    expect(screen.getByTestId('application-file-lists-scroll')).toHaveClass('overflow-x-auto')
    expect(Array.from(lists.querySelectorAll('[data-app-directory]')).map(x => x.getAttribute('data-app-directory'))).toEqual(['apps', 'conf', 'logs', 'bin/bin'])
    const conf = screen.getByRole('region', { name: 'conf' })
    fireEvent.click(await within(conf).findByRole('button', { name: 'nested' }, { timeout: 6000 }))
    expect(await screen.findByRole('button', { name: '中文.conf' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Parent directory: conf' }))
    expect(await screen.findByRole('button', { name: 'app.conf' })).toBeInTheDocument()
  })

  it('collapses each directory independently while preserving navigation and refresh through real IPC', async () => {
    await h.remote.seedFile(h.root + '/conf/nested/中文.conf', 'x=1')
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    const conf = screen.getByRole('region', { name: 'conf' })
    fireEvent.click(await within(conf).findByRole('button', { name: 'nested' }))
    const file = await within(conf).findByRole('button', { name: '中文.conf' })
    const toggle = within(conf).getByRole('button', { name: 'conf', expanded: true })
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(body).toContainElement(file)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(body).not.toBeVisible()
    expect(within(conf).queryByRole('button', { name: '中文.conf' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tail: server.log' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Execute: start.sh' })).toBeVisible()
    await h.remote.seedFile(h.root + '/conf/nested/refreshed.conf', 'x=2')
    fireEvent.click(within(conf).getByRole('button', { name: 'Refresh: conf' }))
    await waitFor(() => expect(body).toHaveTextContent('refreshed.conf'))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(body).toBeVisible()
    expect(within(conf).getByRole('button', { name: '中文.conf' })).toBeVisible()
    expect(within(conf).getByRole('button', { name: 'refreshed.conf' })).toBeVisible()
    expect(within(conf).getByText(h.root + '/conf/nested')).toBeVisible()
    expect(h.commands).toHaveLength(0)
    expect(await h.remote.fileExists(h.root + '/logs/server.log')).toBe(true)
  })

  it('can collapse all four lists and reopen only one without remounting or fetching again', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    await screen.findByRole('button', { name: 'Execute: start.sh' })
    await screen.findByRole('button', { name: 'app.conf' })
    await screen.findByRole('button', { name: 'app.jar' })
    await screen.findByRole('button', { name: 'Tail: server.log' })
    const before = nonPreferenceCalls()
    for (const directory of ['apps', 'conf', 'logs', 'bin/bin']) {
      fireEvent.click(within(screen.getByRole('region', { name: directory })).getByRole('button', { name: directory, expanded: true }))
    }
    expect(screen.queryAllByRole('list')).toHaveLength(0)
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'logs', expanded: false }))
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Tail: server.log' })).toBeVisible()
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(3)
    expect(nonPreferenceCalls()).toBe(before)
    expect(h.commands).toHaveLength(0)
  })

  it('reclaims horizontal width from collapsed columns without discarding their contents', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    await screen.findByRole('button', { name: 'app.conf' })
    const grid = screen.getByTestId('application-file-lists')
    const conf = screen.getByRole('button', { name: 'conf', expanded: true })
    fireEvent.click(conf)
    expect(grid.style.gridTemplateColumns).toBe('minmax(240px, 1fr) 48px minmax(240px, 1fr) minmax(240px, 1fr)')
    fireEvent.click(screen.getByRole('button', { name: 'apps', expanded: true }))
    expect(grid.style.gridTemplateColumns).toBe('48px 48px minmax(240px, 1fr) minmax(240px, 1fr)')
    fireEvent.click(conf)
    expect(grid.style.gridTemplateColumns).toBe('48px minmax(240px, 1fr) minmax(240px, 1fr) minmax(240px, 1fr)')
    expect(screen.getByRole('button', { name: 'app.conf' })).toBeVisible()
  })

  it('maximizes and restores the same workspace, keeping directory, collapse and scroll state without refetching', async () => {
    await h.remote.seedFile(h.root + '/conf/nested/中文.conf', 'x=1')
    const view = render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'nested' }))
    const file = await screen.findByRole('button', { name: '中文.conf' })
    await screen.findByRole('button', { name: 'Execute: start.sh' })
    await screen.findByRole('button', { name: 'app.jar' })
    await screen.findByRole('button', { name: 'Tail: server.log' })
    fireEvent.click(screen.getByRole('button', { name: 'apps', expanded: true }))
    const grid = screen.getByTestId('application-file-lists')
    const scroller = screen.getByTestId('application-file-lists-scroll')
    scroller.scrollLeft = 77
    const before = nonPreferenceCalls()
    const overflow = document.body.style.overflow
    const maximize = screen.getByRole('button', { name: 'Full screen' })
    fireEvent.click(maximize)
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'true')
    expect(view.container).toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByTestId('application-file-lists')).toBe(grid)
    expect(screen.getByRole('button', { name: '中文.conf' })).toBe(file)
    expect(screen.getByRole('button', { name: 'apps', expanded: false })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(view.container).not.toHaveAttribute('inert')
    expect(view.container).toContainElement(grid)
    expect(document.body.style.overflow).toBe(overflow)
    expect(scroller.scrollLeft).toBe(77)
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'false')
    expect(screen.getByRole('button', { name: 'Full screen' })).toHaveFocus()
    expect(nonPreferenceCalls()).toBe(before)
    expect(h.commands).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    view.unmount()
    expect(document.body.style.overflow).toBe(overflow)
    expect(view.container).not.toHaveAttribute('inert')
    expect(document.querySelector('[data-application-workspace-mount]')).toBeNull()
  })

  it('keeps full screen while Escape closes a nested viewer or live Tail and then restores on the next Escape', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    await screen.findByRole('button', { name: 'View: server.log' })
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    fireEvent.click(screen.getByRole('button', { name: 'View: server.log' }))
    await screen.findByLabelText('Remote file contents')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByLabelText('Remote file contents')).not.toBeInTheDocument()
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Tail: server.log' }))
    const output = await screen.findByLabelText('Live output')
    await waitFor(() => expect(output).toHaveTextContent('initial log'))
    await act(async () => { h.append('fullscreen log 中文\n') })
    await waitFor(() => expect(output).toHaveTextContent('fullscreen log 中文'))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(h.tails).toBe(0))
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'false')
    expect(h.ssh().status).toBe('ready')
    expect(h.commands).toHaveLength(1)
  })

  it('executes only after confirmation, uses bash in bin/bin, shows real channel output and exit status', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Execute: start.sh' }))
    expect(h.commands).toHaveLength(0)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Run this Bash script?' })).getByRole('button', { name: 'Execute' }))
    const output = await screen.findByLabelText('Live output')
    await waitFor(() => expect(output).toHaveTextContent('fixture script 中文'))
    expect(output).toHaveTextContent('fixture stderr')
    expect(h.commands).toEqual([`cd -- '${h.root}/bin/bin' && exec bash -- './start.sh'`])
    await screen.findByText(/Completed · Exit code: 0/)
  })

  it('views inert log text, downloads its full contents and confirms deletion of just the selected log', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View: server.log' }))
    expect(await screen.findByLabelText('Remote file contents')).toHaveTextContent('<script>inert</script>')
    expect(screen.getByRole('dialog').querySelector('script')).toBeNull()
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('Close'))
    const destination = path.join(h.fixture.tempDir, 'saved.log')
    h.fixture.setExportPath(destination)
    fireEvent.click(screen.getByRole('button', { name: 'Download: server.log' }))
    await screen.findByText('Transfer completed.')
    expect(await fs.readFile(destination, 'utf8')).toContain('initial log')
    fireEvent.click(screen.getByRole('button', { name: 'Delete log: server.log' }))
    expect(await h.remote.fileExists(h.root + '/logs/server.log')).toBe(true)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this remote log?' })).getByRole('button', { name: 'Delete log' }))
    await waitFor(async () => expect(await h.remote.fileExists(h.root + '/logs/server.log')).toBe(false))
    expect(await h.remote.fileExists(h.root + '/bin/bin/start.sh')).toBe(true)
  })

  it('follows log appends through a dedicated SSH channel and closes it without disconnecting the terminal', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tail: server.log' }))
    const output = await screen.findByLabelText('Live output')
    await waitFor(() => expect(output).toHaveTextContent('initial log'))
    expect(h.commands[0]).toBe(`exec tail -n 200 -F -- '${h.root}/logs/server.log'`)
    await act(async () => { h.append('appended 中文\n') })
    await waitFor(() => expect(output).toHaveTextContent('appended 中文'))
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('Close'))
    await waitFor(() => expect(h.tails).toBe(0))
    expect(h.ssh().status).toBe('ready')
  })

  it('tails a growing log selected from an older listing and releases the channel when the applications surface unmounts', async () => {
    const view = render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    const button = await screen.findByRole('button', { name: 'Tail: server.log' })
    await h.remote.seedFile(h.root + '/logs/server.log', 'new records since directory listing\n')
    fireEvent.click(button)
    await waitFor(() => expect(h.tails).toBe(1))
    view.unmount()
    await waitFor(() => expect(h.tails).toBe(0))
    expect(h.ssh().status).toBe('ready')
  })

  it('bounds large log previews and stops an active tail when the configured application root changes', async () => {
    await h.remote.seedFile(h.root + '/logs/large.log', Buffer.alloc(600 * 1024, 120))
    const preview = await call({ ...target('logs', 'large.log'), action: 'read' })
    expect(preview.kind === 'content' && preview.truncated).toBe(true)
    expect(preview.kind === 'content' && preview.text.length).toBe(256 * 1024)
    const input = await start('server.log', 'tail')
    await waitFor(() => expect(h.tails).toBe(1))
    const updated = await api().saveApplication({ hostId: h.host.id, expectedHostRevision: h.host.revision, application: { id: h.application.id, installPaths: ['/different/root'] } })
    expect(updated.ok).toBe(true)
    const result = await call({ action: 'poll', operationId: input.requestId })
    expect(result.kind === 'operation' && result.operation.errorCode).toBe('APPLICATION_CHANGED')
    await waitFor(() => expect(h.tails).toBe(0))
  })

  it('does not replay a repeated script request, and preserves distinct runs of the same script', async () => {
    const input = await start('start.sh')
    await terminal(input.requestId)
    await call(input)
    expect(h.commands).toHaveLength(1)
    const second = await start('start.sh')
    await terminal(second.requestId)
    expect(h.commands).toHaveLength(2)
    await expect(call({ ...input, relativePath: 'fail.sh' })).rejects.toThrow('REQUEST_ID_CONFLICT')
  })

  it('reports nonzero script exit and bounds tail output', async () => {
    const failed = await start('fail.sh')
    const result = await terminal(failed.requestId)
    expect(result.kind === 'operation' && result.operation.exitCode).toBe(7)
    expect(result.kind === 'operation' && result.operation.state).toBe('failed')
    const tail = await start('server.log', 'tail')
    await waitFor(() => expect(h.tails).toBe(1))
    h.append('x'.repeat(512 * 1024))
    await waitFor(async () => { const r = await call({ action: 'poll', operationId: tail.requestId }); expect(r.kind === 'operation' && r.operation.truncated).toBe(true) })
    const bounded = await call({ action: 'poll', operationId: tail.requestId })
    expect(bounded.kind === 'operation' && bounded.operation.text.length).toBeLessThanOrEqual(256 * 1024)
  })

  it('rejects traversal, injected fields, wrong hosts/applications, non-log deletion and changed confirmations', async () => {
    for (const bad of ['../private', '/etc/passwd', 'logs/../../x', 'line\n.sh', 'a\\b']) {
      expect(ApplicationOperationInputSchema.safeParse({ ...target(), action: 'read', relativePath: bad }).success).toBe(false)
      await expect(api().applicationOperation({ ...target(), action: 'read', relativePath: bad })).rejects.toThrow('Invalid Electron IPC payload')
    }
    await expect(api().applicationOperation({ ...target(), action: 'list', ownerId: 'foreign' })).rejects.toThrow('Invalid Electron IPC payload')
    await expect(call({ ...target(), action: 'list', hostId: randomUUID() })).rejects.toThrow('UNAUTHORIZED_OWNER')
    await expect(call({ ...target(), action: 'list', applicationId: randomUUID() })).rejects.toThrow('INVALID_REMOTE_PATH')
    const list = await call({ ...target('logs'), action: 'list' })
    if (list.kind !== 'files') throw new Error('missing files')
    await h.remote.seedFile(h.root + '/logs/server.log', 'changed after selection')
    await expect(call({ ...target('logs', 'server.log'), action: 'delete', expectedRevision: list.entries[0]!.revision, confirmed: true })).rejects.toThrow('REVISION_CONFLICT')
    await expect(call({ ...target('bin/bin', 'start.sh'), action: 'delete', expectedRevision: 'x', confirmed: true })).rejects.toThrow('INVALID_ARGUMENT')
    expect(h.commands).toHaveLength(0)
  })

  it('keeps shell metacharacters literal and rejects symlinked directories', async () => {
    const name = "test'; echo injected; #.sh"
    await h.remote.seedFile(h.root + '/bin/bin/' + name, '# fixture')
    const input = await start(name)
    await terminal(input.requestId)
    expect(h.commands[0]).toBe(`cd -- ${quoteShellArgument(h.root + '/bin/bin')} && exec bash -- ${quoteShellArgument('./' + name)}`)
    const outside = path.join(h.fixture.tempDir, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'private.log'), 'private fixture')
    await fs.symlink(outside, path.join(h.remote.remoteRoot, h.root, 'logs', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(call({ ...target('logs', 'link/private.log'), action: 'read' })).rejects.toThrow('IS_SYMLINK')
  })

  it('isolates operation ownership and honours cancellation while launch is pending', async () => {
    const service = createApplicationOperationsService(h.fixture.services)
    const ownerId = 'window:99'
    const list = await service.perform({ ...target(), action: 'list' }, ownerId)
    if (list.kind !== 'files') throw new Error('missing files')
    const file = list.entries.find(entry => entry.name === 'start.sh')!
    const requestId = randomUUID()
    await service.perform({ ...target('bin/bin', file.relativePath), action: 'start', mode: 'script', requestId, expectedRevision: file.revision, confirmed: true }, ownerId)
    await expect(service.perform({ action: 'poll', operationId: requestId }, 'foreign')).rejects.toThrow('UNAUTHORIZED_OWNER')
    await service.perform({ action: 'stop', operationId: requestId }, ownerId)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(h.commands).toHaveLength(0)
    service.dispose()
  })
})
