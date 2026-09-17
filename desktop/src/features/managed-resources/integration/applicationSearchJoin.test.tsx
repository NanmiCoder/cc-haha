import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { HostDetail } from '../ui/hosts/HostDetail'
import { en } from '../../../i18n/locales/en'
import { zh } from '../../../i18n/locales/zh'
import { zh as zhTW } from '../../../i18n/locales/zh-TW'
import { jp } from '../../../i18n/locales/jp'
import { kr } from '../../../i18n/locales/kr'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
// Persisting a fold is allowed; search, pin and fullscreen still must not refetch files.
const nonPreferenceCalls = () => h.fixture.calls.filter(channel => channel !== 'desktop:managed-resources:host-tools').length
const panel = (directory: string) => screen.getByRole('region', { name: directory })
const search = (directory: string) => within(panel(directory)).getByRole('searchbox', { name: `Search filenames: ${directory}` })
const names = (directory: string) => within(panel(directory)).queryAllByRole('listitem').map(row => row.getAttribute('data-application-entry'))
const change = (directory: string, value: string) => fireEvent.change(search(directory), { target: { value } })
const click = (directory: string, name: string) => fireEvent.click(within(panel(directory)).getByRole('button', { name }))
async function pinClick(directory: string, name: string) {
  const button = within(panel(directory)).getByRole('button', { name })
  await waitFor(() => expect(button).toBeEnabled())
  const pressed = button.getAttribute('aria-pressed') === 'true'
  fireEvent.click(button)
  await waitFor(() => expect(button).toHaveAttribute('aria-pressed', String(!pressed)))
}
async function open() {
  render(<HostDetail />)
  fireEvent.click(screen.getByTestId('host-applications-tab'))
  for (const dir of ['apps', 'conf', 'logs', 'bin/bin']) {
    await within(panel(dir)).findByRole('list')
  }
}
beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  useSettingsStore.setState({ locale: 'en' })
  h = await createApplicationOperationsHarness()
})
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await h?.dispose(); vi.unstubAllGlobals() })

