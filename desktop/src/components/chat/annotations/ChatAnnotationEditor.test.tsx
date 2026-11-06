// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../../stores/settingsStore'
import { ChatAnnotationEditor } from './ChatAnnotationEditor'

function anchorRect(overrides: Partial<DOMRect> = {}) {
  return {
    left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20,
    x: 100, y: 200, toJSON: () => ({}),
    ...overrides,
  } as DOMRect
}

function renderEditor(props: Partial<Parameters<typeof ChatAnnotationEditor>[0]> = {}) {
  const handlers = {
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  }
  render(
    <ChatAnnotationEditor
      anchorRect={anchorRect()}
      quote="The order is reversed."
      initialNote=""
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

describe('ChatAnnotationEditor', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('shows the quoted span and seeds the note field', () => {
    renderEditor({ initialNote: 'Move this after the user text.' })

    expect(screen.getByRole('dialog', { name: 'Annotation' })).toBeInTheDocument()
    expect(screen.getByText('The order is reversed.')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('What should change here?')).toHaveValue('Move this after the user text.')
  })

  it('saves the edited note on the save shortcut', () => {
    const { onSave } = renderEditor({ initialNote: 'First draft' })

    const field = screen.getByPlaceholderText('What should change here?')
    fireEvent.change(field, { target: { value: '  Move it after the user text.  ' } })
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true })

    expect(onSave).toHaveBeenCalledWith('Move it after the user text.')
  })

  it('saves from the button and trims the note', () => {
    const { onSave } = renderEditor()

    fireEvent.change(screen.getByPlaceholderText('What should change here?'), {
      target: { value: '  Reorder it  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).toHaveBeenCalledWith('Reorder it')
  })

  it('refuses to save a blank note, so an annotation cannot become an empty comment', () => {
    const { onSave } = renderEditor()

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('What should change here?'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).not.toHaveBeenCalled()
  })

  it('offers deletion when editing an existing annotation', () => {
    const { onDelete } = renderEditor({ initialNote: 'Existing note' })

    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('omits deletion when the annotation is being created', () => {
    renderEditor({ onDelete: undefined })

    expect(screen.getByRole('dialog', { name: 'Annotation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete annotation' })).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    const { onClose } = renderEditor()

    fireEvent.keyDown(screen.getByPlaceholderText('What should change here?'), { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the pointer lands outside the popover', () => {
    const { onClose } = renderEditor()

    fireEvent.pointerDown(document.body)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('places the popover below the anchor when there is room', () => {
    renderEditor()

    const dialog = screen.getByRole('dialog', { name: 'Annotation' })
    expect(dialog).toHaveStyle({ top: '228px', left: '100px' })
  })

  it('flips the popover above the anchor when it would overflow the viewport', () => {
    renderEditor({ anchorRect: anchorRect({ top: 660, bottom: 680 }) })

    const dialog = screen.getByRole('dialog', { name: 'Annotation' })
    expect(dialog).toHaveStyle({ top: '476px' })
  })

  it('keeps the popover inside the viewport when the anchor is near the right edge', () => {
    renderEditor({ anchorRect: anchorRect({ left: 980, right: 1010, width: 30 }) })

    const dialog = screen.getByRole('dialog', { name: 'Annotation' })
    expect(dialog).toHaveStyle({ left: '672px' })
  })
})
