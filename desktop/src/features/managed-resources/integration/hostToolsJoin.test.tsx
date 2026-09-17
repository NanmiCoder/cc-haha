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
import { createHostToolsPreferences } from '../../../../electron/services/managedResources/hostToolsPreferences'
import { HostToolsInputSchema } from '../api/hostToolsApi'
import { applicationScriptCommand } from '../../../../electron/services/managedResources/applicationScriptCommand'
import { parseJavaProcesses, javaHeapArguments } from '../../../../electron/services/managedResources/javaProcessProtocol'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
const scope = () => ({ hostId: h.host.id, applicationId: h.application.id, rootIndex: 0, expectedRoot: h.root })
const api = () => h.fixture.host.hostManagement
const frame = (items: Array<[number, string[]]>, unreadable = 0) => 'CC_HAHA_JAVA_V1\n' + items.map(([pid, args]) => `${pid}\t${Buffer.from(args.join('\0') + '\0').toString('base64')}\n`).join('') + `CC_HAHA_JAVA_END\t${unreadable}\n`
const javaInput = () => ({ action: 'listJava' as const, hostId: h.host.id, connectionId: h.ssh().connectionId!, generation: h.ssh().generation, requestId: randomUUID() })
beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  useSettingsStore.setState({ locale: 'en' })
  h = await createApplicationOperationsHarness()
})
afterEach(async () => { cleanup(); await h?.dispose(); vi.unstubAllGlobals() })

