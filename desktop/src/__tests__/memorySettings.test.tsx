import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { MemorySettings } from '../pages/MemorySettings'
import { useMemoryStore } from '../stores/memoryStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import type { PreviewLinkTarget } from '@/lib/previewLinkRouter'

const { memoryApiMock } = vi.hoisted(() => ({
  memoryApiMock: {
    listProjects: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    saveFile: vi.fn(),
  },
}))

vi.mock('../api/memory', () => ({
  memoryApi: memoryApiMock,
}))

vi.mock('../components/markdown/MarkdownRenderer', async () => {
  const { classifyPreviewLink } = await import('@/lib/previewLinkRouter')
  return {
    MarkdownRenderer: ({ content, onLinkClick }: { content: string; onLinkClick?: (href: PreviewLinkTarget) => boolean | void }) => {
      const match = content.match(/\[([^\]]+)\]\(([^)]+)\)/)
      const linkText = match?.[1]
      const linkHref = match?.[2]
      return (
        <div data-testid="markdown-preview">
          {content}
          {linkText && linkHref ? (
            <a
              href={linkHref}
              onClick={(event) => {
                const parsed = classifyPreviewLink(linkHref)
                if (onLinkClick?.(parsed.path ? { path: parsed.path } : linkHref)) {
                  event.preventDefault()
                }
              }}
            >
              {linkText}
            </a>
          ) : null}
        </div>
      )
    },
  }
})

const SESSION_WRITTEN_MEMORY = ['# Project Memory', '', '- Written by a session.', ''].join('\n')

