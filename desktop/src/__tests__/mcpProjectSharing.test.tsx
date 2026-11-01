import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { McpSettings } from '../pages/McpSettings'
import { mcpApi } from '../api/mcp'
import { sessionsApi } from '../api/sessions'
import { useMcpStore } from '../stores/mcpStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import type { McpServerRecord } from '../types/mcp'

vi.mock('../api/mcp', () => ({
  mcpApi: { projectSharing: vi.fn(), projectPaths: vi.fn() },
}))
vi.mock('../api/sessions', () => ({
  sessionsApi: { getRecentProjects: vi.fn() },
}))

const config = { type: 'stdio' as const, command: 'echo', args: ['shared'], env: {} }
const server: McpServerRecord = {
  name: 'shared-tools', scope: 'project', transport: 'stdio', enabled: false,
  status: 'disabled', statusLabel: 'Disabled', configLocation: '/projects/a/.mcp.json',
  summary: 'echo shared', canEdit: true, canRemove: true, canReconnect: true, canToggle: true,
  projectPath: '/projects/a', config,
}
const projects = [
  { projectPath: '/projects/a', revision: 'a1', selected: true },
  { projectPath: '/projects/b', revision: null, selected: false },
  { projectPath: '/projects/other', revision: 'other1', selected: false, conflict: true },
]
const saveProjectSharing = vi.fn()
const fetchServersForKnownProjects = vi.fn().mockResolvedValue(undefined)

async function openEditor() {
  render(<McpSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open shared-tools' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Target projects' }))
  await screen.findByRole('checkbox', { name: '/projects/a' })
}

describe('MCP project sharing from settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({ projects: [] })
    vi.mocked(mcpApi.projectPaths).mockResolvedValue({ projectPaths: [] })
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({ projects, config })
    useMcpStore.setState({
      servers: [server], selectedServer: null, isLoading: false, error: null,
      fetchServersForKnownProjects, saveProjectSharing, selectServer: vi.fn(),
    })
    saveProjectSharing.mockResolvedValue({ results: [
      { projectPath: '/projects/a', selected: true, success: true, revision: 'a2' },
      { projectPath: '/projects/b', selected: true, success: true, revision: 'b1' },
    ] })
  })

  it('saves two selected projects and leaves a different same-name configuration untouched', async () => {
    await openEditor()
    expect(screen.getByRole('checkbox', { name: '/projects/a' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '/projects/other' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/b' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })

    expect(saveProjectSharing).toHaveBeenCalledWith('shared-tools', {
      config,
      sourceCwd: '/projects/a',
      targets: [
        { projectPath: '/projects/a', selected: true, expectedRevision: 'a1' },
        { projectPath: '/projects/b', selected: true, expectedRevision: null },
      ],
    }, undefined)
    expect(screen.getByRole('button', { name: /Add server/i })).toBeInTheDocument()
  })

  it('allows clearing the existing selection and sends a precise removal on Save', async () => {
    saveProjectSharing.mockResolvedValue({ results: [
      { projectPath: '/projects/a', selected: false, success: true, revision: 'a2' },
    ] })
    await openEditor()
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/a' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(saveProjectSharing.mock.calls[0]![1].targets).toEqual([
      { projectPath: '/projects/a', selected: false, expectedRevision: 'a1' },
    ])
  })

  it('reports each partial failure, keeps the editor open and retries with successful revisions', async () => {
    saveProjectSharing.mockResolvedValueOnce({ results: [
      { projectPath: '/projects/a', selected: true, success: true, revision: 'a2' },
      { projectPath: '/projects/b', selected: true, success: false, error: 'Target changed; reload its configuration.' },
    ] })
    await openEditor()
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/b' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('/projects/b')
    expect(screen.getByRole('alert')).toHaveTextContent('Target changed')
    expect(useUIStore.getState().toasts.some(toast => toast.type === 'success')).toBe(false)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(saveProjectSharing.mock.calls[1]![1].targets[0].expectedRevision).toBe('a2')
  })

  it('cancels checkbox changes without writing configuration', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/a' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/b' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Back to servers' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Add server/i })).toBeInTheDocument())
    expect(saveProjectSharing).not.toHaveBeenCalled()
  })

  it('rediscovers all shared projects when the editor is reopened', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({
      config, projects: projects.map(project => project.projectPath === '/projects/b' ? { ...project, revision: 'b1', selected: true } : project),
    })
    await openEditor()
    expect(screen.getByRole('checkbox', { name: '/projects/a' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '/projects/b' })).toBeChecked()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: /^User/ })).toBeDisabled()
  })

  it('creates project sharing only after explicit selection, including a single target', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({ projects: projects.map(project => ({ ...project, selected: false, conflict: false })) })
    render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add server/i }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'new-shared' } })
    fireEvent.change(screen.getByLabelText(/Command to launch/), { target: { value: 'echo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Project Shared/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Target projects' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Target projects' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/b' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(saveProjectSharing.mock.calls[0]![1]).toEqual({
      config: { type: 'stdio', command: 'echo', args: [], env: {} },
      targets: [{ projectPath: '/projects/b', selected: true, expectedRevision: null }],
    })
  })

  it('keeps raw source variables when the discovered runtime config had expanded them', async () => {
    const sourceConfig = { ...config, env: { FIXTURE_TOKEN: '${FIXTURE_TOKEN}' }, futureField: { keep: true } }
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({ projects, config: sourceConfig, sourceConfig })
    await openEditor()
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(saveProjectSharing.mock.calls[0]![1].config.env).toEqual({ FIXTURE_TOKEN: '${FIXTURE_TOKEN}' })
    expect(saveProjectSharing.mock.calls[0]![1].sourceConfig).toEqual(sourceConfig)
  })

  it('retains the original membership fingerprint when reloading after source removal', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({ config, projects: projects.slice(0, 2).map(project => ({ ...project, selected: true, configHash: 'original-config' })) })
    saveProjectSharing.mockResolvedValueOnce({ results: [
      { projectPath: '/projects/a', selected: false, success: true, revision: 'a2' },
      { projectPath: '/projects/b', selected: false, success: false, error: 'Target changed' },
    ] })
    await openEditor()
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/a' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '/projects/b' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload project status' })) })
    expect(mcpApi.projectSharing).toHaveBeenLastCalledWith('shared-tools', expect.arrayContaining(['/projects/a', '/projects/b']), '/projects/a', ['original-config'])
  })

  it('disables saving when project status could not be read', async () => {
    vi.mocked(mcpApi.projectSharing).mockRejectedValue(new Error('Could not read project status'))
    render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open shared-tools' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read project status')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('waits for raw source configuration before accepting edits', async () => {
    let resolvePreview!: (value: { config: typeof config; projects: typeof projects }) => void
    vi.mocked(mcpApi.projectSharing).mockImplementation(() => new Promise(resolve => { resolvePreview = resolve }))
    render(<McpSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open shared-tools' }))
    expect(screen.getByLabelText(/Command to launch/)).toBeDisabled()
    await waitFor(() => expect(mcpApi.projectSharing).toHaveBeenCalled())
    await act(async () => { resolvePreview({ config, projects }) })
    expect(screen.getByLabelText(/Command to launch/)).toBeEnabled()
  })
})