describe('host tools through DOM -> DesktopHost -> IPC -> repository / SSH', () => {
  it('persists execution user and rapid independent folds, then reloads the actual preferences file and remounts', async () => {
    const view = render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    const user = screen.getByLabelText('Execution user')
    await waitFor(() => expect(user).toBeEnabled())
    fireEvent.change(user, { target: { value: 'deploy' } })
    fireEvent.click(within(screen.getByTestId('application-execution-user')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(user).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'apps', expanded: true }))
    fireEvent.click(screen.getByRole('button', { name: 'conf', expanded: true }))
    fireEvent.click(screen.getByRole('button', { name: 'apps', expanded: false }))
    const repo = createHostToolsPreferences(h.fixture.services.store)
    await waitFor(async () => expect(await repo.get(scope())).toMatchObject({ runAsUser: 'deploy', collapsed: { apps: false, conf: true } }))
    view.unmount()
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Execution user')).toHaveValue('deploy'))
    expect(screen.getByRole('button', { name: 'conf', expanded: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'apps', expanded: true })).toBeInTheDocument()
    const persisted = JSON.parse(await fs.readFile(repo.filePath, 'utf8'))
    expect(persisted.schemaVersion).toBe(3)
    expect(JSON.stringify(persisted)).not.toContain('APP_OPS_FIXTURE_ONLY')
    expect((await createHostToolsPreferences(h.fixture.services.store).get(scope())).runAsUser).toBe('deploy')
  })

  it('uses the saved execution user after confirmation; no user-provided shell code is accepted', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    const user = screen.getByLabelText('Execution user')
    await waitFor(() => expect(user).toBeEnabled())
    fireEvent.change(user, { target: { value: 'deploy; touch /tmp/no' } })
    expect(within(screen.getByTestId('application-execution-user')).getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(user, { target: { value: 'deploy' } })
    fireEvent.click(within(screen.getByTestId('application-execution-user')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(user).toBeEnabled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execute: start.sh' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Execute: start.sh' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Execution user: deploy')
    expect(h.commands).toHaveLength(0)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Execute' }))
    await screen.findByText(/Completed · Exit code: 0/)
    expect(h.commands).toEqual([applicationScriptCommand(h.root + '/bin/bin', 'start.sh', 'deploy')])
    expect(h.commands[0]).toContain("exec su - 'deploy' -s /bin/bash -c")
    expect(h.commands[0]).toContain('RUN_AS_REQUIRES_ROOT')
  })

  it('refuses stale execution-user confirmation rather than running as a newly configured user', async () => {
    render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execute: start.sh' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Execute: start.sh' }))
    await api().hostTools({ action: 'savePreferences', scope: scope(), patch: { runAsUser: 'deploy' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Execute' }))
    await screen.findByText('RUN_AS_CHANGED')
    expect(h.commands).toHaveLength(0)
  })

  it('reaches Java tab, parses remote argv, saves/selects/removes keywords across remount without persisting commands', async () => {
    h.setJavaOutput(frame([[21, ['/usr/bin/java', '-Xms512m', '-Xmx2g', '-jar', '/srv/服务 mon.jar']], [9, ['java', '-Xmx256m', 'example.Main', '-Xmx999g']]]))
    const view = render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-java-tab'))
    expect(screen.getAllByRole('tab').map(tab => tab.getAttribute('data-testid'))).toEqual(['host-terminal-tab', 'host-files-tab', 'host-applications-tab', 'host-java-tab'])
    await screen.findByText('2g')
    const input = screen.getByRole('searchbox', { name: 'Search PID, command line or heap options' })
    expect(screen.getByText('512m')).toBeVisible()
    expect(screen.queryByText('999g')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: '服务' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save keyword' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save keyword' }))
    await screen.findByRole('button', { name: '服务' })
    expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(1)
    view.unmount()
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-java-tab'))
    const keyword = await screen.findByRole('button', { name: '服务' })
    fireEvent.click(keyword)
    expect(screen.getByRole('searchbox', { name: 'Search PID, command line or heap options' })).toHaveValue('服务')
    await screen.findByText('2g')
    const repo = createHostToolsPreferences(h.fixture.services.store)
    const content = await fs.readFile(repo.filePath, 'utf8')
    expect(content).not.toContain('/usr/bin/java')
    expect(content).not.toContain('-Xmx')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove keyword: 服务' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Remove keyword: 服务' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '服务' })).toBeNull())
    expect((await repo.get({ hostId: h.host.id })).javaKeywords).toEqual([])
    expect(h.commands).toHaveLength(0)
  })

  it('does not show stale Java rows on failure or reconnect and isolates caller/generation', async () => {
    const request = javaInput()
    h.setJavaOutput(frame([[30, ['java', '-Xmx1g', 'Main']]]))
    expect((await api().hostTools(request)).ok).toBe(true)
    expect(await api().hostTools({ ...request, hostId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_OWNER' } })
    expect(await api().hostTools({ ...request, generation: request.generation + 1 })).toMatchObject({ ok: false, error: { code: 'STALE_GENERATION' } })
    expect(HostToolsInputSchema.safeParse({ ...request, command: 'rm -rf /' }).success).toBe(false)
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-java-tab'))
    await screen.findByText('1g')
    h.setJavaOutput('not a process listing', 7)
    fireEvent.click(within(screen.getByTestId('java-processes-panel')).getByRole('button', { name: 'Refresh' }))
    await screen.findByText('PROCESS_QUERY_FAILED')
    expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(0)
    await act(async () => { await h.fixture.services.sshService.disconnect({ connectionId: request.connectionId, ownerId: 'window:99' }) })
  })

  it('rejects corrupt/future preferences without overwriting them and keeps different roots separate', async () => {
    const repo = createHostToolsPreferences(h.fixture.services.store)
    expect(await repo.get(scope())).toMatchObject({ runAsUser: '', collapsed: {}, javaKeywords: [] })
    await api().hostTools({ action: 'savePreferences', scope: scope(), patch: { collapsed: { logs: true } } })
    expect(await api().hostTools({ action: 'getPreferences', scope: { ...scope(), expectedRoot: '/other' } })).toMatchObject({ ok: false, error: { code: 'APPLICATION_CHANGED' } })
    await fs.writeFile(repo.filePath, '{"schemaVersion":99,"entries":{},"keep":"untouched"}')
    expect(await api().hostTools({ action: 'savePreferences', scope: scope(), patch: { runAsUser: 'deploy' } })).toMatchObject({ ok: false, error: { code: 'PREFERENCES_INVALID' } })
    expect(await fs.readFile(repo.filePath, 'utf8')).toContain('"keep":"untouched"')
    expect(await fs.readdir(path.dirname(repo.filePath))).not.toContain(path.basename(repo.filePath) + '.tmp')
  })

  it('cancels only the pending query on tab close, without disconnecting the terminal', async () => {
    await h.dispose()
    h = await createApplicationOperationsHarness('/srv/fixture app', { holdJava: true })
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-java-tab'))
    await waitFor(() => expect(h.activeJava).toBe(1))
    fireEvent.click(screen.getByTestId('host-applications-tab'))
    await waitFor(() => expect(h.activeJava).toBe(0))
    expect(h.ssh().status).toBe('ready')
  })

  it('persists keywords separately from application settings and migrates an old install without rewriting resources', async () => {
    const resourceBefore = await fs.readFile(h.fixture.services.store.filePath)
    const repo = createHostToolsPreferences(h.fixture.services.store)
    expect(await repo.get(scope())).toEqual({ runAsUser: '', collapsed: {}, javaKeywords: [], lastJavaSearch: '', pinnedFiles: [] })
    expect(await fs.stat(repo.filePath).catch(() => null)).toBeNull()
    await Promise.all([
      api().hostTools({ action: 'savePreferences', scope: scope(), patch: { runAsUser: 'deploy' } }),
      api().hostTools({ action: 'savePreferences', scope: scope(), patch: { collapsed: { 'bin/bin': true } } }),
      api().hostTools({ action: 'savePreferences', scope: { hostId: h.host.id }, patch: { addJavaKeyword: 'mon' } }),
    ])
    const diskReader = createHostToolsPreferences(h.fixture.services.store)
    expect(await diskReader.get(scope())).toEqual({ runAsUser: 'deploy', collapsed: { 'bin/bin': true }, javaKeywords: [], lastJavaSearch: '', pinnedFiles: [] })
    expect((await diskReader.get({ hostId: h.host.id })).javaKeywords).toEqual(['mon'])
    await api().hostTools({ action: 'savePreferences', scope: { hostId: h.host.id }, patch: { addJavaKeyword: 'mon' } })
    expect((await diskReader.get({ hostId: h.host.id })).javaKeywords).toEqual(['mon'])
    expect(await fs.readFile(h.fixture.services.store.filePath)).toEqual(resourceBefore)
    await expect(api().hostTools({ action: 'getPreferences', scope: scope(), ownerId: 'foreign' } as never)).rejects.toThrow('Invalid Electron IPC payload')
  })

  it('rejects malformed or oversized Java responses and an already-cancelled query without sending it', async () => {
    h.setJavaOutput('not a process frame')
    expect(await api().hostTools(javaInput())).toMatchObject({ ok: false, error: { code: 'PROCESS_RESPONSE_INVALID' } })
    h.setJavaOutput('x'.repeat(8 * 1024 * 1024 + 1))
    expect(await api().hostTools(javaInput())).toMatchObject({ ok: false, error: { code: 'PROCESS_OUTPUT_LIMIT' } })
    const request = javaInput()
    await api().hostTools({ action: 'cancelJava', requestId: request.requestId })
    const before = h.javaQueries
    expect(await api().hostTools(request)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(h.javaQueries).toBe(before)
    expect(h.ssh().status).toBe('ready')
  })

  it('keeps argv boundaries, ignores application arguments and reports missing heap settings honestly', () => {
    expect(javaHeapArguments(['java', '-cp', 'classes', '-Xmx1g', '-Xmx2g', 'Main', '-Xms99g'])).toEqual({ xmx: '2g', xms: null })
    expect(javaHeapArguments(['java', '-Xmx1g', '--module=example/Main', '-Xmx99g'])).toEqual({ xmx: '1g', xms: null })
    expect(() => parseJavaProcesses('CC_HAHA_JAVA_V1\nCC_HAHA_JAVA_END\t999999999999999999999999\n')).toThrow('PROCESS_RESPONSE_INVALID')
    expect(javaHeapArguments(['java', '-XX:InitialHeapSize=1024', '-XX:MaxHeapSize=4096', '-jar', 'a.jar'])).toEqual({ xms: '1024', xmx: '4096' })
    expect(parseJavaProcesses(frame([[55, ['/jdk/bin/java', '-Xmx2g', '-jar', '含 空格.jar', 'a\nb']], [6, ['java', 'Main']]], 2))).toMatchObject({ unreadable: 2, processes: [{ pid: 6, xmx: null, xms: null }, { pid: 55, xmx: '2g' }] })
    expect(() => parseJavaProcesses('')).toThrow('PROCESS_RESPONSE_INVALID')
    expect(() => parseJavaProcesses(frame([[1, ['node', 'java']]]))).toThrow('PROCESS_RESPONSE_INVALID')
  })
})
