import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { HostDetail } from '../ui/hosts/HostDetail'
import { createHostToolsPreferences } from '../../../../electron/services/managedResources/hostToolsPreferences'
import { processInspectionCommand, processListCommand } from '../../../../electron/services/managedResources/serviceProcessProtocol'
import type { ProcessKind, ProcessProbe } from '../api/hostToolsApi'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
let replies: Map<string, { text: string; exitCode?: number; hold?: boolean }>
const identity = { pid: 231, startTime: '123456' }
const probeCommand = (processKind: ProcessKind, probe: ProcessProbe) => processInspectionCommand({ ...identity, processKind, probe })
const inspectionFrame = (probe: ProcessProbe, value: string) => `CC_HAHA_INSPECTION_V1\t231\t${probe}\n${Buffer.from(value).toString('base64')}\nCC_HAHA_INSPECTION_END\n`
const frame = (kind: 'mysql' | 'redis') => `CC_HAHA_PROCESS_V1\t${kind}\n231\t123456\t${kind === 'mysql' ? 'mysqld' : 'redis-server'}\t${Buffer.from((kind === 'mysql' ? '/usr/sbin/mysqld\0--port=3337\0' : 'redis-server 127.0.0.1:6379\0')).toString('base64')}\nCC_HAHA_PROCESS_END\t0\n`
const api = () => h.fixture.host.hostManagement
const request = (processKind: ProcessKind = 'mysql', probe: ProcessProbe = 'top') => ({ action: 'inspectProcess' as const, ...identity, processKind, probe,
  hostId: h.host.id, connectionId: h.ssh().connectionId!, generation: h.ssh().generation, requestId: randomUUID() })
beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  useSettingsStore.setState({ locale: 'en' })
  replies = new Map()
  for (const kind of ['mysql', 'redis'] as const) replies.set(processListCommand(kind), { text: frame(kind) })
  for (const kind of ['java', 'mysql', 'redis'] as const) for (const probe of ['top', 'ports', 'connections'] as const) {
    replies.set(probeCommand(kind, probe), { text: inspectionFrame(probe, probe === 'top' ? 'PID USER %CPU %MEM RES\n231 fixture 12.5 2.0 128m\n'
      : probe === 'ports' ? 'tcp LISTEN 0 128 [::]:3337 [::]:* users:(("service",pid=231,fd=9))\n'
      : 'tcp ESTAB 0 0 127.0.0.1:3337 127.0.0.1:54321 users:(("service",pid=231,fd=12))\n') })
  }
  h = await createApplicationOperationsHarness('/srv/process-fixture', { processReplies: replies })
  h.setJavaOutput(`CC_HAHA_JAVA_V1\n231\t${Buffer.from('java\0-Xmx4096m\0-Xms2048m\0Main\0').toString('base64')}\t123456\nCC_HAHA_JAVA_END\t0\n`)
})
afterEach(async () => { cleanup(); await h?.dispose(); vi.unstubAllGlobals() })

