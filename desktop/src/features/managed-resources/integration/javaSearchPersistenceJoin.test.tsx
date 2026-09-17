import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { HostDetail } from '../ui/hosts/HostDetail'
import { useHostManagementStore } from '../stores/hostManagementStore'
import { useHostSshStore } from '../stores/hostSshStore'
import { createHostToolsPreferences } from '../../../../electron/services/managedResources/hostToolsPreferences'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
const search = () => screen.getByRole('searchbox', { name: 'Search PID, command line or heap options' })
const preferences = () => createHostToolsPreferences(h.fixture.services.store)
const hostScope = () => ({ hostId: h.host.id })
const queryOnDisk = () => preferences().get(hostScope())
const frame = 'CC_HAHA_JAVA_V1\n' + [
  [21, ['java', '-Xmx2g', '-jar', '/srv/deup-ai 服务.jar']],
  [22, ['java', '-Xmx1g', 'demo.Scheduler']],
].map(([pid, args]) => `${pid}\t${Buffer.from((args as string[]).join('\0') + '\0').toString('base64')}\n`).join('') + 'CC_HAHA_JAVA_END\t0\n'

async function openJava() {
  fireEvent.click(screen.getByTestId('host-java-tab'))
  await waitFor(() => expect(search()).toBeEnabled())
}
async function reopenJava() {
  fireEvent.click(screen.getByTestId('host-applications-tab'))
  await openJava()
}
function afterProcessRestart() {
  const result = spawnSync('bun', ['--no-env-file', '-e', `
    import { createResourceDocumentStore } from './electron/services/managedResources/repositories/resourceDocumentStore.ts'
    import { createHostToolsPreferences } from './electron/services/managedResources/hostToolsPreferences.ts'
    const store = createResourceDocumentStore({ activeConfigDir: process.env.SEARCH_CONFIG_DIR! })
    console.log(JSON.stringify(await createHostToolsPreferences(store).get({ hostId: process.env.SEARCH_HOST_ID! })))
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, env: {
    ...process.env, HOME: h.fixture.tempDir, USERPROFILE: h.fixture.tempDir,
    CLAUDE_CONFIG_DIR: h.fixture.tempDir, SEARCH_CONFIG_DIR: h.fixture.tempDir, SEARCH_HOST_ID: h.host.id,
  } })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout.trim())
}

beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  useSettingsStore.setState({ locale: 'en' })
  h = await createApplicationOperationsHarness()
  h.setJavaOutput(frame)
})
afterEach(async () => { cleanup(); await h?.dispose(); vi.unstubAllGlobals() })

describe('last Java search through real DOM -> DesktopHost -> IPC -> disk -> new process', () => {
  it('matches whitespace-separated terms with OR across command, PID and heap, never duplicating rows or interpreting regex', async () => {
    const processes: Array<[number, string[]]> = [
      [21, ['java', '-Xmx2g', '-Xms384m', '-jar', '/srv/deup-ai 服务.jar']],
      [22, ['java', '-Xmx1g', 'demo.Scheduler']],
      [23, ['java', '-Xmx512m', '-Xms128m', 'demo.Monitor']],
      [24, ['java', '-Xmx768m', '-jar', '/srv/café[1].jar']],
    ]
    h.setJavaOutput('CC_HAHA_JAVA_V1\n' + processes.map(([pid, args]) => `${pid}\t${Buffer.from(args.join('\0') + '\0').toString('base64')}\n`).join('') + 'CC_HAHA_JAVA_END\t0\n')
    render(<HostDetail />)
    await openJava()
    expect(search()).toHaveAccessibleDescription('Separate keywords with spaces; match any keyword (OR).')
    const ids = () => [...document.querySelectorAll('[data-java-pid]')].map(row => Number(row.getAttribute('data-java-pid')))
    await waitFor(() => expect(ids()).toEqual([21, 22, 23, 24]))
    const cases: Array<[string, number[]]> = [
      ['deup-ai Scheduler', [21, 22]],
      ['  DEUP-AI   sChEdUlEr  ', [21, 22]],
      ['服务\u3000Scheduler', [21, 22]],
      ['21\t128m', [21, 23]],
      ['2g 128m', [21, 23]],
      ['deup-ai deup deup-ai', [21]],
      ['cafe\u0301 不存在', [24]],
      ['[1] $.*', [24]],
      ['.* ^', []],
      ['', [21, 22, 23, 24]],
      [' \t\u3000 ', [21, 22, 23, 24]],
      ['服务', [21]],
    ]
    for (const [value, expected] of cases) {
      fireEvent.change(search(), { target: { value } })
      await waitFor(() => expect(ids(), value).toEqual(expected))
      await waitFor(async () => expect((await queryOnDisk()).lastJavaSearch).toBe(value))
    }
    expect(h.commands).toHaveLength(0)
  })

  it('restores a multi-term OR query from a new process and saves/selects it as one keyword', async () => {
    const view = render(<HostDetail />)
    await openJava()
    const value = 'deup-ai  Scheduler'
    fireEvent.change(search(), { target: { value } })
    await waitFor(async () => expect((await queryOnDisk()).lastJavaSearch).toBe(value))
    expect(afterProcessRestart().lastJavaSearch).toBe(value)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save keyword' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save keyword' }))
    await waitFor(async () => expect((await queryOnDisk()).javaKeywords).toEqual([value]))
    view.unmount()
    render(<HostDetail />)
    await openJava()
    expect(search()).toHaveValue(value)
    await waitFor(() => expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(2))
    fireEvent.change(search(), { target: { value: 'missing' } })
    await waitFor(async () => expect((await queryOnDisk()).lastJavaSearch).toBe('missing'))
    expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'deup-ai Scheduler' }))
    await waitFor(() => expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(2))
    await waitFor(async () => expect((await queryOnDisk()).lastJavaSearch).toBe(value))
    await reopenJava()
    expect(search()).toHaveValue(value)
    await waitFor(() => expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(2))
    expect(afterProcessRestart()).toMatchObject({ lastJavaSearch: value, javaKeywords: [value] })
    expect(h.commands).toHaveLength(0)
  })

  it('keeps OR filtering when refreshed process data arrives and clears back to all rows', async () => {
    render(<HostDetail />)
    await openJava()
    fireEvent.change(search(), { target: { value: 'deup-ai Worker' } })
    await waitFor(() => expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(1))
    await waitFor(async () => expect((await queryOnDisk()).lastJavaSearch).toBe('deup-ai Worker'))
    const next = frame.replace('CC_HAHA_JAVA_END\t0\n', `23\t${Buffer.from('java\0demo.Worker\0').toString('base64')}\nCC_HAHA_JAVA_END\t0\n`)
    h.setJavaOutput(next)
    const refresh = within(screen.getByTestId('java-processes-panel')).getByRole('button', { name: 'Refresh' })
    await waitFor(() => expect(refresh).toBeEnabled())
    fireEvent.click(refresh)
    await waitFor(() => expect([...document.querySelectorAll('[data-java-pid]')].map(row => row.getAttribute('data-java-pid'))).toEqual(['21', '23']))
    fireEvent.change(search(), { target: { value: '' } })
    await waitFor(() => expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(3))
    await waitFor(async () => expect((await queryOnDisk()).lastJavaSearch).toBe(''))
    expect(h.commands).toHaveLength(0)
  })

  it('automatically persists the last query and restores both the input and filtered rows without clicking a keyword', async () => {
    const view = render(<HostDetail />)
    await openJava()
    fireEvent.change(search(), { target: { value: 'deup-ai' } })
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: 'deup-ai', javaKeywords: [] }))
    expect(afterProcessRestart()).toMatchObject({ lastJavaSearch: 'deup-ai', javaKeywords: [] })
    view.unmount()
    render(<HostDetail />)
    await openJava()
    await waitFor(() => expect(search()).toHaveValue('deup-ai'))
    await waitFor(() => expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(1))
    expect(document.querySelector('[data-java-pid="21"]')).toBeVisible()
    expect(h.commands).toHaveLength(0)
  })

  it('remembers keyword selection and explicit clearing independently of the saved keyword list', async () => {
    render(<HostDetail />)
    await openJava()
    fireEvent.change(search(), { target: { value: 'deup-ai' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save keyword' })).toBeEnabled())
    fireEvent.blur(search())
    expect(screen.getByRole('button', { name: 'Save keyword' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save keyword' }))
    await screen.findByRole('button', { name: 'deup-ai' })
    fireEvent.change(search(), { target: { value: 'Scheduler' } })
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: 'Scheduler', javaKeywords: ['deup-ai'] }))
    fireEvent.click(screen.getByRole('button', { name: 'deup-ai' }))
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: 'deup-ai' }))
    await reopenJava()
    await waitFor(() => expect(search()).toHaveValue('deup-ai'))
    fireEvent.change(search(), { target: { value: '' } })
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: '', javaKeywords: ['deup-ai'] }))
    await reopenJava()
    expect(search()).toHaveValue('')
    await waitFor(() => expect(document.querySelectorAll('[data-java-pid]')).toHaveLength(2))
    expect(afterProcessRestart()).toMatchObject({ lastJavaSearch: '', javaKeywords: ['deup-ai'] })
  })

  it('keeps the final rapid input when the tab immediately unmounts and never sends query text to SSH', async () => {
    render(<HostDetail />)
    await openJava()
    for (const value of ['d', 'de', 'deup', 'deup-ai', 'deup-ai; $(fixture-only)']) fireEvent.change(search(), { target: { value } })
    fireEvent.click(screen.getByTestId('host-applications-tab'))
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: 'deup-ai; $(fixture-only)' }))
    expect(afterProcessRestart().lastJavaSearch).toBe('deup-ai; $(fixture-only)')
    await openJava()
    await waitFor(() => expect(search()).toHaveValue('deup-ai; $(fixture-only)'))
    expect(h.commands).toHaveLength(0)
  })

  it.each([1, 2])('loads v%s without writing and migrates on input while preserving other preferences', async schemaVersion => {
    const repo = preferences()
    const hostKey = JSON.stringify([h.host.id])
    const appKey = JSON.stringify([h.host.id, h.application.id, h.root])
    const app = { runAsUser: 'deploy', collapsed: { logs: true }, javaKeywords: [], ...(schemaVersion === 2 ? { pinnedFiles: [{ directory: 'logs', relativePath: 'server.log' }] } : {}) }
    const previous = JSON.stringify({ schemaVersion, marker: 'preserve-me', entries: { [hostKey]: { javaKeywords: ['deup-ai'] }, [appKey]: app } })
    await fs.writeFile(repo.filePath, previous)
    render(<HostDetail />)
    await openJava()
    expect(search()).toHaveValue('')
    expect(await fs.readFile(repo.filePath, 'utf8')).toBe(previous)
    fireEvent.change(search(), { target: { value: '  服务  ' } })
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: '  服务  ' }))
    const migrated = JSON.parse(await fs.readFile(repo.filePath, 'utf8'))
    expect(migrated).toMatchObject({ schemaVersion: 3, marker: 'preserve-me' })
    expect(migrated.entries[appKey]).toMatchObject(app)
    expect(afterProcessRestart()).toMatchObject({ lastJavaSearch: '  服务  ', javaKeywords: ['deup-ai'] })
  })

  it('persists completed Chinese input, not intermediate IME composition, and Enter never executes a command', async () => {
    render(<HostDetail />)
    await openJava()
    const input = search()
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'fu wu' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect((await queryOnDisk()).lastJavaSearch).toBe('')
    fireEvent.change(input, { target: { value: '服务' } })
    fireEvent.compositionEnd(input, { data: '服务' })
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: '服务' }))
    await reopenJava()
    await waitFor(() => expect(search()).toHaveValue('服务'))
    expect(h.commands).toHaveLength(0)
  })

  it('reports a real preference write failure, keeps the draft, and retries on blur', async () => {
    render(<HostDetail />)
    await openJava()
    const repo = preferences()
    await fs.mkdir(repo.filePath)
    fireEvent.change(search(), { target: { value: 'deup-ai' } })
    await screen.findByRole('alert')
    expect(search()).toHaveValue('deup-ai')
    await fs.rmdir(repo.filePath)
    fireEvent.blur(search())
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: 'deup-ai' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('bounds persisted input and rejects an application scope without changing existing preferences', async () => {
    const api = h.fixture.host.hostManagement
    const request = { action: 'savePreferences' as const, scope: hostScope(), patch: { lastJavaSearch: 'x'.repeat(120) } }
    expect((await api.hostTools(request)).ok).toBe(true)
    const repo = preferences()
    const before = await fs.readFile(repo.filePath, 'utf8')
    await expect(api.hostTools({ ...request, patch: { lastJavaSearch: 'x'.repeat(121) } })).rejects.toThrow('Invalid Electron IPC payload')
    expect(await api.hostTools({ ...request, scope: { ...hostScope(), applicationId: h.application.id, rootIndex: 0, expectedRoot: h.root } })).toMatchObject({ ok: false, error: { code: 'HOST_TOOLS_FAILED' } })
    expect(await fs.readFile(repo.filePath, 'utf8')).toBe(before)
    expect(h.commands).toHaveLength(0)
  })

  it('isolates the last query between hosts reached by real selection and connection actions', async () => {
    render(<HostDetail />)
    await openJava()
    fireEvent.change(search(), { target: { value: 'deup-ai' } })
    await waitFor(async () => expect(await queryOnDisk()).toMatchObject({ lastJavaSearch: 'deup-ai' }))
    const created = await useHostManagementStore.getState().saveHost({
      name: 'Second fixture', address: h.host.address, port: h.host.port, username: h.host.username,
      auth: { type: 'password', credentialId: null }, credential: { storage: 'vault', secret: { kind: 'ssh-password', password: 'APP_OPS_FIXTURE_ONLY' } },
      tagIds: [], initialDirectory: h.root, notes: '', applications: [],
    })
    if (!created.success) throw new Error('Second fixture could not be saved')
    const other = created.host
    await act(async () => { await useHostSshStore.getState().start(other, 80, 24) })
    await waitFor(() => {
      const ssh = useHostSshStore.getState().byHostId[other.id]
      expect(ssh?.status === 'ready' || Boolean(ssh?.challenge)).toBe(true)
    })
    if (useHostSshStore.getState().byHostId[other.id]?.challenge) await act(async () => { await useHostSshStore.getState().answer(other.id, 'trust') })
    await waitFor(() => expect(useHostSshStore.getState().byHostId[other.id]?.status).toBe('ready'))
    act(() => useHostManagementStore.getState().setSelectedHostId(other.id))
    await openJava()
    expect(search()).toHaveValue('')
    fireEvent.change(search(), { target: { value: 'Scheduler' } })
    await waitFor(async () => expect(await preferences().get({ hostId: other.id })).toMatchObject({ lastJavaSearch: 'Scheduler' }))
    act(() => useHostManagementStore.getState().setSelectedHostId(h.host.id))
    await openJava()
    await waitFor(() => expect(search()).toHaveValue('deup-ai'))
    expect((await preferences().get({ hostId: other.id })).lastJavaSearch).toBe('Scheduler')
    await act(async () => { await useHostSshStore.getState().disconnect(other.id) })
  })
})
