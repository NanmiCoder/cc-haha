import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { FileSearchMenu } from './FileSearchMenu'
import { ApiError } from '../../api/client'
import { filesystemApi } from '../../api/filesystem'
import { useSettingsStore } from '../../stores/settingsStore'

vi.mock('../../api/filesystem', () => ({
  filesystemApi: {
    browse: vi.fn(),
    search: vi.fn(),
  },
}))

describe('FileSearchMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('shows an explicit error when directory browsing is denied', async () => {
    vi.mocked(filesystemApi.browse).mockRejectedValueOnce(
      new ApiError(403, { error: 'Access denied: path outside allowed directory' }),
    )

    render(
      <FileSearchMenu
        cwd="/private/tmp"
        onSelect={() => {}}
      />,
    )

    expect(await screen.findByText('Cannot access this directory')).toBeInTheDocument()
    expect(screen.queryByText('No files in this directory')).not.toBeInTheDocument()
  })

  it('renders returned files when browsing succeeds', async () => {
    vi.mocked(filesystemApi.browse).mockResolvedValueOnce({
      currentPath: '/tmp',
      parentPath: '/',
      entries: [
        { name: 'preview.png', path: '/tmp/preview.png', isDirectory: false },
      ],
    })

    render(
      <FileSearchMenu
        cwd="/tmp"
        onSelect={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('preview.png')).toBeInTheDocument()
    })
  })

  it('selects directories from search results and keeps a separate drill-in action', async () => {
    const onSelect = vi.fn()
    const onNavigate = vi.fn()
    vi.mocked(filesystemApi.search).mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'backend',
      entries: [
        { name: 'backend', path: '/repo/backend', relativePath: 'backend', isDirectory: true },
      ],
    })
    vi.mocked(filesystemApi.browse).mockResolvedValueOnce({
      currentPath: '/repo/backend',
      parentPath: '/repo',
      entries: [
        { name: 'src', path: '/repo/backend/src', isDirectory: true },
      ],
    })
    vi.mocked(filesystemApi.browse).mockResolvedValueOnce({
      currentPath: '/repo/backend/src',
      parentPath: '/repo/backend',
      entries: [
        { name: 'commands', path: '/repo/backend/src/commands', isDirectory: true },
      ],
    })

    render(
      <FileSearchMenu
        cwd="/repo"
        filter="backend"
        onSelect={onSelect}
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(await screen.findByText('backend/'))

    expect(onSelect).toHaveBeenCalledWith('/repo/backend', 'backend', true)
    expect(onNavigate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Open folder'))

    expect(onNavigate).toHaveBeenCalledWith('backend/')
    await waitFor(() => {
      expect(filesystemApi.browse).toHaveBeenCalledWith('/repo/backend', { includeFiles: true })
    })

    fireEvent.click(await screen.findByText('src'))
    expect(onSelect).toHaveBeenLastCalledWith('/repo/backend/src', 'backend/src', true)

    fireEvent.click(screen.getByLabelText('Open folder'))
    expect(onNavigate).toHaveBeenLastCalledWith('backend/src/')
    await waitFor(() => {
      expect(filesystemApi.browse).toHaveBeenCalledWith('/repo/backend/src', { includeFiles: true })
    })
  })

  it('passes nested relative file paths when selecting a file', async () => {
    const onSelect = vi.fn()
    vi.mocked(filesystemApi.search).mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'pictactic',
      entries: [
        { name: 'pictactic', path: '/repo/backend/src/pictactic', relativePath: 'backend/src/pictactic', isDirectory: false },
      ],
    })

    render(
      <FileSearchMenu
        cwd="/repo"
        filter="backend/src/pictactic"
        onSelect={onSelect}
      />,
    )

    fireEvent.click(await screen.findByText('backend/src/pictactic'))

    expect(onSelect).toHaveBeenCalledWith('/repo/backend/src/pictactic', 'backend/src/pictactic', false)
  })

  it('renders search results as insertable paths instead of repeated basenames', async () => {
    vi.mocked(filesystemApi.search).mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'src',
      entries: [
        { name: 'src', path: '/repo/src', relativePath: 'src', isDirectory: true },
        { name: 'hooks', path: '/repo/src/hooks', relativePath: 'src/hooks', isDirectory: true },
        { name: 'src', path: '/repo/desktop/src', relativePath: 'desktop/src', isDirectory: true },
      ],
    })

    render(
      <FileSearchMenu
        cwd="/repo"
        filter="src"
        onSelect={() => {}}
      />,
    )

    expect(await screen.findByText('src/')).toBeInTheDocument()
    expect(screen.getByText('src/hooks/')).toBeInTheDocument()
    expect(screen.getByText('desktop/src/')).toBeInTheDocument()
  })

  it('uses the resolved home root for typed folder filters when no workspace is selected', async () => {
    vi.mocked(filesystemApi.search).mockResolvedValueOnce({
      currentPath: '/Users/nanmi',
      parentPath: '/',
      query: 'workspace',
      entries: [
        { name: 'workspace', path: '/Users/nanmi/workspace', relativePath: 'workspace', isDirectory: true },
      ],
    })
    vi.mocked(filesystemApi.browse).mockResolvedValueOnce({
      currentPath: '/Users/nanmi/workspace',
      parentPath: '/Users/nanmi',
      entries: [],
    })

    const { rerender } = render(
      <FileSearchMenu
        cwd=""
        filter="workspace"
        onSelect={() => {}}
      />,
    )

    expect(await screen.findByText('workspace/')).toBeInTheDocument()

    rerender(
      <FileSearchMenu
        cwd=""
        filter="workspace/"
        onSelect={() => {}}
      />,
    )

    await waitFor(() => {
      expect(filesystemApi.browse).toHaveBeenCalledWith('/Users/nanmi/workspace', { includeFiles: true })
    })
  })
})