describe('process discovery through real HostDetail -> DesktopHost -> IPC -> loopback SSH', () => {
  it.each(['mysql', 'redis'] as const)('exposes %s entry and all three read-only inspections through real buttons and keyboard tabs', async kind => {
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId(`host-${kind}-tab`))
    const row = await screen.findByRole('button', { name: 'Ports: 231' })
    expect(row).toBeEnabled()
    fireEvent.click(row)
    const modal = await screen.findByTestId('process-inspection')
    await within(modal).findByText(/tcp LISTEN/)
    expect(h.processCommands).toContain(probeCommand(kind, 'ports'))
    fireEvent.click(within(modal).getByRole('tab', { name: 'Connections' }))
    await within(modal).findByText(/tcp ESTAB/)
    fireEvent.keyDown(within(modal).getByRole('tab', { name: 'Connections' }), { key: 'Home' })
    await within(modal).findByText(/12.5 2.0 128m/)
    expect(within(modal).getByRole('tab', { name: 'Top' })).toHaveFocus()
    expect(h.processCommands).toEqual([processListCommand(kind), probeCommand(kind, 'ports'), probeCommand(kind, 'connections'), probeCommand(kind, 'top')])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(h.activeProcessQueries).toBe(0))
    expect(h.ssh().status).toBe('ready')
    expect(h.commands).toHaveLength(0)
  })

  it('merges both heap settings into one Java column without disabling its inspection actions', async () => {
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-java-tab'))
    const panel = await screen.findByTestId('java-processes-panel')
    await within(panel).findByText('4096m')
    expect(within(panel).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['PID', 'Command line', 'Xmx / Xms', 'Inspect'])
    const heap = within(panel).getByText('4096m').closest('td')!
    expect(heap).toHaveTextContent('Xmx: 4096mXms: 2048m')
    fireEvent.click(within(panel).getByRole('button', { name: 'Top: 231' }))
    await screen.findByText(/12.5 2.0 128m/)
    expect(h.processCommands).toEqual([probeCommand('java', 'top')])
  })

  it('persists independent OR searches and keywords without changing existing Java preferences', async () => {
    const repo = createHostToolsPreferences(h.fixture.services.store)
    await repo.patch({ hostId: h.host.id }, { lastJavaSearch: 'Main', addJavaKeyword: 'legacy-java' })
    const view = render(<HostDetail />)
    for (const [kind, search] of [['mysql', 'mysqld missing'], ['redis', 'redis-server missing']] as const) {
      fireEvent.click(screen.getByTestId(`host-${kind}-tab`))
      const input = await screen.findByRole('searchbox')
      await waitFor(() => expect(input).toBeEnabled())
      fireEvent.change(input, { target: { value: search } })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save keyword' })).toBeEnabled())
      fireEvent.click(screen.getByRole('button', { name: 'Save keyword' }))
      await waitFor(async () => expect((await repo.get({ hostId: h.host.id, processKind: kind })).javaKeywords).toEqual([search]))
      expect(document.querySelectorAll('[data-process-kind]')).toHaveLength(1)
    }
    view.unmount()
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-mysql-tab'))
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue('mysqld missing'))
    expect((await repo.get({ hostId: h.host.id })).lastJavaSearch).toBe('Main')
    expect((await repo.get({ hostId: h.host.id })).javaKeywords).toEqual(['legacy-java'])
    const persisted = await fs.readFile(repo.filePath, 'utf8')
    expect(persisted).not.toContain('12.5 2.0')
    expect(persisted).not.toContain('APP_OPS_FIXTURE_ONLY')
  })

  it('cancels a held inspection on close without disconnecting SSH or showing a late result', async () => {
    replies.set(probeCommand('mysql', 'top'), { text: '', hold: true })
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-mysql-tab'))
    fireEvent.click(await screen.findByRole('button', { name: 'Top: 231' }))
    await waitFor(() => expect(h.activeProcessQueries).toBe(1))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(h.activeProcessQueries).toBe(0))
    expect(screen.queryByTestId('process-inspection')).toBeNull()
    expect(h.ssh().status).toBe('ready')
  })

  it('rejects foreign bindings, stale generations and arbitrary command/PID payloads before execution', async () => {
    const input = request()
    expect(await api().hostTools({ ...input, hostId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_OWNER' } })
    expect(await api().hostTools({ ...input, generation: input.generation + 1 })).toMatchObject({ ok: false, error: { code: 'STALE_GENERATION' } })
    for (const extra of [{ pid: '231;exit' }, { startTime: '../stat' }, { command: 'anything' }, { pid: -1 }]) {
      await expect(api().hostTools({ ...input, ...extra } as never)).rejects.toThrow('Invalid Electron IPC payload')
    }
    await api().hostTools({ action: 'cancelJava', requestId: input.requestId })
    expect(await api().hostTools(input)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(h.processCommands).toHaveLength(0)
  })

  it('surfaces PID reuse/tool failures explicitly and never turns them into an empty successful list', async () => {
    replies.set(probeCommand('redis', 'ports'), { text: 'CC_HAHA_PROCESS_ERROR\tPROCESS_CHANGED\n' })
    render(<HostDetail />)
    fireEvent.click(screen.getByTestId('host-redis-tab'))
    fireEvent.click(await screen.findByRole('button', { name: 'Ports: 231' }))
    expect(await within(screen.getByTestId('process-inspection')).findByRole('alert')).toHaveTextContent('PROCESS_CHANGED')
    expect(screen.queryByText('No visible matching sockets in this sample.')).toBeNull()
    await act(async () => { await h.fixture.services.sshService.disconnect({ connectionId: h.ssh().connectionId!, ownerId: 'window:99' }) })
    expect(screen.queryByTestId('process-inspection')).toBeNull()
  })
})
