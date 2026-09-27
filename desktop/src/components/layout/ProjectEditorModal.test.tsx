import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'

const nativeDialog = vi.hoisted(() => ({
  isDesktop: false,
  open: vi.fn(),
}))

vi.mock('@/lib/desktopHost', () => ({
  getDesktopHost: () => ({
    isDesktop: nativeDialog.isDesktop,
    capabilities: { dialogs: true },
    dialogs: { open: nativeDialog.open },
  }),
}))

beforeEach(() => {
  nativeDialog.isDesktop = false
  nativeDialog.open.mockReset()
})

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'dirPicker.chooseProjectFolder': 'Choose project folder',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'sidebar.projectEditor.createTitle': 'Create project',
      'sidebar.projectEditor.editTitle': 'Edit project',
      'sidebar.projectEditor.name': 'Project name',
      'sidebar.projectEditor.nameHint': 'Up to {count} characters',
      'sidebar.projectEditor.nameRequired': 'A project name is required.',
      'sidebar.projectEditor.nameTooLong': 'Project names can be at most 80 characters.',
      'sidebar.projectEditor.sourceFolder': 'Source folder',
      'sidebar.projectEditor.sourceFolderRequired': 'Choose a source folder.',
      'sidebar.projectEditor.realPath': 'Real path',
      'sidebar.projectEditor.realPathHint': 'This project path is fixed and cannot be changed here.',
      'sidebar.projectEditor.restoreFolderName': 'Restore folder name',
      'sidebar.projectEditor.removeFromSidebar': 'Remove from sidebar',
      'sidebar.projectEditor.removeFromSidebarHint': 'This only removes the project from the sidebar. Its sessions and files remain unchanged.',
      'sidebar.projectEditor.create': 'Create project',
      'sidebar.projectEditor.actionFailed': 'Could not save the project changes.',
    }
    let value = translations[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(replacement))
    }
    return value
  },
}))

vi.mock('@/components/composite/DirectoryPicker', () => ({
  DirectoryPicker: ({ value, onChange }: { value: string; onChange: (path: string) => void }) => (
    <button type="button" aria-label="Choose source folder" onClick={() => onChange('/workspace/selected  ')}>
      {value || 'Choose source folder'}
    </button>
  ),
}))

import { ProjectEditorModal } from './ProjectEditorModal'

function CreateHarness({
  onSubmit,
  onSourceFolderChange,
}: {
  onSubmit: ReturnType<typeof vi.fn>
  onSourceFolderChange: ReturnType<typeof vi.fn>
}) {
  const [sourceFolder, setSourceFolder] = useState('')

  return (
    <ProjectEditorModal
      open
      mode="create"
      sourceFolder={sourceFolder}
      logicalRoot="/workspace/logical-root  "
      suggestedName="Suggested project"
      onSourceFolderChange={(path) => {
        onSourceFolderChange(path)
        setSourceFolder(path)
      }}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />
  )
}

afterEach(cleanup)

