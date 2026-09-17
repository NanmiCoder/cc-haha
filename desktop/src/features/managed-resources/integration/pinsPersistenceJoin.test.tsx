import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { ApplicationFilesPanel } from '../ui/hosts/ApplicationFilesPanel'
import { createHostToolsPreferences } from '../../../../electron/services/managedResources/hostToolsPreferences'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
const scope = () => ({ hostId: h.host.id, applicationId: h.application.id, rootIndex: 0, expectedRoot: h.root })
const panel = (directory: string) => screen.getByRole('region', { name: directory })
const mount = () => render(<ApplicationFilesPanel host={h.host} application={h.application} onConnect={() => {}} />)

// A new OS process imports the production repository, with no shared React state or cache.
function readAfterRestart() {
  const result = spawnSync('bun', ['--no-env-file', '-e', `
    import { createResourceDocumentStore } from './electron/services/managedResources/repositories/resourceDocumentStore.ts'
    import { createHostToolsPreferences } from './electron/services/managedResources/hostToolsPreferences.ts'
    const store = createResourceDocumentStore({ activeConfigDir: process.env.PINS_CONFIG_DIR! })
    console.log(JSON.stringify(await createHostToolsPreferences(store).get(JSON.parse(process.env.PINS_SCOPE!))))
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, env: {
    ...process.env, HOME: h.fixture.tempDir, USERPROFILE: h.fixture.tempDir,
    CLAUDE_CONFIG_DIR: h.fixture.tempDir, PINS_CONFIG_DIR: h.fixture.tempDir, PINS_SCOPE: JSON.stringify(scope()),
  } })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout.trim())
}

beforeEach(async () => {
  useSettingsStore.setState({ locale: 'en' })
  h = await createApplicationOperationsHarness()
})
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await h?.dispose() })

describe('file pin persistence through DOM -> DesktopHost -> IPC -> disk -> new process', () => {
  it.each([['apps', 'jar'], ['conf', 'conf'], ['logs', 'log'], ['bin/bin', 'sh']])('restores %s pins after restart and persists unpin', async (directory, extension) => {
    const filename = `z-常用.${extension}`
    await h.remote.seedFile(`${h.root}/${directory}/${filename}`, 'fixture')
    let view = mount()
    const pin = await within(panel(directory)).findByRole('button', { name: `Pin to top: ${filename}` })
    await waitFor(() => expect(pin).toBeEnabled())
    fireEvent.click(pin)
    await within(panel(directory)).findByRole('button', { name: `Unpin: ${filename}` })
    const restarted = readAfterRestart()
    expect(restarted.pinnedFiles).toContainEqual({ directory, relativePath: filename })
    view.unmount()
    view = mount()
    const unpin = await within(panel(directory)).findByRole('button', { name: `Unpin: ${filename}` })
    expect(within(panel(directory)).getAllByRole('listitem')[0]).toHaveAttribute('data-application-entry', filename)
    fireEvent.click(unpin)
    await within(panel(directory)).findByRole('button', { name: `Pin to top: ${filename}` })
    expect(readAfterRestart().pinnedFiles).toEqual([])
    view.unmount()
    mount()
    await within(panel(directory)).findByRole('button', { name: `Pin to top: ${filename}` })
    expect(h.commands).toHaveLength(0)
  })

  it('migrates version 1 without losing execution user, folds, keywords or unknown document metadata', async () => {
    const repo = createHostToolsPreferences(h.fixture.services.store)
    const key = JSON.stringify([h.host.id, h.application.id, h.root])
    await fs.writeFile(repo.filePath, JSON.stringify({ schemaVersion: 1, marker: 'keep-me', entries: {
      [key]: { runAsUser: 'deploy', collapsed: { apps: true }, javaKeywords: ['mon'] },
    } }))
    const view = mount()
    const pin = await within(panel('logs')).findByRole('button', { name: 'Pin to top: server.log' })
    await waitFor(() => expect(pin).toBeEnabled())
    fireEvent.click(pin)
    await within(panel('logs')).findByRole('button', { name: 'Unpin: server.log' })
    view.unmount()
    expect(readAfterRestart()).toMatchObject({ runAsUser: 'deploy', collapsed: { apps: true }, javaKeywords: ['mon'], pinnedFiles: [{ directory: 'logs', relativePath: 'server.log' }] })
    expect(JSON.parse(await fs.readFile(repo.filePath, 'utf8'))).toMatchObject({ schemaVersion: 3, marker: 'keep-me' })
  })

  it('does not display successful pin state when writing the preferences fails', async () => {
    const repo = createHostToolsPreferences(h.fixture.services.store)
    mount()
    const pin = await within(panel('logs')).findByRole('button', { name: 'Pin to top: server.log' })
    await waitFor(() => expect(pin).toBeEnabled())
    // A real filesystem error, not a mocked repository or component.
    await fs.mkdir(repo.filePath)
    fireEvent.click(pin)
    await screen.findByRole('alert')
    expect(within(panel('logs')).getByRole('button', { name: 'Pin to top: server.log' })).toBeEnabled()
    expect(within(panel('logs')).queryByRole('button', { name: 'Unpin: server.log' })).not.toBeInTheDocument()
    await fs.rmdir(repo.filePath)
    fireEvent.click(pin)
    await within(panel('logs')).findByRole('button', { name: 'Unpin: server.log' })
    expect(readAfterRestart().pinnedFiles).toHaveLength(1)
  })

  it('merges independent pin writes with folds and distinguishes exact directory paths', async () => {
    const api = h.fixture.host.hostManagement
    const write = (patch: object) => api.hostTools({ action: 'savePreferences', scope: scope(), patch } as Parameters<typeof api.hostTools>[0])
    const results = await Promise.all([
      write({ pinFile: { directory: 'logs', relativePath: 'Report.log', pinned: true } }),
      write({ pinFile: { directory: 'logs', relativePath: 'nested/Report.log', pinned: true } }),
      write({ pinFile: { directory: 'conf', relativePath: 'Report.log', pinned: true } }),
      write({ collapsed: { logs: true }, runAsUser: 'deploy' }),
    ])
    expect(results.every(result => result.ok)).toBe(true)
    expect(readAfterRestart()).toMatchObject({ runAsUser: 'deploy', collapsed: { logs: true }, pinnedFiles: [
      { directory: 'logs', relativePath: 'Report.log' }, { directory: 'logs', relativePath: 'nested/Report.log' }, { directory: 'conf', relativePath: 'Report.log' },
    ] })
    expect((await write({ pinFile: { directory: 'logs', relativePath: 'report.log', pinned: false } })).ok).toBe(true)
    expect(readAfterRestart().pinnedFiles).toHaveLength(3)
    const repo = createHostToolsPreferences(h.fixture.services.store)
    const before = await fs.readFile(repo.filePath, 'utf8')
    for (const relativePath of ['../escape', '/absolute', 'a/../b', 'bad\\path', 'line\n.log']) {
      await expect(write({ pinFile: { directory: 'logs', relativePath, pinned: true } })).rejects.toThrow('Invalid Electron IPC payload')
    }
    expect(await fs.readFile(repo.filePath, 'utf8')).toBe(before)
    expect(h.commands).toHaveLength(0)
    expect(path.basename(repo.filePath)).toBe('host-tools-preferences.json')
  })
})
