import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceChangedFile } from '@/api/sessions'
import { WorkspaceChangesFallback } from '@/components/chat/WorkspaceChangesFallback'
import { workspaceOpen } from '@/lib/workspace/openTarget'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('@/lib/workspace/openTarget', () => ({
  workspaceOpen: { file: vi.fn(), review: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
})

describe('WorkspaceChangesFallback', () => {
  it('opens current workspace file content without attributing changes to a turn or offering undo', () => {
    const files: WorkspaceChangedFile[] = [
      { path: 'src/retained.ts', status: 'modified', additions: 1, deletions: 0 },
    ]
    render(<WorkspaceChangesFallback sessionId="long-session" files={files} />)
    const region = screen.getByRole('region', { name: 'Workspace changed files' })
    expect(within(region).getByText(/may include changes from other turns or outside this conversation/)).toBeInTheDocument()
    const disclosure = within(region).getByRole('button', { name: 'Show 1 changed files' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(within(region).queryByRole('button', { name: 'Open current content of src/retained.ts' })).not.toBeInTheDocument()
    fireEvent.click(disclosure)
    const opener = within(region).getByRole('button', { name: 'Open current content of src/retained.ts' })
    expect(opener).toHaveClass('focus-visible:ring-2')
    fireEvent.click(opener)
    expect(workspaceOpen.file).toHaveBeenCalledWith('long-session', 'src/retained.ts')
    expect(workspaceOpen.review).not.toHaveBeenCalled()
    expect(within(region).getAllByRole('button')).toHaveLength(2)
  })

  it('offers a bounded initial list with access to every verified workspace file', () => {
    const files: WorkspaceChangedFile[] = Array.from({ length: 101 }, (_, index) => ({
      path: `file-${index}.txt`, status: 'added', additions: 1, deletions: 0,
    }))
    render(<WorkspaceChangesFallback sessionId="long-session" files={files} />)
    expect(screen.queryByRole('button', { name: 'Open current content of file-0.txt' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show 101 changed files' }))
    expect(screen.queryByRole('button', { name: 'Open current content of file-100.txt' })).not.toBeInTheDocument()
    const showMore = screen.getByRole('button', { name: 'Show 96 more files' })
    expect(showMore).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(showMore)
    fireEvent.click(screen.getByRole('button', { name: 'Open current content of file-100.txt' }))
    expect(workspaceOpen.file).toHaveBeenCalledWith('long-session', 'file-100.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByRole('button', { name: 'Open current content of file-100.txt' })).not.toBeInTheDocument()
  })

  it('keeps cumulative changes collapsed across later non-editing turns and honors manual disclosure', () => {
    const files: WorkspaceChangedFile[] = [
      { path: 'src/earlier.ts', status: 'modified', additions: 1, deletions: 0 },
    ]
    const { rerender } = render(<WorkspaceChangesFallback sessionId="long-session" files={files} />)
    rerender(<WorkspaceChangesFallback sessionId="long-session" files={[...files]} />)
    expect(screen.queryByRole('button', { name: 'Open current content of src/earlier.ts' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 changed files' }))
    rerender(<WorkspaceChangesFallback sessionId="long-session" files={[...files]} />)
    expect(screen.getByRole('button', { name: 'Open current content of src/earlier.ts' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide changed files' }))
    expect(screen.queryByRole('button', { name: 'Open current content of src/earlier.ts' })).not.toBeInTheDocument()
  })

  it('keeps the budget explanation visible for a verified empty workspace', () => {
    render(<WorkspaceChangesFallback sessionId="long-session" files={[]} />)
    expect(screen.getByText(/too long for turn previews or file undo/)).toBeInTheDocument()
    expect(screen.getByText('No current workspace changes were found.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('announces unavailable evidence without rendering files or rollback actions', () => {
    render(<WorkspaceChangesFallback sessionId="long-session" files={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Current workspace changes could not be verified')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