describe('ProjectEditorModal', () => {
  it('opens the native folder dialog directly and preserves the selected path', async () => {
    nativeDialog.isDesktop = true
    nativeDialog.open.mockResolvedValue('/workspace/selected  ')
    const onSourceFolderChange = vi.fn()
    const onSubmit = vi.fn()
    render(<CreateHarness onSubmit={onSubmit} onSourceFolderChange={onSourceFolderChange} />)

    expect(screen.queryByRole('button', { name: 'Choose source folder' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose project folder' }))
    await waitFor(() => expect(onSourceFolderChange).toHaveBeenCalledWith('/workspace/selected  '))
    expect(nativeDialog.open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Choose project folder',
    })
    expect(screen.getByText('/workspace/selected')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('leaves the source unchanged on cancellation and reports dialog failures', async () => {
    nativeDialog.isDesktop = true
    nativeDialog.open.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Dialog unavailable'))
    const onSourceFolderChange = vi.fn()
    render(<CreateHarness onSubmit={vi.fn()} onSourceFolderChange={onSourceFolderChange} />)

    const choose = screen.getByRole('button', { name: 'Choose project folder' })
    fireEvent.click(choose)
    await waitFor(() => expect(choose).not.toBeDisabled())
    expect(onSourceFolderChange).not.toHaveBeenCalled()
    fireEvent.click(choose)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Dialog unavailable'))
    expect(onSourceFolderChange).not.toHaveBeenCalled()
  })

  it('validates normalized names and preserves exact source and logical paths', async () => {
    const onSubmit = vi.fn()
    const onSourceFolderChange = vi.fn()
    render(<CreateHarness onSubmit={onSubmit} onSourceFolderChange={onSourceFolderChange} />)

    const name = screen.getByRole('textbox', { name: /Project name/ })
    expect(name).not.toHaveAttribute('maxlength')

    fireEvent.change(name, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('A project name is required.')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('Choose a source folder.')).toHaveAttribute('role', 'alert')
    expect(document.activeElement).toBe(name)

    fireEvent.click(screen.getByRole('button', { name: 'Choose source folder' }))
    expect(onSourceFolderChange).toHaveBeenCalledWith('/workspace/selected  ')

    fireEvent.change(name, { target: { value: 'x'.repeat(81) } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Project names can be at most 80 characters.')).toHaveAttribute('role', 'alert')

    fireEvent.change(name, { target: { value: '  Client    workspace  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Client workspace',
        sourceFolder: '/workspace/selected  ',
        logicalRoot: '/workspace/logical-root  ',
      })
    })
  })

  it('adopts late suggestions until a user edits the name', async () => {
    const onSubmit = vi.fn()
    const baseProps = {
      open: true as const,
      mode: 'create' as const,
      sourceFolder: '/workspace/checkout',
      onSourceFolderChange: vi.fn(),
      onClose: vi.fn(),
      onSubmit,
    }
    const { rerender } = render(
      <ProjectEditorModal
        {...baseProps}
        suggestedName="checkout"
      />,
    )

    const name = screen.getByRole('textbox', { name: /Project name/ })
    expect(name).toHaveValue('checkout')

    rerender(
      <ProjectEditorModal
        {...baseProps}
        logicalRoot="/workspace/repository"
        suggestedName="repository"
      />,
    )
    await waitFor(() => expect(name).toHaveValue('repository'))

    fireEvent.change(name, { target: { value: 'My custom name' } })
    rerender(
      <ProjectEditorModal
        {...baseProps}
        logicalRoot="/workspace/late-root"
        suggestedName="late-root"
      />,
    )

    await waitFor(() => expect(name).toHaveValue('My custom name'))
  })

  it('does not trim the fallback folder name', () => {
    render(
      <ProjectEditorModal
        open
        mode="create"
        sourceFolder="/workspace/folder  "
        onSourceFolderChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: /Project name/ })).toHaveValue('folder  ')
  })

  it('keeps the real path read-only and delegates edit-only actions', async () => {
    const onSubmit = vi.fn()
    const onRestoreFolderName = vi.fn()
    const onRemoveFromSidebar = vi.fn()
    render(
      <ProjectEditorModal
        open
        mode="edit"
        initialName="Client workspace"
        logicalRoot="/workspace/client"
        suggestedName="client"
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onRestoreFolderName={onRestoreFolderName}
        onRemoveFromSidebar={onRemoveFromSidebar}
      />,
    )

    const path = screen.getByRole('textbox', { name: 'Real path' })
    expect(path).toHaveValue('/workspace/client')
    expect(path).toHaveAttribute('readonly')
    expect(path).toHaveAttribute('aria-readonly', 'true')
    expect(screen.getByText('This only removes the project from the sidebar. Its sessions and files remain unchanged.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restore folder name' }))
    await waitFor(() => expect(onRestoreFolderName).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('textbox', { name: /Project name/ })).toHaveValue('client')

    const removeFromSidebar = screen.getByRole('button', { name: 'Remove from sidebar' })
    expect(removeFromSidebar).toHaveClass('border-[var(--color-error)]')
    fireEvent.click(removeFromSidebar)
    await waitFor(() => expect(onRemoveFromSidebar).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByRole('textbox', { name: /Project name/ }), { target: { value: 'Renamed client' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Renamed client',
        sourceFolder: '/workspace/client',
        logicalRoot: '/workspace/client',
      })
    })
  })

  it('prevents duplicate submissions and dismissals while an action is pending', async () => {
    let resolveSubmit!: () => void
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      resolveSubmit = resolve
    }))
    const onClose = vi.fn()
    render(
      <ProjectEditorModal
        open
        mode="edit"
        initialName="Client workspace"
        logicalRoot="/workspace/client"
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )

    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    fireEvent.click(save)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(save).toHaveAttribute('aria-busy', 'true'))

    const dialog = screen.getByRole('dialog', { name: 'Edit project' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(dialog.previousElementSibling!)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => resolveSubmit())
    await waitFor(() => expect(save).not.toHaveAttribute('aria-busy'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