describe('application directory search and pins through real DOM, store, DesktopHost and IPC', () => {
  it.each([['apps', 'jar'], ['conf', 'conf'], ['logs', 'log'], ['bin/bin', 'sh']])('searches and pins files independently in %s', async (directory, extension) => {
    const filename = `z-服务-REPORT.${extension}`
    await h.remote.seedFile(`${h.root}/${directory}/${filename}`, 'fixture only')
    await h.remote.seedFile(`${h.root}/${directory}/nested/keep.txt`, 'fixture')
    await open()
    const original = names(directory)
    const other = directory === 'logs' ? 'apps' : 'logs'
    const otherNames = names(other)
    const calls = nonPreferenceCalls()
    change(directory, ' 服务-report ')
    expect(names(directory)).toEqual([filename])
    expect(names(other)).toEqual(otherNames)
    await pinClick(directory, `Pin to top: ${filename}`)
    expect(within(panel(directory)).getByRole('button', { name: `Unpin: ${filename}`, pressed: true })).toBeVisible()
    click(directory, `Clear search: ${directory}`)
    expect(names(directory)).toEqual([filename, ...original.filter(name => name !== filename)])
    await pinClick(directory, `Unpin: ${filename}`)
    expect(names(directory)).toEqual(original)
    expect(nonPreferenceCalls()).toBe(calls)
    expect(h.commands).toHaveLength(0)
    expect(await h.remote.fileExists(`${h.root}/${directory}/${filename}`)).toBe(true)
  })

  it('treats special characters literally and distinguishes case-sensitive Linux paths when pinning', async () => {
    for (const name of ['report.log', 'Report.log', '.hidden.log', 'a[1].log']) await h.remote.seedFile(`${h.root}/logs/${name}`, 'fixture')
    // Windows' disk-backed fake SFTP aliases case-only names. Model the missing Linux
    // directory entry at the fake driver boundary, not in the UI, store or tested service.
    const { sftp } = await h.fixture.services.sftpService.ensureSftp(h.ssh().connectionId!, 'window:99')
    const readdir = sftp.readdir.bind(sftp)
    vi.spyOn(sftp, 'readdir').mockImplementation((remotePath, done) => {
      readdir(remotePath, (error, entries) => {
        if (!error && remotePath === h.root + '/logs') {
          const report = entries.find(entry => entry.filename === 'report.log')
          if (report && !entries.some(entry => entry.filename === 'Report.log')) {
            entries = [...entries, { ...report, filename: 'Report.log', longname: 'Report.log' }]
          }
        }
        done(error, entries)
      })
    })
    await open()
    change('logs', '[1]')
    expect(names('logs')).toEqual(['a[1].log'])
    change('logs', '.HIDDEN')
    expect(names('logs')).toEqual(['.hidden.log'])
    change('logs', 'REPORT')
    expect(names('logs')).toHaveLength(2)
    await pinClick('logs', 'Pin to top: report.log')
    expect(names('logs')).toEqual(['report.log', 'Report.log'])
    expect(within(panel('logs')).getByRole('button', { name: 'Pin to top: Report.log', pressed: false })).toBeVisible()
    change('logs', 'not-present')
    expect(names('logs')).toEqual([])
    expect(within(panel('logs')).getByText('No matching filenames in this directory.')).toBeVisible()
    click('logs', 'Clear search: logs')
    expect(names('logs')[0]).toBe('report.log')
  })

  it('preserves search and pins through refresh, horizontal collapse and fullscreen, without leaking into another directory', async () => {
    await h.remote.seedFile(h.root + '/logs/z-report.log', 'fixture')
    await h.remote.seedFile(h.root + '/logs/nested/z-report.log', 'nested fixture')
    await h.remote.seedFile(h.root + '/logs/nested/a.log', 'fixture')
    await open()
    change('logs', 'report')
    await pinClick('logs', 'Pin to top: z-report.log')
    await h.remote.seedFile(h.root + '/logs/a-report.log', 'new file')
    click('logs', 'Refresh: logs')
    await waitFor(() => expect(names('logs')).toEqual(['z-report.log', 'a-report.log']))
    const calls = nonPreferenceCalls()
    const input = search('logs')
    click('logs', 'logs')
    expect(input).not.toBeVisible()
    click('logs', 'logs')
    expect(search('logs')).toBe(input)
    expect(input).toHaveValue('report')
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(search('logs')).toBe(input)
    expect(input).toHaveValue('report')
    expect(names('logs')[0]).toBe('z-report.log')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'true')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'false')
    expect(nonPreferenceCalls()).toBe(calls)
    change('logs', 'nested')
    click('logs', 'nested')
    await within(panel('logs')).findByRole('button', { name: 'a.log' })
    expect(search('logs')).toHaveValue('')
    expect(names('logs')).toEqual(['nested/a.log', 'nested/z-report.log'])
    expect(within(panel('logs')).getByRole('button', { name: 'Pin to top: z-report.log', pressed: false })).toBeVisible()
    click('logs', 'Parent directory: logs')
    await waitFor(() => expect(names('logs')[0]).toBe('z-report.log'))
    expect(h.commands).toHaveLength(0)
  })

  it('deletes only the selected pinned log and never displays a ghost row after refresh', async () => {
    await h.remote.seedFile(h.root + '/logs/z-delete.log', 'fixture')
    await open()
    change('logs', 'delete')
    await pinClick('logs', 'Pin to top: z-delete.log')
    click('logs', 'Delete log: z-delete.log')
    expect(await h.remote.fileExists(h.root + '/logs/z-delete.log')).toBe(true)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this remote log?' })).getByRole('button', { name: 'Delete log' }))
    await waitFor(() => expect(within(panel('logs')).getByText('No matching filenames in this directory.')).toBeVisible())
    expect(await h.remote.fileExists(h.root + '/logs/z-delete.log')).toBe(false)
    click('logs', 'Clear search: logs')
    expect(names('logs')).toEqual(['server.log'])
    expect(within(panel('logs')).queryByRole('button', { name: 'Unpin: z-delete.log' })).not.toBeInTheDocument()
  })

  it('handles IME composition and Enter without launching commands or losing fullscreen', async () => {
    await h.remote.seedFile(h.root + '/bin/bin/中文.sh', '# fixture')
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    const input = search('bin/bin')
    const original = names('bin/bin')
    const calls = nonPreferenceCalls()
    fireEvent.compositionStart(input)
    change('bin/bin', '中文')
    expect(names('bin/bin')).toEqual(original)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(screen.getByTestId('application-workspace')).toHaveAttribute('data-fullscreen', 'true')
    fireEvent.compositionEnd(input, { data: '中文' })
    expect(names('bin/bin')).toEqual(['中文.sh'])
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.commands).toHaveLength(0)
    expect(nonPreferenceCalls()).toBe(calls)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

it('provides search and pin labels in all five locales', () => {
  for (const dictionary of [en, zh, zhTW, jp, kr]) {
    for (const key of ['search', 'searchPlaceholder', 'clearSearch', 'noMatches', 'searchCount', 'pin', 'unpin']) {
      expect((dictionary as Record<string, string>)[`managedResources.appOperations.${key}`]).toBeTruthy()
    }
  }
})