describe('MemorySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Active session',
          createdAt: '2026-05-01T00:00:00.000Z',
          modifiedAt: '2026-05-01T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/workspace/demo',
          workDir: '/workspace/demo',
          workDirExists: true,
        },
      ],
      activeSessionId: 'session-1',
    })
    useMemoryStore.setState({
      projects: [],
      files: [],
      selectedProjectId: null,
      selectedFile: null,
      draftContent: '',
      isLoadingProjects: false,
      isLoadingFiles: false,
      isLoadingFile: false,
      isSaving: false,
      error: null,
      lastSavedAt: null,
    })
    useUIStore.setState({ activeSettingsTab: 'providers', pendingMemoryPath: null, pendingSettingsTab: null })

    memoryApiMock.listProjects.mockResolvedValue({
      projects: [
        {
          id: '-workspace-demo',
          label: '/workspace/demo',
          memoryDir: '/tmp/claude/projects/-workspace-demo/memory',
          exists: true,
          fileCount: 1,
          isCurrent: true,
        },
      ],
    })
    memoryApiMock.listFiles.mockResolvedValue({
      files: [
        {
          path: 'MEMORY.md',
          name: 'MEMORY.md',
          title: 'MEMORY.md',
          bytes: 18,
          updatedAt: '2026-05-01T00:00:00.000Z',
          type: 'project',
          description: 'Project conventions.',
          isIndex: true,
        },
      ],
    })
    memoryApiMock.readFile.mockResolvedValue({
      file: {
        path: 'MEMORY.md',
        content: '# Project Memory\n',
        updatedAt: '2026-05-01T00:00:00.000Z',
        bytes: 18,
      },
    })
    memoryApiMock.saveFile.mockResolvedValue({
      ok: true,
      file: {
        path: 'MEMORY.md',
        updatedAt: '2026-05-01T00:01:00.000Z',
        bytes: 28,
      },
    })
  })

  it('opens memory files in preview mode, edits on demand, and returns to preview after save', async () => {
    render(<MemorySettings />)

    expect(await screen.findByText('Project Memory')).toBeInTheDocument()
    expect(memoryApiMock.listProjects).toHaveBeenCalledWith('/workspace/demo')
    expect(await screen.findAllByText('workspace/demo')).not.toHaveLength(0)
    expect(await screen.findAllByText('MEMORY.md')).not.toHaveLength(0)
    expect(screen.queryByText('Project conventions.')).not.toBeInTheDocument()
    expect(screen.queryByText('Index')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('MEMORY.md or notes/project.md')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create memory file/i })).not.toBeInTheDocument()

    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const editor = await screen.findByLabelText('Editor')
    expect(editor).toHaveValue('# Project Memory\n')

    fireEvent.change(editor, {
      target: { value: '# Project Memory\n\n- Prefer small diffs.\n' },
    })
    expect(screen.getByText('Unsaved')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(memoryApiMock.saveFile).toHaveBeenCalledWith({
        projectId: '-workspace-demo',
        path: 'MEMORY.md',
        content: '# Project Memory\n\n- Prefer small diffs.\n',
        expectedUpdatedAt: '2026-05-01T00:00:00.000Z',
        expectedBytes: 18,
      })
    })
    expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument()
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Prefer small diffs')
  })

  it('does not select a missing current project with no memory files', async () => {
    memoryApiMock.listProjects.mockResolvedValue({
      projects: [
        {
          id: '-programs-claude-code',
          label: 'C:\\Programs\\claude-code',
          memoryDir: 'C:\\Users\\HUAWEI\\.claude\\projects\\-programs-claude-code\\memory',
          exists: false,
          fileCount: 0,
          isCurrent: true,
        },
      ],
    })

    render(<MemorySettings />)

    await waitFor(() => {
      expect(screen.getAllByText('Programs/claude-code')).toHaveLength(1)
    })
    expect(screen.getByText('Missing')).toBeInTheDocument()
    expect(screen.getAllByText('No file selected').length).toBeGreaterThan(0)
    expect(screen.getByText('Select a project.')).toBeInTheDocument()
    expect(screen.queryByText(/HUAWEI/)).not.toBeInTheDocument()
    expect(memoryApiMock.listFiles).not.toHaveBeenCalled()
    expect(useMemoryStore.getState().selectedProjectId).toBeNull()
  })

  it('lets the markdown editor fill the remaining detail pane height', async () => {
    render(<MemorySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    const editor = await screen.findByLabelText('Editor')
    expect(editor).toHaveClass('min-h-0', 'flex-1', 'resize-none')
    expect(editor.parentElement).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col')
  })

  it('cancels edit mode by discarding the unsaved draft', async () => {
    render(<MemorySettings />)

    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const editor = await screen.findByLabelText('Editor')
    fireEvent.change(editor, {
      target: { value: '# Changed Memory\n' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(memoryApiMock.saveFile).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument()
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    expect(screen.queryByText('Changed Memory')).not.toBeInTheDocument()
  })

  it('keeps unsaved edits when file switching is not confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    memoryApiMock.listFiles.mockResolvedValue({
      files: [
        {
          path: 'MEMORY.md',
          name: 'MEMORY.md',
          title: 'MEMORY.md',
          bytes: 18,
          updatedAt: '2026-05-01T00:00:00.000Z',
          type: 'project',
          description: 'Project conventions.',
          isIndex: true,
        },
        {
          path: 'notes/manual.md',
          name: 'manual.md',
          title: 'Manual',
          bytes: 42,
          updatedAt: '2026-05-01T00:02:00.000Z',
          type: 'guidance',
          description: 'Operator workflow.',
          isIndex: false,
        },
      ],
    })
    memoryApiMock.readFile.mockImplementation((_projectId: string, path: string) => Promise.resolve({
      file: {
        path,
        content: path === 'notes/manual.md' ? '# Manual\n' : '# Project Memory\n',
        updatedAt: '2026-05-01T00:00:00.000Z',
        bytes: 18,
      },
    }))

    render(<MemorySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const editor = await screen.findByLabelText('Editor')
    fireEvent.change(editor, {
      target: { value: '# Unsaved Memory\n' },
    })

    fireEvent.click(screen.getByText('Manual'))

    expect(confirmSpy).toHaveBeenCalled()
    expect(memoryApiMock.readFile).not.toHaveBeenCalledWith('-workspace-demo', 'notes/manual.md')
    expect(screen.getByLabelText('Editor')).toHaveValue('# Unsaved Memory\n')

    confirmSpy.mockRestore()
  })

  it('keeps edits made during a save in the editor until they are saved', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    memoryApiMock.listFiles.mockResolvedValue({
      files: [
        {
          path: 'MEMORY.md',
          name: 'MEMORY.md',
          title: 'MEMORY.md',
          bytes: 18,
          updatedAt: '2026-05-01T00:00:00.000Z',
          isIndex: true,
        },
        {
          path: 'notes/manual.md',
          name: 'manual.md',
          title: 'Manual',
          bytes: 18,
          updatedAt: '2026-05-01T00:00:00.000Z',
          isIndex: false,
        },
      ],
    })
    memoryApiMock.readFile.mockImplementation((_projectId: string, path: string) => Promise.resolve({
      file: {
        path,
        content: path === 'MEMORY.md' ? '# Project Memory\n' : '# Manual\n',
        updatedAt: '2026-05-01T00:00:00.000Z',
        bytes: 18,
      },
    }))
    let resolveFirstSave!: (value: { ok: true; file: { path: string; updatedAt: string; bytes: number } }) => void
    memoryApiMock.saveFile.mockReturnValueOnce(new Promise((resolve) => { resolveFirstSave = resolve }))

    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# First edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# First edit\nContinued typing' } })

    await act(async () => {
      resolveFirstSave({
        ok: true,
        file: { path: 'MEMORY.md', updatedAt: '2026-05-01T00:01:00.000Z', bytes: 12 },
      })
    })

    expect(screen.getByLabelText('Editor')).toHaveValue('# First edit\nContinued typing')
    expect(screen.getByText('Unsaved')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Manual'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(memoryApiMock.readFile).not.toHaveBeenCalledWith('-workspace-demo', 'notes/manual.md')
    expect(useMemoryStore.getState().draftContent).toBe('# First edit\nContinued typing')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(memoryApiMock.saveFile).toHaveBeenLastCalledWith({
      projectId: '-workspace-demo',
      path: 'MEMORY.md',
      content: '# First edit\nContinued typing',
      expectedUpdatedAt: '2026-05-01T00:01:00.000Z',
      expectedBytes: 12,
    }))
    await waitFor(() => expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument())
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument()
    confirmSpy.mockRestore()
  })

  it('asks before leaving a dirty file even when showing its preview', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    memoryApiMock.listFiles.mockResolvedValue({ files: [
      { path: 'MEMORY.md', name: 'MEMORY.md', title: 'MEMORY.md', bytes: 18, updatedAt: '2026-05-01T00:00:00.000Z', isIndex: true },
      { path: 'notes/manual.md', name: 'manual.md', title: 'Manual', bytes: 18, updatedAt: '2026-05-01T00:00:00.000Z', isIndex: false },
    ] })

    render(<MemorySettings />)
    await screen.findByTestId('markdown-preview')
    act(() => useMemoryStore.setState({ draftContent: '# Unsaved preview' }))

    expect(screen.getByText('Unsaved')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Manual'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(memoryApiMock.readFile).not.toHaveBeenCalledWith('-workspace-demo', 'notes/manual.md')
    expect(useMemoryStore.getState().draftContent).toBe('# Unsaved preview')
    confirmSpy.mockRestore()
  })

  it('saves with the platform shortcut while editing and returns to preview mode', async () => {
    render(<MemorySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const editor = await screen.findByLabelText('Editor')
    fireEvent.change(editor, {
      target: { value: '# Project Memory\n\n- Shortcut save.\n' },
    })

    fireEvent.keyDown(document, { key: 's', metaKey: true })

    await waitFor(() => {
      expect(memoryApiMock.saveFile).toHaveBeenCalledWith({
        projectId: '-workspace-demo',
        path: 'MEMORY.md',
        content: '# Project Memory\n\n- Shortcut save.\n',
        expectedUpdatedAt: '2026-05-01T00:00:00.000Z',
        expectedBytes: 18,
      })
    })
    expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument()
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Shortcut save')
  })

  it('filters the unified resource tree by project path', async () => {
    memoryApiMock.listProjects.mockResolvedValue({
      projects: [
        {
          id: '-workspace-alpha',
          label: '/workspace/alpha',
          memoryDir: '/tmp/claude/projects/-workspace-alpha/memory',
          exists: true,
          fileCount: 1,
          isCurrent: true,
        },
        {
          id: '-workspace-beta',
          label: '/workspace/beta',
          memoryDir: '/tmp/claude/projects/-workspace-beta/memory',
          exists: true,
          fileCount: 2,
          isCurrent: false,
        },
      ],
    })

    render(<MemorySettings />)

    expect(await screen.findAllByText('workspace/alpha')).not.toHaveLength(0)
    expect(await screen.findByText('workspace/beta')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search projects or memory files...'), {
      target: { value: 'beta' },
    })

    expect(screen.queryByRole('button', { name: /workspace\/alpha/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('workspace/beta').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle workspace/beta' }))
    await waitFor(() => {
      expect(useMemoryStore.getState().selectedProjectId).toBe('-workspace-beta')
    })
  })

  it('renders nested memory files as a collapsible resource tree', async () => {
    memoryApiMock.listFiles.mockResolvedValue({
      files: [
        {
          path: 'MEMORY.md',
          name: 'MEMORY.md',
          title: 'MEMORY.md',
          bytes: 18,
          updatedAt: '2026-05-01T00:00:00.000Z',
          type: 'project',
          description: 'Project conventions.',
          isIndex: true,
        },
        {
          path: 'notes/manual.md',
          name: 'manual.md',
          title: 'Manual',
          bytes: 42,
          updatedAt: '2026-05-01T00:02:00.000Z',
          type: 'guidance',
          description: 'Operator workflow.',
          isIndex: false,
        },
        {
          path: 'notes/archive/old.md',
          name: 'old.md',
          title: 'Old note',
          bytes: 24,
          updatedAt: '2026-05-01T00:03:00.000Z',
          isIndex: false,
        },
      ],
    })
    memoryApiMock.readFile.mockImplementation((_projectId: string, path: string) => Promise.resolve({
      file: {
        path,
        content: path === 'notes/manual.md' ? '# Manual\n' : '# Project Memory\n',
        updatedAt: '2026-05-01T00:00:00.000Z',
        bytes: 18,
      },
    }))

    render(<MemorySettings />)

    expect(await screen.findByRole('button', { name: 'Toggle notes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Toggle archive' })).toBeInTheDocument()
    expect(screen.getByText('Manual')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle notes' }))
    expect(screen.queryByText('Manual')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search projects or memory files...'), {
      target: { value: 'manual' },
    })

    expect(screen.getByText('Manual')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Manual'))

    await waitFor(() => {
      expect(memoryApiMock.readFile).toHaveBeenCalledWith('-workspace-demo', 'notes/manual.md')
    })
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Manual')
    expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument()
  })

  it.each(['notes/manual.md', 'notes/literal%20name.md', 'notes/name#hash.md'])(
    'opens linked memory markdown file %s from the parsed preview', async (targetPath) => {
    memoryApiMock.listFiles.mockResolvedValue({
      files: [
        {
          path: 'MEMORY.md',
          name: 'MEMORY.md',
          title: 'MEMORY.md',
          bytes: 48,
          updatedAt: '2026-05-01T00:00:00.000Z',
          type: 'project',
          description: 'Project conventions.',
          isIndex: true,
        },
        {
          path: targetPath,
          name: 'manual.md',
          title: 'Manual',
          bytes: 24,
          updatedAt: '2026-05-01T00:02:00.000Z',
          type: 'guidance',
          isIndex: false,
        },
      ],
    })
    memoryApiMock.readFile.mockImplementation((_projectId: string, path: string) => Promise.resolve({
      file: {
        path,
        content: path !== 'MEMORY.md'
          ? '# Manual\n'
          : `# Project Memory\n\n- [Manual](${targetPath.split('/').map(encodeURIComponent).join('/')})\n`,
        updatedAt: '2026-05-01T00:00:00.000Z',
        bytes: 48,
      },
    }))

    render(<MemorySettings />)

    fireEvent.click(await screen.findByRole('link', { name: 'Manual' }))

    await waitFor(() => {
      expect(memoryApiMock.readFile).toHaveBeenCalledWith('-workspace-demo', targetPath)
    })
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Manual')
    expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument()
  })

  it('keeps frontmatter editable but removes it from the rendered preview', async () => {
    memoryApiMock.readFile.mockResolvedValue({
      file: {
        path: 'MEMORY.md',
        content: '---\ntype: project\n---\n\n# Project Memory\n',
        updatedAt: '2026-05-01T00:00:00.000Z',
        bytes: 39,
      },
    })

    render(<MemorySettings />)

    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    expect(screen.getByTestId('markdown-preview')).not.toHaveTextContent('type: project')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const editor = await screen.findByLabelText('Editor')
    expect(editor).toHaveValue('---\ntype: project\n---\n\n# Project Memory\n')
  })

  it('opens the exact memory file requested from chat', async () => {
    memoryApiMock.listProjects.mockResolvedValue({
      projects: [
        {
          id: '-workspace-demo',
          label: '/workspace/demo',
          memoryDir: '/tmp/claude/projects/-workspace-demo/memory',
          exists: true,
          fileCount: 0,
          isCurrent: true,
        },
        {
          id: '-workspace-other',
          label: '/workspace/other',
          memoryDir: '/tmp/claude/projects/-workspace-other/memory',
          exists: true,
          fileCount: 1,
          isCurrent: false,
        },
      ],
    })
    memoryApiMock.listFiles.mockImplementation((projectId: string) => Promise.resolve({
      files: projectId === '-workspace-other'
        ? [
            {
              path: 'preferences.md',
              name: 'preferences.md',
              title: 'preferences.md',
              bytes: 24,
              updatedAt: '2026-05-01T00:00:00.000Z',
              type: 'preference',
              isIndex: false,
            },
          ]
        : [],
    }))
    memoryApiMock.readFile.mockResolvedValue({
      file: {
        path: 'preferences.md',
        content: '# Preferences\n',
        updatedAt: '2026-05-01T00:00:00.000Z',
        bytes: 24,
      },
    })
    useUIStore.setState({
      pendingMemoryPath: '/tmp/claude/projects/-workspace-other/memory/preferences.md',
    })

    render(<MemorySettings />)

    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Preferences')
    expect(screen.queryByLabelText('Editor')).not.toBeInTheDocument()
    expect(memoryApiMock.readFile).toHaveBeenCalledWith('-workspace-other', 'preferences.md')
    expect(useMemoryStore.getState().selectedProjectId).toBe('-workspace-other')
    expect(useUIStore.getState().pendingMemoryPath).toBeNull()
  })

  it('re-reads the selected memory file when its tree row is clicked again', async () => {
    render(<MemorySettings />)
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')

    memoryApiMock.readFile.mockResolvedValue({ file: {
      path: 'MEMORY.md', content: '# Rewritten on disk',
      updatedAt: '2026-05-01T00:02:00.000Z', bytes: 19,
    } })
    fireEvent.click(screen.getByRole('button', { name: 'MEMORY.md' }))

    await waitFor(() => expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Rewritten on disk'))
    expect(memoryApiMock.readFile).toHaveBeenCalledTimes(2)
    expect(memoryApiMock.readFile).toHaveBeenLastCalledWith('-workspace-demo', 'MEMORY.md')
  })

  it('confirms before re-reading the selected file with an unsaved draft', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<MemorySettings />)
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Unsaved draft' } })

      fireEvent.click(screen.getByRole('button', { name: 'MEMORY.md' }))
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(memoryApiMock.readFile).toHaveBeenCalledTimes(1)
      expect(screen.getByLabelText('Editor')).toHaveValue('# Unsaved draft')

      confirm.mockReturnValue(true)
      memoryApiMock.readFile.mockResolvedValue({ file: {
        path: 'MEMORY.md', content: '# External revision',
        updatedAt: '2026-05-01T00:02:00.000Z', bytes: 19,
      } })
      fireEvent.click(screen.getByRole('button', { name: 'MEMORY.md' }))
      await waitFor(() => expect(screen.getByLabelText('Editor')).toHaveValue('# External revision'))
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(screen.queryByText('Unsaved')).not.toBeInTheDocument()

      // Saving a new draft still uses the revision just read, so the server
      // can reject a subsequent external edit instead of silently overwriting it.
      fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Another draft' } })
      memoryApiMock.saveFile.mockRejectedValueOnce(new Error('File changed on disk'))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.getByText('File changed on disk')).toBeInTheDocument())
      expect(memoryApiMock.saveFile).toHaveBeenCalledWith({
        projectId: '-workspace-demo', path: 'MEMORY.md', content: '# Another draft',
        expectedUpdatedAt: '2026-05-01T00:02:00.000Z', expectedBytes: 19,
      })
      expect(screen.getByLabelText('Editor')).toHaveValue('# Another draft')
    } finally {
      confirm.mockRestore()
    }
  })

  it('keeps edits made while the selected file is being re-read', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    let finishRead!: (value: unknown) => void
    memoryApiMock.readFile.mockReturnValue(new Promise((resolve) => { finishRead = resolve }))

    fireEvent.click(screen.getByRole('button', { name: 'MEMORY.md' }))
    expect(useMemoryStore.getState().isLoadingFile).toBe(true)
    fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Typed during read' } })
    await act(async () => finishRead({ file: {
      path: 'MEMORY.md', content: '# External revision',
      updatedAt: '2026-05-01T00:02:00.000Z', bytes: 19,
    } }))
    expect(screen.getByLabelText('Editor')).toHaveValue('# Typed during read')
    expect(useMemoryStore.getState().selectedFile?.content).toBe('# Project Memory\n')
    expect(useMemoryStore.getState().isLoadingFile).toBe(false)
  })

  it('lets reselecting the current file supersede an in-flight switch', async () => {
    memoryApiMock.listFiles.mockResolvedValue({ files: [
      { path: 'MEMORY.md', name: 'MEMORY.md', title: 'MEMORY.md', bytes: 18, updatedAt: '2026-05-01T00:00:00.000Z', isIndex: true },
      { path: 'manual.md', name: 'manual.md', title: 'Manual', bytes: 18, updatedAt: '2026-05-01T00:00:00.000Z', isIndex: false },
    ] })
    render(<MemorySettings />)
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    let finishOther!: (value: unknown) => void
    memoryApiMock.readFile.mockImplementation((_project: string, path: string) => path === 'manual.md'
      ? new Promise((resolve) => { finishOther = resolve })
      : Promise.resolve({ file: { path, content: '# Current revision', updatedAt: '2026-05-01T00:02:00.000Z', bytes: 18 } }))

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    fireEvent.click(screen.getByRole('button', { name: 'MEMORY.md' }))
    await waitFor(() => expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Current revision'))
    await act(async () => finishOther({ file: {
      path: 'manual.md', content: '# Stale selection', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 17,
    } }))
    expect(useMemoryStore.getState().selectedFile?.path).toBe('MEMORY.md')
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Current revision')
    expect(useMemoryStore.getState().isLoadingFile).toBe(false)
  })

  it('keeps a later file selection when the selected-file re-read finishes afterward', async () => {
    memoryApiMock.listFiles.mockResolvedValue({ files: [
      { path: 'MEMORY.md', name: 'MEMORY.md', title: 'MEMORY.md', bytes: 18, updatedAt: '2026-05-01T00:00:00.000Z', isIndex: true },
      { path: 'manual.md', name: 'manual.md', title: 'Manual', bytes: 18, updatedAt: '2026-05-01T00:00:00.000Z', isIndex: false },
    ] })
    render(<MemorySettings />)
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    let finishRead!: (value: unknown) => void
    memoryApiMock.readFile.mockImplementation((_project: string, path: string) => path === 'MEMORY.md'
      ? new Promise((resolve) => { finishRead = resolve })
      : Promise.resolve({ file: { path, content: '# Manual selected later', updatedAt: '2026-05-01T00:02:00.000Z', bytes: 23 } }))

    fireEvent.click(await screen.findByRole('button', { name: 'MEMORY.md' }))
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    await waitFor(() => expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Manual selected later'))
    await act(async () => finishRead({ file: {
      path: 'MEMORY.md', content: '# Stale revision', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 16,
    } }))
    expect(useMemoryStore.getState().selectedFile?.path).toBe('manual.md')
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Manual selected later')
    expect(useMemoryStore.getState().isLoadingFile).toBe(false)
  })

  it('shows a memory file rewritten on disk after Refresh', async () => {
    render(<MemorySettings />)

    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')

    // A session edits MEMORY.md while the page is open.
    memoryApiMock.listFiles.mockResolvedValue({
      files: [
        {
          path: 'MEMORY.md',
          name: 'MEMORY.md',
          title: 'MEMORY.md',
          bytes: 42,
          updatedAt: '2026-05-01T00:05:00.000Z',
          type: 'project',
          description: 'Project conventions.',
          isIndex: true,
        },
      ],
    })
    memoryApiMock.readFile.mockResolvedValue({
      file: {
        path: 'MEMORY.md',
        content: SESSION_WRITTEN_MEMORY,
        updatedAt: '2026-05-01T00:05:00.000Z',
        bytes: 42,
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))

    await waitFor(() => {
      expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Written by a session')
    })
  })

  it('reloads the file from disk when Refresh discards an unsaved draft', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MemorySettings />)

    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByLabelText('Editor'), {
      target: { value: '# Local draft' },
    })

    memoryApiMock.readFile.mockResolvedValue({
      file: {
        path: 'MEMORY.md',
        content: SESSION_WRITTEN_MEMORY,
        updatedAt: '2026-05-01T00:05:00.000Z',
        bytes: 42,
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))

    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByLabelText('Editor')).toHaveValue(SESSION_WRITTEN_MEMORY)
    })
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument()
    confirmSpy.mockRestore()
  })

  it('preserves edits typed after Refresh started', async () => {
    render(<MemorySettings />)
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    let finishList!: (value: unknown) => void
    memoryApiMock.listFiles.mockReturnValueOnce(new Promise((resolve) => { finishList = resolve }))
    memoryApiMock.readFile.mockResolvedValue({ file: {
      path: 'MEMORY.md', content: '# Disk content',
      updatedAt: '2026-05-01T00:02:00.000Z', bytes: 14,
    } })
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(useMemoryStore.getState().isLoadingFiles).toBe(true)
    fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Typed after Refresh' } })

    await act(async () => finishList({ files: [{
      path: 'MEMORY.md', name: 'MEMORY.md', title: 'MEMORY.md', isIndex: true,
      updatedAt: '2026-05-01T00:02:00.000Z', bytes: 14,
    }] }))
    await waitFor(() => expect(useMemoryStore.getState().isLoadingFiles).toBe(false))
    expect(screen.getByLabelText('Editor')).toHaveValue('# Typed after Refresh')
  })

  it('preserves an explicit file open requested after Refresh started', async () => {
    const list = [
      { path: 'MEMORY.md', name: 'MEMORY.md', title: 'MEMORY.md', isIndex: true, updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 },
      { path: 'notes/manual.md', name: 'manual.md', title: 'manual.md', isIndex: false, updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 },
    ]
    memoryApiMock.listFiles.mockResolvedValue({ files: list })
    let finishManual!: (value: unknown) => void
    const manualRead = new Promise((resolve) => { finishManual = resolve })
    memoryApiMock.readFile.mockImplementation((_project: string, path: string) => path === 'notes/manual.md'
      ? manualRead
      : Promise.resolve({ file: { path, content: '# Index\n[Manual](notes/manual.md)', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 } }))
    render(<MemorySettings />)
    await screen.findByRole('link', { name: 'Manual' })
    let finishList!: (value: unknown) => void
    memoryApiMock.listFiles.mockReturnValueOnce(new Promise((resolve) => { finishList = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(useMemoryStore.getState().isLoadingFiles).toBe(true)
    fireEvent.click(screen.getByRole('link', { name: 'Manual' }))
    expect(memoryApiMock.readFile).toHaveBeenLastCalledWith('-workspace-demo', 'notes/manual.md')
    expect(useMemoryStore.getState().isLoadingFile).toBe(true)

    await act(async () => finishList({ files: list }))
    await waitFor(() => expect(useMemoryStore.getState().isLoadingFiles).toBe(false))
    await act(async () => finishManual({ file: {
      path: 'notes/manual.md', content: '# Manual content',
      updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18,
    } }))
    expect(useMemoryStore.getState().selectedFile?.path).toBe('notes/manual.md')
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Manual content')
  })

  it('keeps a draft when Refresh discard confirmation is rejected', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<MemorySettings />)
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Keep local draft' } })
      memoryApiMock.listProjects.mockClear()
      memoryApiMock.listFiles.mockClear()
      memoryApiMock.readFile.mockClear()
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
      expect(confirm).toHaveBeenCalledOnce()
      expect(memoryApiMock.listProjects).not.toHaveBeenCalled()
      expect(memoryApiMock.listFiles).not.toHaveBeenCalled()
      expect(memoryApiMock.readFile).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Editor')).toHaveValue('# Keep local draft')
    } finally {
      confirm.mockRestore()
    }
  })

  it('reports a reload read failure and retains the unsaved draft', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<MemorySettings />)
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Retained on read failure' } })
      memoryApiMock.readFile.mockRejectedValueOnce(new Error('memory read unavailable'))
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
      expect(await screen.findByText('memory read unavailable')).toBeInTheDocument()
      expect(screen.getByLabelText('Editor')).toHaveValue('# Retained on read failure')
      expect(useMemoryStore.getState().isLoadingFile).toBe(false)
    } finally {
      confirm.mockRestore()
    }
  })

  it('preserves a draft submitted to a pending save while Refresh reads the old disk revision', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<MemorySettings />)
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Submitted draft' } })
      let finishSave!: (value: unknown) => void
      memoryApiMock.saveFile.mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve }))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(useMemoryStore.getState().isSaving).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
      await waitFor(() => expect(useMemoryStore.getState().isLoadingFiles).toBe(false))
      expect(useMemoryStore.getState().isSaving).toBe(true)
      await act(async () => finishSave({ ok: true, file: {
        path: 'MEMORY.md', updatedAt: '2026-05-01T00:01:00.000Z', bytes: 17,
      } }))
      expect(useMemoryStore.getState().selectedFile?.content).toBe('# Submitted draft')
      expect(useMemoryStore.getState().draftContent).toBe('# Submitted draft')
    } finally {
      confirm.mockRestore()
    }
  })

  it('preserves edits made while the refreshed body is still being read', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    let finishRead!: (value: unknown) => void
    memoryApiMock.readFile.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(useMemoryStore.getState().isLoadingFile).toBe(true))
    fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Typed during read' } })

    await act(async () => finishRead({ file: {
      path: 'MEMORY.md', content: '# Disk content',
      updatedAt: '2026-05-01T00:02:00.000Z', bytes: 14,
    } }))
    await waitFor(() => expect(useMemoryStore.getState().isLoadingFile).toBe(false))
    expect(screen.getByLabelText('Editor')).toHaveValue('# Typed during read')
  })

  it('keeps a submitted draft when Save begins during the refreshed body read', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<MemorySettings />)
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Submitted after Refresh' } })
      let finishRead!: (value: unknown) => void
      memoryApiMock.readFile.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve }))
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
      await waitFor(() => expect(useMemoryStore.getState().isLoadingFile).toBe(true))
      let finishSave!: (value: unknown) => void
      memoryApiMock.saveFile.mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve }))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(useMemoryStore.getState().isSaving).toBe(true)
      await act(async () => finishRead({ file: {
        path: 'MEMORY.md', content: '# Disk before Save',
        updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18,
      } }))
      expect(screen.getByLabelText('Editor')).toHaveValue('# Submitted after Refresh')
      await act(async () => finishSave({ ok: true, file: {
        path: 'MEMORY.md', updatedAt: '2026-05-01T00:03:00.000Z', bytes: 25,
      } }))
      expect(useMemoryStore.getState().selectedFile?.content).toBe('# Submitted after Refresh')
      expect(useMemoryStore.getState().draftContent).toBe('# Submitted after Refresh')
    } finally {
      confirm.mockRestore()
    }
  })

  it('keeps a later file selection after the refresh body read has started', async () => {
    const listed = [
      { path: 'MEMORY.md', name: 'MEMORY.md', title: 'MEMORY.md', isIndex: true, updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 },
      { path: 'notes/manual.md', name: 'manual.md', title: 'manual.md', isIndex: false, updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 },
    ]
    memoryApiMock.listFiles.mockResolvedValue({ files: listed })
    memoryApiMock.readFile.mockResolvedValue({ file: { path: 'MEMORY.md', content: '# Index\n[Manual](notes/manual.md)', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 } })
    render(<MemorySettings />)
    await screen.findByRole('link', { name: 'Manual' })
    let finishRead!: (value: unknown) => void
    const pending = new Promise((resolve) => { finishRead = resolve })
    memoryApiMock.readFile.mockImplementation((_project: string, path: string) => path === 'MEMORY.md'
      ? pending
      : Promise.resolve({ file: { path, content: '# Manual after refresh', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 22 } }))
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(useMemoryStore.getState().isLoadingFile).toBe(true))
    fireEvent.click(screen.getByRole('link', { name: 'Manual' }))
    await waitFor(() => expect(useMemoryStore.getState().selectedFile?.path).toBe('notes/manual.md'))
    await act(async () => finishRead({ file: { path: 'MEMORY.md', content: '# Old refresh', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 14 } }))
    expect(useMemoryStore.getState().selectedFile?.path).toBe('notes/manual.md')
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Manual after refresh')
    expect(useMemoryStore.getState().isLoadingFile).toBe(false)
  })

  it('keeps a later project selection after the refresh body read has started', async () => {
    memoryApiMock.listProjects.mockResolvedValue({ projects: [
      { id: '-workspace-demo', label: '/workspace/demo', memoryDir: '/tmp/memory-fixture/demo/memory', exists: true, fileCount: 1, isCurrent: true },
      { id: '-workspace-other', label: '/workspace/other', memoryDir: '/tmp/memory-fixture/other/memory', exists: true, fileCount: 1, isCurrent: false },
    ] })
    memoryApiMock.listFiles.mockImplementation((project: string) => Promise.resolve({ files: [{
      path: project === '-workspace-demo' ? 'MEMORY.md' : 'preferences.md', name: 'memory', title: 'memory',
      isIndex: true, updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18,
    }] }))
    render(<MemorySettings />)
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('Project Memory')
    let finishRead!: (value: unknown) => void
    const pending = new Promise((resolve) => { finishRead = resolve })
    memoryApiMock.readFile.mockImplementation((project: string, path: string) => project === '-workspace-demo'
      ? pending
      : Promise.resolve({ file: { path, content: '# Other project', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 16 } }))
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(useMemoryStore.getState().isLoadingFile).toBe(true))
    const other = screen.getAllByTestId('memory-project-row').find((row) => row.textContent?.includes('other'))!
    fireEvent.click(other)
    await waitFor(() => expect(useMemoryStore.getState().selectedFile?.path).toBe('preferences.md'))
    await act(async () => finishRead({ file: { path: 'MEMORY.md', content: '# Old project read', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 } }))
    expect(useMemoryStore.getState().selectedProjectId).toBe('-workspace-other')
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Other project')
    expect(useMemoryStore.getState().isLoadingFile).toBe(false)
  })

  it('keeps completed save state when the older refresh body read returns afterward', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<MemorySettings />)
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('Editor'), { target: { value: '# Saved while reading' } })
      let finishRead!: (value: unknown) => void
      memoryApiMock.readFile.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve }))
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
      await waitFor(() => expect(useMemoryStore.getState().isLoadingFile).toBe(true))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(useMemoryStore.getState().selectedFile?.content).toBe('# Saved while reading'))
      await waitFor(() => expect(useMemoryStore.getState().isSaving).toBe(false))
      expect(memoryApiMock.readFile).toHaveBeenCalledTimes(2)
      await act(async () => finishRead({ file: { path: 'MEMORY.md', content: '# Disk before save', updatedAt: '2026-05-01T00:00:00.000Z', bytes: 18 } }))
      expect(useMemoryStore.getState().draftContent).toBe('# Saved while reading')
      expect(useMemoryStore.getState().selectedFile?.content).toBe('# Saved while reading')
      expect(useMemoryStore.getState().lastSavedAt).toBe('2026-05-01T00:01:00.000Z')
      expect(useMemoryStore.getState().isLoadingFile).toBe(false)
      expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Saved while reading')
    } finally {
      confirm.mockRestore()
    }
  })

})
